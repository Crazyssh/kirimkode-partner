/**
 * The cron schedule: how often each background job must be dispatched.
 *
 * The jobs are dispatched over HTTP by `POST /api/cron/v1?job=<name>`, driven by
 * an external scheduler (OS cron, systemd timer, Task Scheduler). Rather than
 * spreading seven entries across an operator's crontab — where they drift,
 * silently lose a job, and are invisible to code review — the cadence lives here
 * and `scripts/run-cron.mjs` decides which jobs are due on each tick. The
 * operator then registers exactly ONE minutely entry.
 *
 * `everySeconds` is a lower bound, not a promise: a tick that arrives late runs
 * the job late. Every job is crash-safe and cursor-resumable (task 16.1), so a
 * missed tick delays work rather than losing it.
 *
 * The cadences below are derived from what each job actually gates:
 *
 *  - `offline-sweep` and `reservation-recovery` chase `heartbeatSweepSeconds` /
 *    `reservationRecoverySeconds`, both 30s in the shipped config. A minute is
 *    the finest an OS cron offers, so they run every tick.
 *  - `order-timeout` decides refunds against a 20-minute order expiry; a minute
 *    of lateness is immaterial to the buyer but the job is cheap, so every tick.
 *  - `order-completion-sweep` closes listening windows so held numbers return to
 *    sale. Every tick, for the same reason.
 *  - `earning-release` moves earnings pending -> available after a 24h hold.
 *    Minute-level precision is meaningless against a day-long hold, so a slower
 *    cadence keeps the load down without a partner ever noticing.
 *  - `retention-redaction` enforces retention windows measured in days.
 *  - `reconcile` pages EVERY tenant and reads each one's full financial history,
 *    so it is by far the most expensive. Hourly detection is well inside any
 *    human remediation loop, and the issue store dedupes open findings, so a
 *    faster cadence would only re-derive the same rows.
 *
 * Keep this list in sync with the job registry: `partner-cron.unit.test.ts`
 * fails if a registered job has no schedule entry, so a newly added job cannot
 * silently go unscheduled.
 */

/** One entry per registered job. `everySeconds` must divide evenly by 60. */
export const CRON_SCHEDULE = Object.freeze([
  Object.freeze({ job: "offline-sweep", everySeconds: 60 }),
  Object.freeze({ job: "reservation-recovery", everySeconds: 60 }),
  Object.freeze({ job: "order-timeout", everySeconds: 60 }),
  Object.freeze({ job: "order-completion-sweep", everySeconds: 60 }),
  Object.freeze({ job: "earning-release", everySeconds: 300 }),
  Object.freeze({ job: "retention-redaction", everySeconds: 3_600 }),
  Object.freeze({ job: "reconcile", everySeconds: 3_600 }),
]);

/**
 * Decide which jobs are due at `nowEpochMs`.
 *
 * Dueness is computed from the absolute epoch rather than from a remembered
 * "last run", so the script holds no state and a restart cannot skip or
 * double-fire a job: every scheduler instance observing the same minute derives
 * the same answer. A job is due when the current minute-aligned slot is a
 * multiple of its cadence, which for a minutely tick means "every Nth minute
 * since the epoch" — stable across restarts and across hosts.
 *
 * @param {number} nowEpochMs
 * @param {readonly {job: string, everySeconds: number}[]} [schedule]
 * @returns {readonly string[]} job names to dispatch, in schedule order
 */
export function dueJobs(nowEpochMs, schedule = CRON_SCHEDULE) {
  if (!Number.isFinite(nowEpochMs) || nowEpochMs < 0) return Object.freeze([]);
  const slotSeconds = Math.floor(nowEpochMs / 1000 / 60) * 60;
  return Object.freeze(
    schedule
      .filter((entry) => {
        const period = entry.everySeconds;
        if (!Number.isInteger(period) || period <= 0) return false;
        return slotSeconds % period === 0;
      })
      .map((entry) => entry.job),
  );
}
