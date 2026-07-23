/**
 * Pure cron/job foundation domain (task 16.1).
 *
 * The MVP has no message broker: recovery/retention/reconciliation jobs are
 * triggered by an authenticated cron endpoint roughly every minute and each
 * batch is guarded by a database {@link https://www.postgresql.org row lease}.
 * This module holds the *pure* decisions that make that scheme correct and
 * crash-safe (requirements 20.1, 20.2, 20.5):
 *
 *  - {@link decideLeaseTakeover} — when a would-be owner may acquire a job's
 *    single lease. A lease may be taken when it is absent, already owned by the
 *    requester (re-entrancy), or expired. An unexpired lease held by a
 *    *different* owner blocks acquisition, so at most one worker runs a job at
 *    a time and a crashed worker's lease is reclaimed only after it expires.
 *  - {@link nextLeaseUntilEpochMs} — the fresh expiry stamp for an acquire or
 *    renewal.
 *  - {@link buildJobOperationKey} — a deterministic per-item operation key so a
 *    batch that is re-run after a crash reprocesses each item as a no-op
 *    (requirement 20.5). The same `(jobName, itemKey)` always yields the same
 *    key, and different inputs never collide.
 *
 * Everything here is deterministic and free of clock, database, and network
 * access; the surrounding application service supplies the current time and the
 * atomic persistence.
 */

/** The persisted state of a job lease as seen by an acquire attempt. */
export interface JobLeaseSnapshot {
  /** The owner id currently recorded on the lease. */
  readonly ownerId: string;
  /** Epoch-ms instant the current lease expires (exclusive). */
  readonly leaseUntilEpochMs: number;
}

/** Inputs to the takeover decision. */
export interface LeaseTakeoverInput {
  /** The lease as currently persisted, or `null` when no lease row exists. */
  readonly existing: JobLeaseSnapshot | null;
  /** The owner id requesting the lease. */
  readonly requestingOwnerId: string;
  /** Current server time in epoch-ms. */
  readonly nowEpochMs: number;
}

/**
 * Decide whether `requestingOwnerId` may acquire (or re-acquire) the lease.
 *
 * Returns `true` when there is no lease, when the lease is already held by the
 * requester, or when the recorded lease has expired (`leaseUntil <= now`). A
 * live lease held by another owner returns `false`. Expiry uses `<=` so a lease
 * is reclaimable exactly at its expiry instant.
 */
export function decideLeaseTakeover(input: LeaseTakeoverInput): boolean {
  const { existing, requestingOwnerId, nowEpochMs } = input;
  if (existing === null) return true;
  if (existing.ownerId === requestingOwnerId) return true;
  return existing.leaseUntilEpochMs <= nowEpochMs;
}

/**
 * The lease expiry stamp for an acquire/renew: `now + durationMs`. Throws on a
 * non-positive, non-finite duration so a misconfigured job can never mint a
 * lease that is already expired.
 */
export function nextLeaseUntilEpochMs(
  nowEpochMs: number,
  leaseDurationMs: number,
): number {
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new RangeError("Lease duration must be a positive, finite number of milliseconds");
  }
  return nowEpochMs + leaseDurationMs;
}

/**
 * Build the deterministic operation key for one item processed by a job. The
 * key namespaces the item under the job name so two jobs touching the same
 * entity mint distinct keys, and it is stable across retries so a re-run after
 * a crash reprocesses the item idempotently.
 *
 * The `jobName` and `itemKey` are length-prefixed before joining so no pair of
 * distinct inputs can be confused for another (e.g. `("a", "bc")` never
 * collides with `("ab", "c")`).
 */
export function buildJobOperationKey(jobName: string, itemKey: string): string {
  if (jobName.length === 0) {
    throw new RangeError("jobName must not be empty");
  }
  if (itemKey.length === 0) {
    throw new RangeError("itemKey must not be empty");
  }
  return `${jobName.length}:${jobName}:${itemKey.length}:${itemKey}`;
}
