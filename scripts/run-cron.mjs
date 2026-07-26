/**
 * Cron tick: dispatch every background job that is due right now.
 *
 * The Partner platform runs seven jobs that carry its money and hygiene
 * (`offline-sweep`, `reservation-recovery`, `order-timeout`,
 * `order-completion-sweep`, `earning-release`, `retention-redaction`,
 * `reconcile`). Each is invoked over HTTP by `POST /api/cron/v1?job=<name>` with
 * the cron bearer secret; the server owns leases, cursors, and crash-safe re-run
 * semantics (task 16.1). Nothing here implements a job.
 *
 * Run this once a minute from ONE scheduler entry. It reads
 * `scripts/lib/cron-schedule.mjs` to decide which jobs are due, so per-job
 * cadence stays in version control and code review instead of an operator's
 * crontab. See the bottom of this file for the exact scheduler snippets.
 *
 * Usage:
 *   node scripts/run-cron.mjs              # dispatch whatever is due now
 *   node scripts/run-cron.mjs --all        # dispatch every job (manual catch-up)
 *   node scripts/run-cron.mjs --job=reconcile [--job=...]   # dispatch specific jobs
 *   node scripts/run-cron.mjs --dry-run    # print the plan, call nothing
 *
 * Environment:
 *   PARTNER_CRON_SECRET   required — the bearer the dispatch route verifies
 *   PARTNER_CRON_BASE_URL optional — defaults to http://127.0.0.1:3001
 *
 * Exit codes: 0 when every dispatched job succeeded, 1 when any failed. A
 * failure of one job never prevents the others from being attempted — a stuck
 * reconciler must not stop earnings from being released.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { CRON_SCHEDULE, dueJobs } from "./lib/cron-schedule.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Per-job HTTP budget. The reconciler pages every tenant, so it gets the most. */
const JOB_TIMEOUT_MS = Object.freeze({ reconcile: 120_000, "retention-redaction": 120_000 });
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Load `.env` only for values the environment has not already supplied, so a
 * systemd unit or container env always wins over the on-disk file.
 */
function loadDotEnv() {
  let raw;
  try {
    raw = readFileSync(path.join(repositoryRoot, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match === null) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function parseArgs(argv) {
  const explicit = [];
  let all = false;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--all") all = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--job=")) explicit.push(arg.slice("--job=".length));
  }
  return { explicit, all, dryRun };
}

/** Resolve the job list for this invocation, validating any explicit names. */
function resolvePlan({ explicit, all }, nowEpochMs) {
  const known = new Set(CRON_SCHEDULE.map((entry) => entry.job));
  if (explicit.length > 0) {
    const unknown = explicit.filter((job) => !known.has(job));
    if (unknown.length > 0) {
      return { error: `unknown job(s): ${unknown.join(", ")}. Known: ${[...known].join(", ")}` };
    }
    return { jobs: explicit };
  }
  if (all) return { jobs: CRON_SCHEDULE.map((entry) => entry.job) };
  return { jobs: dueJobs(nowEpochMs) };
}

/**
 * Whether `baseUrl` addresses this host only. Loopback traffic never leaves the
 * machine, so there is no transport to protect and asserting the
 * already-terminated scheme is honest; for any other host the real scheme must
 * speak for itself.
 */
