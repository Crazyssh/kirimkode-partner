/**
 * Shared resumable-cursor helpers for the recovery jobs (task 16.2).
 *
 * The recovery jobs page their bounded work by primary-key id. The cursor
 * persisted on the lease between batches is `{ afterId }`, so a batch continues
 * where the previous one stopped. When a batch drains the backlog (fewer rows
 * than the batch size), the cursor is reset to `null` so the *next* run scans
 * from the top again — necessary because these are recurring sweeps whose
 * eligible set changes over time (a recovered device can go stale again, a new
 * order can expire), and ids are random UUIDs rather than monotonic.
 */
import type { JobCursor } from "@application/cron";

/** Read the `afterId` from a persisted cursor, tolerating any legacy shape. */
export function decodeAfterIdCursor(cursor: JobCursor): string | null {
  if (cursor !== null && typeof cursor === "object" && !Array.isArray(cursor)) {
    const afterId = (cursor as { afterId?: unknown }).afterId;
    if (typeof afterId === "string") return afterId;
  }
  return null;
}

/**
 * Build the cursor to persist after a batch: `null` once the backlog is drained
 * (so the next run restarts from the top), otherwise resume after `lastId`.
 */
export function encodeBatchCursor(
  drained: boolean,
  lastId: string | null,
): JobCursor {
  if (drained || lastId === null) return null;
  return { afterId: lastId };
}
