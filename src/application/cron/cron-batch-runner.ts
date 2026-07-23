/**
 * Reusable idempotent bounded batch runner (task 16.1).
 *
 * This is the shared engine that the recovery/retention/reconciliation jobs
 * (tasks 16.2–16.4) plug their batch logic into. A cron trigger hands the
 * runner a {@link BatchJob}; the runner:
 *
 *   1. acquires the job's single DB lease (owner + expiry), or reports
 *      `skipped_locked` when another live worker holds it;
 *   2. reads the resumable cursor carried on the lease;
 *   3. runs up to `maxBatchesPerRun` bounded batches, delegating each to the
 *      job's `runBatch` (which does the `FOR UPDATE SKIP LOCKED` / conditional
 *      update over a bounded set, mints a per-item operation key, and applies
 *      the effect transactionally);
 *   4. after every batch, durably advances the cursor *and* renews the lease in
 *      one conditional statement, so a crash resumes from the advanced position;
 *   5. releases the lease when the run ends.
 *
 * Crash-safety (requirements 20.2, 20.5): if the process dies mid-run the lease
 * is not released, but it expires after `leaseDurationMs`, so the next cron run
 * takes it over and resumes from the last persisted cursor. Because each item
 * carries a deterministic operation key, any item that was applied but not yet
 * reflected in the cursor is reprocessed as a no-op. If a renewal reports the
 * lease was lost (it expired and another worker took over), the runner stops
 * immediately rather than racing the new owner.
 *
 * "Bounded batch" is enforced two ways: the job caps each `runBatch` to its own
 * batch size, and the runner caps the number of batches per invocation
 * (`maxBatchesPerRun`, default 1) so a single cron tick can never run
 * unbounded work.
 */
import type { AcquiredLease, Clock, JobCursor, JobLeaseRepository } from "./ports";

/** The result of processing one bounded batch. */
export interface BatchStepResult {
  /** How many items this batch processed (0 when there was nothing to do). */
  readonly processed: number;
  /** The cursor to persist after this batch (may equal the input cursor). */
  readonly nextCursor: JobCursor;
  /** `true` when there is no more work to do this run (backlog drained). */
  readonly done: boolean;
}

/** Context handed to a job's batch function. */
export interface BatchContext {
  /** The resumable cursor for this batch (from the lease), or `null`. */
  readonly cursor: JobCursor;
  /** Current server time (epoch-ms) sampled just before this batch. */
  readonly nowEpochMs: number;
}

/**
 * A job that the runner can execute. Implementations own the actual bounded
 * `SKIP LOCKED` / conditional-update batch and per-item operation keys; the
 * runner owns the lease lifecycle and cursor durability.
 */
export interface BatchJob {
  /** The lease name; also the operation-key namespace. Unique per job. */
  readonly name: string;
  /**
   * Maximum bounded batches to run per cron invocation. Defaults to 1. The
   * runner stops early when a batch reports `done` or the lease is lost.
   */
  readonly maxBatchesPerRun?: number;
  /** Process one bounded batch, returning progress and the advanced cursor. */
  runBatch(context: BatchContext): Promise<BatchStepResult>;
}

/** The outcome of a runner invocation. */
export type BatchRunResult =
  | { readonly status: "skipped_locked" }
  | {
      readonly status: "completed";
      /** Batches actually run this invocation. */
      readonly batches: number;
      /** Total items processed across those batches. */
      readonly processed: number;
      /** `true` when the backlog was fully drained this run. */
      readonly drained: boolean;
      /** `true` when the run stopped because the lease was lost mid-run. */
      readonly leaseLost: boolean;
    };

export interface CronBatchRunnerDeps {
  readonly leases: JobLeaseRepository;
  readonly clock: Clock;
  /** Mints a unique owner id per invocation (e.g. a random UUID). */
  readonly ownerIdFactory: () => string;
  /**
   * How long an acquired lease is held before it is considered expired
   * (epoch-ms). Must be shorter than the cron interval so a crashed run is
   * reclaimed on the next tick. Defaults to 55s (< the 1-minute cadence).
   */
  readonly leaseDurationMs?: number;
}

const DEFAULT_LEASE_DURATION_MS = 55_000;
const DEFAULT_MAX_BATCHES_PER_RUN = 1;

export class CronBatchRunner {
  private readonly leases: JobLeaseRepository;
  private readonly clock: Clock;
  private readonly ownerIdFactory: () => string;
  private readonly leaseDurationMs: number;

  constructor(deps: CronBatchRunnerDeps) {
    this.leases = deps.leases;
    this.clock = deps.clock;
    this.ownerIdFactory = deps.ownerIdFactory;
    this.leaseDurationMs = deps.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  }

  async run(job: BatchJob): Promise<BatchRunResult> {
    const ownerId = this.ownerIdFactory();
    const acquireNow = this.clock.nowEpochMs();

    const lease = await this.leases.acquire({
      name: job.name,
      ownerId,
      leaseUntilEpochMs: acquireNow + this.leaseDurationMs,
      nowEpochMs: acquireNow,
    });
    // Another live worker holds the lease; skip this tick without contending.
    if (lease === null) {
      return { status: "skipped_locked" };
    }

    try {
      return await this.drain(job, lease);
    } finally {
      // Best-effort release so a healthy run frees the lease immediately for
      // the next tick. A crash before/within here leaves the lease to expire,
      // which is the crash-recovery path.
      await this.leases.release({ name: job.name, ownerId });
    }
  }

  private async drain(job: BatchJob, lease: AcquiredLease): Promise<BatchRunResult> {
    const maxBatches = Math.max(1, job.maxBatchesPerRun ?? DEFAULT_MAX_BATCHES_PER_RUN);
    let cursor: JobCursor = lease.cursor;
    let batches = 0;
    let processed = 0;
    let drained = false;
    let leaseLost = false;

    while (batches < maxBatches) {
      const result = await job.runBatch({ cursor, nowEpochMs: this.clock.nowEpochMs() });
      batches += 1;
      processed += result.processed;
      cursor = result.nextCursor;

      // Durably advance the cursor and renew the lease in one conditional
      // statement. If we no longer own an unexpired lease, another worker has
      // taken over: stop immediately so we never race it.
      const stillOwner = await this.leases.renew({
        name: job.name,
        ownerId: lease.ownerId,
        leaseUntilEpochMs: this.clock.nowEpochMs() + this.leaseDurationMs,
        cursor,
      });
      if (!stillOwner) {
        leaseLost = true;
        break;
      }

      if (result.done) {
        drained = true;
        break;
      }
    }

    return { status: "completed", batches, processed, drained, leaseLost };
  }
}
