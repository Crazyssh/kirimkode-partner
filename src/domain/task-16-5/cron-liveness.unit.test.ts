import { describe, expect, it } from "vitest";

import { CRON_SCHEDULE } from "../../../scripts/lib/cron-schedule.mjs";

import {
  CRON_JOB_CADENCE_SECONDS,
  evaluateCronLiveness,
  STALENESS_CADENCE_MULTIPLIER,
  type CronJobLiveness,
  type CronJobLastSeen,
} from "./cron-liveness";

const NOW = Date.UTC(2026, 6, 26, 12, 0, 0);
const MINUTE_MS = 60_000;

/** Every declared job seen just now, i.e. a fully healthy platform. */
function allFresh(nowEpochMs = NOW): CronJobLastSeen[] {
  return Object.keys(CRON_JOB_CADENCE_SECONDS).map((job) => ({
    job,
    lastSeenAtEpochMs: nowEpochMs,
  }));
}

function jobNamed(
  report: { readonly jobs: readonly CronJobLiveness[] },
  job: string,
): CronJobLiveness {
  const found = report.jobs.find((entry) => entry.job === job);
  if (found === undefined) throw new Error(`Report is missing job ${job}`);
  return found;
}

/** The staleness threshold the detector applies to a job, in ms. */
function thresholdMs(job: keyof typeof CRON_JOB_CADENCE_SECONDS): number {
  return CRON_JOB_CADENCE_SECONDS[job] * 1000 * STALENESS_CADENCE_MULTIPLIER;
}

// **Validates: Requirements 20.3**
describe("cron liveness cadence declaration", () => {
  it("declares a cadence for every job the operator schedule dispatches", () => {
    // The operator-facing schedule and this detector's thresholds must describe
    // the same jobs at the same periods, or the signal silently judges a job
    // against a cadence it is not actually run at.
    const fromSchedule = Object.fromEntries(
      CRON_SCHEDULE.map((entry) => [entry.job, entry.everySeconds]),
    );

    expect({ ...CRON_JOB_CADENCE_SECONDS }).toEqual(fromSchedule);
  });

  it("keeps thresholds a strict multiple of cadence so one slow run never alarms", () => {
    expect(STALENESS_CADENCE_MULTIPLIER).toBeGreaterThan(1);

    // A job seen one whole cadence ago (one missed tick) stays healthy.
    const report = evaluateCronLiveness({
      lastSeen: allFresh(NOW - MINUTE_MS),
      nowEpochMs: NOW,
      cronActiveSinceEpochMs: NOW - 30 * 24 * 60 * MINUTE_MS,
    });

    expect(report.status).toBe("healthy");
  });
});

