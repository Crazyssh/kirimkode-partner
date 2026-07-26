/**
 * Pure cron liveness (staleness) decision (design section 12; requirement 20.3).
 *
 * The seven background jobs carry the platform's money and its hygiene, but
 * nothing today notices when the *scheduler itself* dies. The reconciler
 * deliberately does not cover this: it detects state inconsistency, not job
 * liveness, so a scheduler that stopped an hour ago looks perfectly consistent
 * right up until the damage is user-visible:
 *
 *  - `earning-release` stopped → partner earnings never leave `pending`, so
 *    nobody can ever cash out.
 *  - `order-completion-sweep` stopped → listening windows never close, so held
 *    numbers are never returned to sale.
 *  - `order-timeout` stopped → expired orders are never refunded to the buyer.
 *
 * This module is the missing signal. Given each job's declared cadence and the
 * instant it was last *seen running*, it decides which jobs are STALE. It is a
 * detector only — it pages nobody and mutates nothing — so it stays a pure,
 * exhaustively testable function in the spirit of {@link evaluateAlertSignals}.
 *
 * ## What "last seen" honestly means
 *
 * The source of truth is the `job_leases` table, whose columns are `ownerId`,
 * `leaseUntil`, `cursorJson`, `createdAt`, and `updatedAt` — there is no
 * `lastSuccessAt` column. `updatedAt` is stamped on every acquire, every renew,
 * and the release that the runner performs in a `finally`, so it means "a runner
 * last *touched* this job", i.e. DISPATCH liveness. It deliberately does not
 * claim success: a job whose batch throws on every tick still releases its lease
 * and therefore still looks alive here. That is the honest limit of the existing
 * schema, and it is exactly the failure this signal is for — a scheduler that
 * stopped dispatching produces no touch at all. Per-batch failure is a different
 * signal (error rate, reconciliation issues), covered elsewhere.
 *
 * ## Thresholds
 *
 * Staleness is a MULTIPLE of each job's own cadence ({@link STALENESS_CADENCE_MULTIPLIER}),
 * never a flat wall-clock constant: a minutely sweep and an hourly reconciler
 * fail on wildly different timescales. The multiple means one slow or skipped
 * tick is not an alarm — a job must miss several consecutive dispatches before
 * it is reported.
 *
 * ## Never-run vs. ran-then-stalled
 *
 * A job with no lease row at all has never run, which is not the same failure as
 * a job that ran and then stopped, and a freshly deployed instance must not
 * scream before the scheduler's first tick could plausibly have landed. So a
 * job with no lease row is `pending_first_run` (healthy) until the platform has
 * been cron-active longer than that job's own threshold, after which it becomes
 * `never_run` (degraded). That keeps a fresh deploy quiet while still catching a
 * scheduler that was never wired up at all.
 *
 * Nothing here carries tenant data or secrets: the report is job names, statuses,
 * ages, and thresholds only. The lease `cursorJson` (which does reference tenant
 * rows) is never an input.
 */

/**
 * How often each registered job must be dispatched, in seconds.
 *
 * This is the single declaration of cadence for the liveness signal, and it
 * mirrors the operator-facing schedule in `scripts/lib/cron-schedule.mjs` that
 * `scripts/run-cron.mjs` dispatches from. `cron-liveness.unit.test.ts` asserts
 * the two never drift, so a cadence change in one place cannot silently leave
 * this detector judging a job against the wrong period.
 *
 * The cadences follow what each job actually gates:
 *
 *  - `offline-sweep`, `reservation-recovery`, `order-timeout`, and
 *    `order-completion-sweep` chase sub-minute config windows or hold a number
 *    out of sale, so they run every minute — the finest an OS cron offers.
 *  - `earning-release` moves earnings `pending → available` after a 24h hold, so
 *    minute-level precision is meaningless; every 5 minutes keeps load down
 *    without a partner ever noticing.
 *  - `retention-redaction` enforces windows measured in days.
 *  - `reconcile` pages every tenant and reads each one's full financial history,
 *    so it is by far the most expensive; hourly is well inside any human
 *    remediation loop.
 */
export const CRON_JOB_CADENCE_SECONDS: Readonly<Record<string, number>> =
  Object.freeze({
    "offline-sweep": 60,
    "reservation-recovery": 60,
    "order-timeout": 60,
    "order-completion-sweep": 60,
    "earning-release": 300,
    "retention-redaction": 3_600,
    reconcile: 3_600,
  });

