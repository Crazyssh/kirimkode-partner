import { describe, expect, it } from "vitest";

import { CronLivenessService, type CronLastSeenReader } from "@application/health/cron-liveness-service";
import { CRON_JOB_CADENCE_SECONDS } from "@domain/task-16-5";

import { createCronHealthHandler } from "./cron/route";

const NOW = Date.UTC(2026, 6, 26, 12, 0, 0);
const MINUTE_MS = 60_000;
const URL = "https://partner.test/api/health/cron";

const AUTH_FAILED = Object.freeze({
  status: 401,
  code: "AUTHENTICATION_FAILED",
  message: "Authentication failed.",
  retryable: false,
});

/** A fake lease-store reader; no database, no Prisma. */
function fakeReader(
  jobs: readonly { job: string; lastSeenAtEpochMs: number }[],
  oldestLeaseCreatedAtEpochMs: number | null = NOW - 30 * 24 * 60 * MINUTE_MS,
): CronLastSeenReader {
  return {
    async readLastSeen() {
      return { jobs, oldestLeaseCreatedAtEpochMs };
    },
  };
}

function serviceWith(reader: CronLastSeenReader): CronLivenessService {
  return new CronLivenessService({
    version: "1.2.3",
    reader,
    clock: () => new Date(NOW),
    startedAtEpochMs: NOW - 30 * 24 * 60 * MINUTE_MS,
  });
}

/** Every declared job seen `ageMs` ago. */
function seenAgo(ageMs: number) {
  return Object.keys(CRON_JOB_CADENCE_SECONDS).map((job) => ({
    job,
    lastSeenAtEpochMs: NOW - ageMs,
  }));
}