// **Validates: Requirements 20.3**
describe("evaluateCronLiveness", () => {
  it("reports healthy when every job was seen within its threshold", () => {
    const report = evaluateCronLiveness({
      lastSeen: allFresh(),
      nowEpochMs: NOW,
      cronActiveSinceEpochMs: NOW - 7 * 24 * 60 * MINUTE_MS,
    });

    expect(report.status).toBe("healthy");
    expect(report.staleJobs).toEqual([]);
    expect(report.observedAtEpochMs).toBe(NOW);
    expect(report.jobs).toHaveLength(Object.keys(CRON_JOB_CADENCE_SECONDS).length);
    expect(report.jobs.every((job) => job.status === "healthy")).toBe(true);
  });

  it("distinguishes a fresh deployment (pending_first_run) from a job absent for hours (never_run)", () => {
    // Nothing has ever run, and cron has only been active for one minute: a
    // fresh deployment must not scream before the first tick could land.
    const fresh = evaluateCronLiveness({
      lastSeen: [],
      nowEpochMs: NOW,
      cronActiveSinceEpochMs: NOW - MINUTE_MS,
    });

    expect(fresh.status).toBe("healthy");
    expect(fresh.jobs.every((job) => job.status === "pending_first_run")).toBe(true);
    expect(jobNamed(fresh, "earning-release").ageMs).toBeNull();
    expect(jobNamed(fresh, "earning-release").lastSeenAtEpochMs).toBeNull();

    // Same empty lease store, but cron has been active for six hours: every job
    // is now overdue past its own threshold, so this is a real failure.
    const stalled = evaluateCronLiveness({
      lastSeen: [],
      nowEpochMs: NOW,
      cronActiveSinceEpochMs: NOW - 6 * 60 * MINUTE_MS,
    });

    expect(stalled.status).toBe("degraded");
    expect(stalled.jobs.every((job) => job.status === "never_run")).toBe(true);
    expect(stalled.staleJobs).toEqual(Object.keys(CRON_JOB_CADENCE_SECONDS));
  });

  it("escalates a missing job only once cron outlives that job's own threshold", () => {
    // Per-job thresholds must not collapse into one platform-wide grace window.
    // After 10 minutes of cron activity the minutely jobs (3-minute threshold)
    // are overdue, while `earning-release` (15 minutes) and the hourly jobs
    // (3 hours) are legitimately still waiting for their first tick.
    const tenMinutes = evaluateCronLiveness({
      lastSeen: [],
      nowEpochMs: NOW,
      cronActiveSinceEpochMs: NOW - 10 * MINUTE_MS,
    });

    expect(jobNamed(tenMinutes, "offline-sweep").status).toBe("never_run");
    expect(jobNamed(tenMinutes, "order-timeout").status).toBe("never_run");
    expect(jobNamed(tenMinutes, "earning-release").status).toBe("pending_first_run");
    expect(jobNamed(tenMinutes, "reconcile").status).toBe("pending_first_run");
    expect(tenMinutes.status).toBe("degraded");

    // Twenty minutes in, `earning-release` has crossed its own 15-minute
    // threshold while the hourly jobs still have not.
    const twentyMinutes = evaluateCronLiveness({
      lastSeen: [],
      nowEpochMs: NOW,
      cronActiveSinceEpochMs: NOW - 20 * MINUTE_MS,
    });

    expect(jobNamed(twentyMinutes, "earning-release").status).toBe("never_run");
    expect(jobNamed(twentyMinutes, "reconcile").status).toBe("pending_first_run");
    expect(jobNamed(twentyMinutes, "retention-redaction").status).toBe("pending_first_run");
  });

  it("never escalates a missing job when no cron-active anchor is known", () => {
    const report = evaluateCronLiveness({
      lastSeen: [],
      nowEpochMs: NOW,
      cronActiveSinceEpochMs: null,
    });

    expect(report.status).toBe("healthy");
    expect(report.jobs.every((job) => job.status === "pending_first_run")).toBe(true);
  });

  it("treats the threshold boundary itself as healthy and one ms past it as stale", () => {
    const threshold = thresholdMs("offline-sweep");
    const others = allFresh().filter((entry) => entry.job !== "offline-sweep");

    const atBoundary = evaluateCronLiveness({
      lastSeen: [...others, { job: "offline-sweep", lastSeenAtEpochMs: NOW - threshold }],
      nowEpochMs: NOW,
      cronActiveSinceEpochMs: NOW - 24 * 60 * MINUTE_MS,
    });

    expect(jobNamed(atBoundary, "offline-sweep").ageMs).toBe(threshold);
    expect(jobNamed(atBoundary, "offline-sweep").status).toBe("healthy");
    expect(atBoundary.status).toBe("healthy");

    const pastBoundary = evaluateCronLiveness({
      lastSeen: [
        ...others,
        { job: "offline-sweep", lastSeenAtEpochMs: NOW - threshold - 1 },
      ],
      nowEpochMs: NOW,
      cronActiveSinceEpochMs: NOW - 24 * 60 * MINUTE_MS,
    });

    expect(jobNamed(pastBoundary, "offline-sweep").status).toBe("stale");
    expect(pastBoundary.status).toBe("degraded");
    expect(pastBoundary.staleJobs).toEqual(["offline-sweep"]);
  });

  it("reports every stale job when several stop at once, with per-job reasons", () => {
    // The scheduler died 4 hours ago: every job is past its threshold.
    const diedAt = NOW - 4 * 60 * MINUTE_MS;
    const report = evaluateCronLiveness({
      lastSeen: allFresh(diedAt),
      nowEpochMs: NOW,
      cronActiveSinceEpochMs: NOW - 30 * 24 * 60 * MINUTE_MS,
    });

    expect(report.status).toBe("degraded");
    expect(report.staleJobs).toEqual(Object.keys(CRON_JOB_CADENCE_SECONDS));
    expect(report.jobs.every((job) => job.status === "stale")).toBe(true);

    const earningRelease = jobNamed(report, "earning-release");
    expect(earningRelease.ageMs).toBe(4 * 60 * MINUTE_MS);
    expect(earningRelease.staleAfterMs).toBe(thresholdMs("earning-release"));
    expect(earningRelease.reason).toContain("staleness threshold");
  });

  it("reports a partial outage as degraded while healthy jobs stay healthy", () => {
    const report = evaluateCronLiveness({
      lastSeen: [
        ...allFresh().filter((entry) => entry.job !== "earning-release"),
        { job: "earning-release", lastSeenAtEpochMs: NOW - 90 * MINUTE_MS },
      ],
      nowEpochMs: NOW,
      cronActiveSinceEpochMs: NOW - 30 * 24 * 60 * MINUTE_MS,
    });

    expect(report.status).toBe("degraded");
    expect(report.staleJobs).toEqual(["earning-release"]);
    expect(jobNamed(report, "offline-sweep").status).toBe("healthy");
    expect(jobNamed(report, "reconcile").status).toBe("healthy");
  });

  it("surfaces an unknown/extra job without judging it or degrading the signal", () => {
    const report = evaluateCronLiveness({
      lastSeen: [
        ...allFresh(),
        { job: "legacy-sweep", lastSeenAtEpochMs: NOW - 30 * 24 * 60 * MINUTE_MS },
      ],
      nowEpochMs: NOW,
      cronActiveSinceEpochMs: NOW - 30 * 24 * 60 * MINUTE_MS,
    });

    const unknown = jobNamed(report, "legacy-sweep");
    expect(unknown.status).toBe("unknown_job");
    expect(unknown.cadenceMs).toBeNull();
    expect(unknown.staleAfterMs).toBeNull();
    expect(unknown.ageMs).toBe(30 * 24 * 60 * MINUTE_MS);

    // A job with no declared cadence has no defensible threshold, so it must not
    // fabricate an alarm.
    expect(report.status).toBe("healthy");
    expect(report.staleJobs).toEqual([]);
  });

  it("orders declared jobs first and freezes the returned report", () => {
    const report = evaluateCronLiveness({
      lastSeen: [{ job: "legacy-sweep", lastSeenAtEpochMs: NOW }, ...allFresh()],
      nowEpochMs: NOW,
      cronActiveSinceEpochMs: NOW - MINUTE_MS,
    });

    expect(report.jobs.map((job) => job.job)).toEqual([
      ...Object.keys(CRON_JOB_CADENCE_SECONDS),
      "legacy-sweep",
    ]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.jobs)).toBe(true);
    expect(report.jobs.every((job) => Object.isFrozen(job))).toBe(true);
  });

  it("rejects a non-positive staleness multiplier and cadence", () => {
    expect(() =>
      evaluateCronLiveness({
        lastSeen: [],
        nowEpochMs: NOW,
        cronActiveSinceEpochMs: null,
        stalenessMultiplier: 0,
      }),
    ).toThrow(RangeError);

    expect(() =>
      evaluateCronLiveness({
        lastSeen: [],
        nowEpochMs: NOW,
        cronActiveSinceEpochMs: null,
        cadenceSeconds: { "broken-job": 0 },
      }),
    ).toThrow(RangeError);
  });

  it("carries no tenant data or secrets in the report", () => {
    const report = evaluateCronLiveness({
      lastSeen: allFresh(NOW - 10 * 60 * MINUTE_MS),
      nowEpochMs: NOW,
      cronActiveSinceEpochMs: NOW - 30 * 24 * 60 * MINUTE_MS,
    });

    expect(JSON.stringify(report)).not.toMatch(
      /partner|tenant|secret|token|cursor|otp|postgres|password/i,
    );
  });
});