/**
 * A job is stale once it has not been seen for this many times its cadence.
 *
 * Three is the smallest multiple that tolerates real operational noise — one
 * late tick, one tick lost to a `skipped_locked` contention, one slow run that
 * overran its window — without letting a genuinely dead scheduler hide. At 3×
 * the minutely jobs alarm after 3 minutes and the hourly ones after 3 hours,
 * both comfortably inside the window where the consequences above are still
 * repairable.
 */
export const STALENESS_CADENCE_MULTIPLIER = 3;

/** Per-job liveness verdict. */
export type CronJobLivenessStatus =
  /** Seen within its threshold. */
  | "healthy"
  /** Ran before, but not within `staleAfterMs`. */
  | "stale"
  /** No lease row yet, and the platform has not been cron-active long enough to expect one. */
  | "pending_first_run"
  /** No lease row, and it is now overdue — the job has never run. */
  | "never_run"
  /** A lease exists for a job with no declared cadence; not judged. */
  | "unknown_job";

/** One job's observed liveness, as reported to an operator. */
export interface CronJobLiveness {
  readonly job: string;
  readonly status: CronJobLivenessStatus;
  /** Declared cadence in ms, or `null` for a job with no declared cadence. */
  readonly cadenceMs: number | null;
  /** Threshold the age is judged against in ms, or `null` when not judged. */
  readonly staleAfterMs: number | null;
  /** How long ago the job was last seen running, or `null` when never seen. */
  readonly ageMs: number | null;
  /** Epoch-ms the job was last seen running, or `null` when never seen. */
  readonly lastSeenAtEpochMs: number | null;
  /** Human-readable, secret-free explanation. */
  readonly reason: string;
}

/** The overall signal: `degraded` when any judged job is stale or never-run. */
export type CronLivenessStatus = "healthy" | "degraded";

/** The full liveness report. */
export interface CronLivenessReport {
  readonly status: CronLivenessStatus;
  /** Observation instant the report was derived at (epoch-ms). */
  readonly observedAtEpochMs: number;
  /** Every judged job plus any unknown extras, in a deterministic order. */
  readonly jobs: readonly CronJobLiveness[];
  /** Names of the jobs that made the report `degraded` (empty when healthy). */
  readonly staleJobs: readonly string[];
}

/** One job's last-seen observation, as read from the lease store. */
export interface CronJobLastSeen {
  readonly job: string;
  /** Epoch-ms a runner last touched this job's lease, or `null` if no row. */
  readonly lastSeenAtEpochMs: number | null;
}

export interface CronLivenessInput {
  /** Last-seen observations; jobs absent from this list are treated as no-row. */
  readonly lastSeen: readonly CronJobLastSeen[];
  /** The observation instant (injected, never sampled here). */
  readonly nowEpochMs: number;
  /**
   * Epoch-ms since which cron has plausibly been dispatching — the grace anchor
   * for a job that has no lease row yet. The adapter derives this from the
   * oldest lease row (so it survives redeploys), falling back to process start
   * on a cold database. `null` disables the never-run escalation entirely, so
   * every missing job stays `pending_first_run`.
   */
  readonly cronActiveSinceEpochMs: number | null;
  /** Cadence table; defaults to {@link CRON_JOB_CADENCE_SECONDS}. */
  readonly cadenceSeconds?: Readonly<Record<string, number>>;
  /** Staleness multiple; defaults to {@link STALENESS_CADENCE_MULTIPLIER}. */
  readonly stalenessMultiplier?: number;
}

/** Statuses that make the overall report `degraded`. */
const DEGRADING_STATUSES: ReadonlySet<CronJobLivenessStatus> = new Set<
  CronJobLivenessStatus
>(["stale", "never_run"]);

/** Round to whole ms so a report never carries float noise. */
function wholeMs(value: number): number {
  return Math.round(value);
}

/**
 * Judge one job that has a declared cadence.
 *
 * `ageMs > staleAfterMs` is strict, so a job seen exactly at its threshold is
 * still healthy — the boundary instant belongs to the healthy side, matching the
 * other threshold checks in this module's sibling {@link evaluateAlertSignals}.
 */