// **Validates: Requirements 20.1, 20.3, 20.4**
describe("GET /api/health/cron", () => {
  it("returns the full signal to a caller holding the cron bearer secret", async () => {
    const service = serviceWith(fakeReader(seenAgo(MINUTE_MS)));
    const get = createCronHealthHandler({
      authenticate: () => ({ ok: true }),
      liveness: () => service.liveness(),
    });

    const response = await get(new Request(URL, { headers: { "x-request-id": "ops-1" } }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("ops-1");
    expect(body.requestId).toBe("ops-1");
    expect(body.data.status).toBe("healthy");
    expect(body.data.version).toBe("1.2.3");
    expect(body.data.time).toBe(new Date(NOW).toISOString());
    expect(body.data.staleJobs).toEqual([]);
    expect(body.data.jobs).toHaveLength(Object.keys(CRON_JOB_CADENCE_SECONDS).length);
    expect(body.data.jobs[0]).toEqual({
      job: "offline-sweep",
      status: "healthy",
      cadenceMs: 60_000,
      staleAfterMs: 180_000,
      ageMs: MINUTE_MS,
      lastSeenAtEpochMs: NOW - MINUTE_MS,
      reason: expect.stringContaining("within its"),
    });
  });

  it("reports a stalled money-path job as 503 degraded with the job named", async () => {
    const service = serviceWith(
      fakeReader([
        ...seenAgo(MINUTE_MS).filter((entry) => entry.job !== "earning-release"),
        { job: "earning-release", lastSeenAtEpochMs: NOW - 4 * 60 * MINUTE_MS },
      ]),
    );
    const get = createCronHealthHandler({
      authenticate: () => ({ ok: true }),
      liveness: () => service.liveness(),
    });

    const response = await get(new Request(URL));
    const body = await response.json();

    // 503 as well as the body status, so an operator can alert on HTTP alone.
    expect(response.status).toBe(503);
    expect(body.data.status).toBe("degraded");
    expect(body.data.staleJobs).toEqual(["earning-release"]);
    expect(
      body.data.jobs.find((job: { job: string }) => job.job === "earning-release").status,
    ).toBe("stale");
  });

  it("refuses an unauthenticated request and leaks no operational detail", async () => {
    let livenessCalled = false;
    const service = serviceWith(
      fakeReader([{ job: "earning-release", lastSeenAtEpochMs: NOW - 9 * 60 * MINUTE_MS }]),
    );
    const get = createCronHealthHandler({
      // Mirrors the real authenticator's collapse of every failure mode.
      authenticate: () => ({ ok: false, error: AUTH_FAILED }),
      liveness: () => {
        livenessCalled = true;
        return service.liveness();
      },
    });

    const response = await get(new Request(URL));
    const body = await response.json();
    const raw = JSON.stringify(body);

    expect(response.status).toBe(401);
    expect(body).toEqual({
      error: {
        code: "AUTHENTICATION_FAILED",
        message: "Authentication failed.",
        retryable: false,
      },
      requestId: expect.any(String),
    });

    // The signal must not be computed, let alone disclosed, before auth passes:
    // which job stalled and for how long is reconnaissance.
    expect(livenessCalled).toBe(false);
    expect(raw).not.toMatch(
      /earning-release|reconcile|offline-sweep|stale|degraded|ageMs|lastSeen/i,
    );
    expect(raw).not.toMatch(/secret|token|bearer|postgres|password/i);
  });

  it("passes the resolved HTTPS state to the shared cron guard", async () => {
    const seen: boolean[] = [];
    const get = createCronHealthHandler({
      authenticate: (request) => {
        seen.push(request.secure);
        return { ok: false, error: AUTH_FAILED };
      },
      liveness: () => serviceWith(fakeReader([])).liveness(),
    });

    await get(new Request(URL));
    await get(new Request("http://partner.test/api/health/cron"));
    await get(
      new Request("http://partner.test/api/health/cron", {
        headers: { "x-forwarded-proto": "https,http" },
      }),
    );

    expect(seen).toEqual([true, false, true]);
  });

  it("forwards the presented Authorization header verbatim to the guard", async () => {
    const presented: (string | null)[] = [];
    const get = createCronHealthHandler({
      authenticate: (request) => {
        presented.push(request.authorization);
        return { ok: true };
      },
      liveness: () => serviceWith(fakeReader(seenAgo(MINUTE_MS))).liveness(),
    });

    await get(new Request(URL, { headers: { authorization: "Bearer operator-secret" } }));
    await get(new Request(URL));

    expect(presented).toEqual(["Bearer operator-secret", null]);
  });

  it("reports degraded without detail when the lease store cannot be read", async () => {
    const service = serviceWith({
      async readLastSeen(): Promise<never> {
        throw new Error('relation "job_leases" does not exist; host=db.internal');
      },
    });
    const get = createCronHealthHandler({
      authenticate: () => ({ ok: true }),
      liveness: () => service.liveness(),
    });

    const response = await get(new Request(URL));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.data.status).toBe("degraded");
    expect(body.data.jobs).toEqual([]);
    // The driver's message (and the host it names) never reaches the caller.
    expect(JSON.stringify(body)).not.toMatch(/relation|job_leases|db\.internal/i);
  });

  it("stays healthy on a cold lease store, then degrades once the deployment outlives the thresholds", async () => {
    const fresh = new CronLivenessService({
      version: "1.2.3",
      reader: fakeReader([], null),
      clock: () => new Date(NOW),
      startedAtEpochMs: NOW - MINUTE_MS,
    });
    const freshGet = createCronHealthHandler({
      authenticate: () => ({ ok: true }),
      liveness: () => fresh.liveness(),
    });

    const freshResponse = await freshGet(new Request(URL));
    const freshBody = await freshResponse.json();

    expect(freshResponse.status).toBe(200);
    expect(freshBody.data.status).toBe("healthy");
    expect(
      freshBody.data.jobs.every((job: { status: string }) => job.status === "pending_first_run"),
    ).toBe(true);

    // Same empty store, but this deployment has been up for six hours: the
    // scheduler was never wired up.
    const stalled = new CronLivenessService({
      version: "1.2.3",
      reader: fakeReader([], null),
      clock: () => new Date(NOW),
      startedAtEpochMs: NOW - 6 * 60 * MINUTE_MS,
    });
    const stalledGet = createCronHealthHandler({
      authenticate: () => ({ ok: true }),
      liveness: () => stalled.liveness(),
    });

    const stalledResponse = await stalledGet(new Request(URL));
    const stalledBody = await stalledResponse.json();

    expect(stalledResponse.status).toBe(503);
    expect(stalledBody.data.status).toBe("degraded");
    expect(stalledBody.data.staleJobs).toEqual(Object.keys(CRON_JOB_CADENCE_SECONDS));
  });
});