function isLoopback(baseUrl) {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

/** Dispatch one job. Never throws: a failure is data, so the tick continues. */
async function dispatch(job, { baseUrl, secret, declareForwardedHttps }) {
  const timeoutMs = JOB_TIMEOUT_MS[job] ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl}/api/cron/v1?job=${encodeURIComponent(job)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        // The dispatch route refuses plain HTTP in production. A scheduler on the
        // same host reaches the app over loopback, where TLS protects nothing —
        // the traffic never leaves the machine and the reverse proxy in front is
        // what terminates it. Declare the already-terminated scheme ONLY for
        // loopback; pointed at any other host the real scheme must stand on its
        // own, so a misconfigured remote URL cannot silently ship this secret in
        // clear text while claiming to be encrypted.
        ...(declareForwardedHttps ? { "x-forwarded-proto": "https" } : {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const elapsedMs = Date.now() - startedAt;
    if (!response.ok) {
      // Never echo the response verbatim: keep the operator log free of anything
      // the envelope might carry beyond a safe error code.
      const code = body?.error?.code ?? `HTTP_${response.status}`;
      return { job, ok: false, elapsedMs, detail: code };
    }
    const data = body?.data ?? {};
    return {
      job,
      ok: true,
      elapsedMs,
      status: data.status,
      processed: data.processed,
      drained: data.drained,
    };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const detail = controller.signal.aborted ? `timeout after ${timeoutMs}ms` : String(error?.message ?? error);
    return { job, ok: false, elapsedMs, detail };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  loadDotEnv();

  const { explicit, all, dryRun } = parseArgs(process.argv.slice(2));
  const nowEpochMs = Date.now();
  const plan = resolvePlan({ explicit, all }, nowEpochMs);
  if (plan.error !== undefined) {
    console.error(`cron: ${plan.error}`);
    process.exitCode = 1;
    return;
  }

  const stamp = new Date(nowEpochMs).toISOString();
  if (plan.jobs.length === 0) {
    console.log(`cron ${stamp}: nothing due`);
    return;
  }

  if (dryRun) {
    console.log(`cron ${stamp}: would dispatch ${plan.jobs.join(", ")}`);
    return;
  }

  const secret = process.env.PARTNER_CRON_SECRET;
  if (secret === undefined || secret.length === 0) {
    console.error("cron: PARTNER_CRON_SECRET is required");
    process.exitCode = 1;
    return;
  }
  const baseUrl = (process.env.PARTNER_CRON_BASE_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");
  const loopback = isLoopback(baseUrl);
  // Refuse to put the cron bearer on the wire in clear text: a remote plain-HTTP
  // target would leak the secret to anyone on the path. Loopback is exempt
  // because that traffic never leaves the machine (see `isLoopback`).
  if (!loopback && baseUrl.startsWith("http://")) {
    console.error(
      `cron: refusing to send the cron secret over plain HTTP to ${baseUrl}; use https:// or a loopback address`,
    );
    process.exitCode = 1;
    return;
  }

  // Sequential on purpose: the jobs share one database and several contend on the
  // same rows. Serialising a tick keeps lease contention and connection use
  // predictable, and every job is bounded per run anyway.
  const results = [];
  for (const job of plan.jobs) {
    results.push(await dispatch(job, { baseUrl, secret, declareForwardedHttps: loopback }));
  }

  for (const result of results) {
    if (result.ok) {
      const detail = [
        result.status === undefined ? null : result.status,
        result.processed === undefined ? null : `processed=${result.processed}`,
        result.drained === undefined ? null : `drained=${result.drained}`,
      ].filter((part) => part !== null).join(" ");
      console.log(`cron ${stamp}: ${result.job} ok ${detail} (${result.elapsedMs}ms)`);
    } else {
      console.error(`cron ${stamp}: ${result.job} FAILED ${result.detail} (${result.elapsedMs}ms)`);
    }
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    console.error(`cron ${stamp}: ${failed.length}/${results.length} job(s) failed`);
    process.exitCode = 1;
  }
}

await main();

/*
 * ---------------------------------------------------------------------------
 * Scheduler setup — register exactly ONE minutely entry.
 * ---------------------------------------------------------------------------
 *
 * Linux (crontab -e). Logs go to the journal via `logger` so a failing tick is
 * discoverable; the `--` guards against a path with spaces:
 *
 *   * * * * * cd /srv/kirimkode-partner && /usr/bin/node scripts/run-cron.mjs 2>&1 | /usr/bin/logger -t partner-cron
 *
 * Linux (systemd timer) — preferred, because a failed unit is visible to
 * `systemctl --failed` and does not depend on shell PATH:
 *
 *   # /etc/systemd/system/partner-cron.service
 *   [Unit]
 *   Description=KirimKode Partner cron tick
 *   After=network-online.target
 *   [Service]
 *   Type=oneshot
 *   WorkingDirectory=/srv/kirimkode-partner
 *   ExecStart=/usr/bin/node scripts/run-cron.mjs
 *   # Prefer an environment file over the repo .env for the secret:
 *   EnvironmentFile=/etc/kirimkode/partner-cron.env
 *
 *   # /etc/systemd/system/partner-cron.timer
 *   [Unit]
 *   Description=Run the KirimKode Partner cron tick every minute
 *   [Timer]
 *   OnCalendar=minutely
 *   AccuracySec=5s
 *   Persistent=false
 *   [Install]
 *   WantedBy=timers.target
 *
 *   systemctl enable --now partner-cron.timer
 *
 * Windows (Task Scheduler), for a development host:
 *
 *   schtasks /Create /TN "KirimKode Partner Cron" /SC MINUTE /MO 1 ^
 *     /TR "node C:\path\to\kirimkode-partner\scripts\run-cron.mjs" ^
 *     /RL LIMITED /F
 *
 * Verify the wiring without touching state:
 *   node scripts/run-cron.mjs --dry-run
 *   node scripts/run-cron.mjs --job=reconcile
 */