function judgeKnownJob(
  job: string,
  lastSeenAtEpochMs: number | null,
  cadenceMs: number,
  staleAfterMs: number,
  nowEpochMs: number,
  cronActiveSinceEpochMs: number | null,
): CronJobLiveness {
  if (lastSeenAtEpochMs === null) {
    // No lease row: never dispatched. Stay quiet until the platform has been
    // cron-active longer than this job's own threshold, so a fresh deployment
    // does not alarm before the first tick could have landed.
    const activeForMs =
      cronActiveSinceEpochMs === null ? null : nowEpochMs - cronActiveSinceEpochMs;
    const overdue = activeForMs !== null && activeForMs > staleAfterMs;

    return Object.freeze({
      job,
      status: overdue ? ("never_run" as const) : ("pending_first_run" as const),
      cadenceMs,
      staleAfterMs,
      ageMs: null,
      lastSeenAtEpochMs: null,
      reason: overdue
        ? `Job has never run: no lease recorded although cron has been active for ${wholeMs(activeForMs)}ms (threshold ${staleAfterMs}ms).`
        : "Job has not run yet; still within the first-run grace window.",
    });
  }

  const ageMs = wholeMs(nowEpochMs - lastSeenAtEpochMs);
  const stale = ageMs > staleAfterMs;

  return Object.freeze({
    job,
    status: stale ? ("stale" as const) : ("healthy" as const),
    cadenceMs,
    staleAfterMs,
    ageMs,
    lastSeenAtEpochMs,
    reason: stale
      ? `Job last ran ${ageMs}ms ago, over its ${staleAfterMs}ms staleness threshold (cadence ${cadenceMs}ms).`
      : `Job last ran ${ageMs}ms ago, within its ${staleAfterMs}ms staleness threshold.`,
  });
}

/**
 * Evaluate cron liveness across every declared job.
 *
 * Jobs are reported in the cadence table's declaration order, followed by any
 * observed job that has no declared cadence (a job removed from the registry, or
 * a lease written by a newer deployment). An unknown job is reported as
 * `unknown_job` and never degrades the signal: without a cadence there is no
 * defensible threshold to judge it against, so alarming would be a false
 * positive.
 */
export function evaluateCronLiveness(
  input: CronLivenessInput,
): CronLivenessReport {
  const cadenceSeconds = input.cadenceSeconds ?? CRON_JOB_CADENCE_SECONDS;
  const multiplier = input.stalenessMultiplier ?? STALENESS_CADENCE_MULTIPLIER;
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new RangeError("Staleness multiplier must be a positive, finite number");
  }

  // Last-seen by job name. A later duplicate wins deterministically; the lease
  // table's unique `name` means production never produces one.
  const observed = new Map<string, number | null>();
  for (const entry of input.lastSeen) {
    observed.set(entry.job, entry.lastSeenAtEpochMs);
  }

  const jobs: CronJobLiveness[] = [];

  for (const [job, seconds] of Object.entries(cadenceSeconds)) {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new RangeError(`Cadence for job "${job}" must be a positive, finite number of seconds`);
    }
    const cadenceMs = seconds * 1000;
    jobs.push(
      judgeKnownJob(
        job,
        observed.get(job) ?? null,
        cadenceMs,
        cadenceMs * multiplier,
        input.nowEpochMs,
        input.cronActiveSinceEpochMs,
      ),
    );
  }

  // Any observed job with no declared cadence: surfaced, never judged.
  for (const [job, lastSeenAtEpochMs] of observed) {
    if (Object.hasOwn(cadenceSeconds, job)) continue;
    jobs.push(
      Object.freeze({
        job,
        status: "unknown_job" as const,
        cadenceMs: null,
        staleAfterMs: null,
        ageMs:
          lastSeenAtEpochMs === null ? null : wholeMs(input.nowEpochMs - lastSeenAtEpochMs),
        lastSeenAtEpochMs,
        reason: "No cadence is declared for this job, so its liveness is not judged.",
      }),
    );
  }

  const staleJobs = jobs
    .filter((entry) => DEGRADING_STATUSES.has(entry.status))
    .map((entry) => entry.job);

  return Object.freeze({
    status: staleJobs.length > 0 ? ("degraded" as const) : ("healthy" as const),
    observedAtEpochMs: input.nowEpochMs,
    jobs: Object.freeze(jobs),
    staleJobs: Object.freeze(staleJobs),
  });
}
