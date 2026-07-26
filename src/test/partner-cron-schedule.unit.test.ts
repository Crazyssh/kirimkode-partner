import { describe, expect, it } from "vitest";

import {
  EARNING_RELEASE_JOB,
  OFFLINE_SWEEP_JOB,
  ORDER_COMPLETION_SWEEP_JOB,
  ORDER_TIMEOUT_JOB,
  RECONCILE_JOB,
  RESERVATION_RECOVERY_JOB,
  RETENTION_REDACTION_JOB,
} from "@application/cron-jobs";

import { CRON_SCHEDULE, dueJobs } from "../../scripts/lib/cron-schedule.mjs";

/**
 * The background jobs only run because an external scheduler dispatches them
 * every minute through `scripts/run-cron.mjs`, which reads `CRON_SCHEDULE` to
 * decide what is due. A job that is registered but absent from that schedule
 * therefore NEVER runs in production — and the failure is silent: earnings quietly
 * stop becoming available, held numbers are never released, expired orders are
 * never refunded. Nothing else in the suite catches that, so this file is the
 * guard: adding a job without scheduling it fails here.
 *
 * **Validates: Requirements 20.1, 20.2**
 */
const REGISTERED_JOBS = [
  OFFLINE_SWEEP_JOB,
  RESERVATION_RECOVERY_JOB,
  ORDER_TIMEOUT_JOB,
  ORDER_COMPLETION_SWEEP_JOB,
  EARNING_RELEASE_JOB,
  RETENTION_REDACTION_JOB,
  RECONCILE_JOB,
] as const;

/** Minute-aligned instants, since the scheduler ticks once a minute. */
const MINUTE_MS = 60_000;
const minute = (n: number): number => n * MINUTE_MS;

describe("cron schedule covers every registered job", () => {
  it("schedules exactly the registered jobs, with no orphan entries", () => {
    const scheduled = CRON_SCHEDULE.map((entry) => entry.job).sort();
    expect(scheduled).toEqual([...REGISTERED_JOBS].sort());
  });

  it("gives every job a positive cadence that a minutely tick can hit", () => {
    for (const entry of CRON_SCHEDULE) {
      expect(Number.isInteger(entry.everySeconds)).toBe(true);
      expect(entry.everySeconds).toBeGreaterThan(0);
      // A cadence that is not a whole number of minutes could never be due on a
      // minute-aligned tick, so the job would never run.
      expect(entry.everySeconds % 60).toBe(0);
    }
  });

  it("never schedules a job so rarely that it drifts past a day", () => {
    // A cadence beyond a day would let a stalled invariant sit unexamined for
    // longer than any operator response window.
    for (const entry of CRON_SCHEDULE) {
      expect(entry.everySeconds).toBeLessThanOrEqual(24 * 60 * 60);
    }
  });
});

describe("dueJobs", () => {
  it("runs the minutely jobs on every tick", () => {
    // Epoch minute 1 is not a multiple of 5 or 60, so only the 60s jobs are due.
    expect(dueJobs(minute(1))).toEqual([
      OFFLINE_SWEEP_JOB,
      RESERVATION_RECOVERY_JOB,
      ORDER_TIMEOUT_JOB,
      ORDER_COMPLETION_SWEEP_JOB,
    ]);
  });

  it("adds the slower jobs exactly on their own boundaries", () => {
    expect(dueJobs(minute(5))).toContain(EARNING_RELEASE_JOB);
    expect(dueJobs(minute(4))).not.toContain(EARNING_RELEASE_JOB);

    const hourly = dueJobs(minute(60));
    expect(hourly).toContain(RETENTION_REDACTION_JOB);
    expect(hourly).toContain(RECONCILE_JOB);
    // On the hour every job coincides; that is intentional and bounded, since
    // each run is batch-limited and the tick dispatches them sequentially.
    expect([...hourly].sort()).toEqual([...REGISTERED_JOBS].sort());

    const offHour = dueJobs(minute(59));
    expect(offHour).not.toContain(RECONCILE_JOB);
    expect(offHour).not.toContain(RETENTION_REDACTION_JOB);
  });

  it("is derived purely from the instant, so a restart cannot skip or double-fire", () => {
    // No remembered "last run" state: two schedulers observing the same minute —
    // or the same host after a restart — derive the same plan.
    const at = minute(1_234);
    expect(dueJobs(at)).toEqual(dueJobs(at));
    // Any instant inside the same minute resolves to the same slot.
    expect(dueJobs(at + 59_999)).toEqual(dueJobs(at));
  });

  it("returns nothing for a non-finite or negative instant", () => {
    for (const instant of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(dueJobs(instant)).toEqual([]);
    }
  });

  it("ignores a malformed schedule entry rather than dispatching it", () => {
    const malformed = [
      { job: "zero", everySeconds: 0 },
      { job: "negative", everySeconds: -60 },
      { job: "fractional", everySeconds: 1.5 },
      { job: "good", everySeconds: 60 },
    ];
    expect(dueJobs(minute(7), malformed)).toEqual(["good"]);
  });
});
