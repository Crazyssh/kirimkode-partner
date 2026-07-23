/**
 * `earning-release` batch job (task 16.3).
 *
 * Runs roughly every minute. Each bounded batch resolves a page of `pending`
 * Earnings whose 24h hold has elapsed (`availableAt <= now`) and drives each
 * `pending → available` through the shared task 14.2
 * {@link import("@application/ledger").EarningLifecycleService.releaseHold}
 * command (requirement 13.4). The job owns no financial rule of its own: the
 * command re-checks the hold with its own clock (`decideHoldRelease`), advances
 * the projection with a compare-and-set, and appends the zero-sum
 * `hold-release` ledger event in one transaction.
 *
 * Crash-safety / idempotency (requirements 20.2, 20.5): the release is idempotent
 * by construction — the projection CAS only advances a still-`pending` row and
 * the ledger event carries a unique `eventKey`, so a re-run after a crash finds
 * the earning already `available` and is a deterministic no-op. The job pages by
 * earning `id` so an earning it could not release this batch (e.g. a concurrent
 * payout moved it to `requested`) simply drops out of the next scan, and it
 * resets the cursor once the backlog is drained so the next run scans from the
 * top (new earnings cross their hold boundary over time).
 */
import type { BatchContext, BatchJob, BatchStepResult } from "@application/cron";
import type { ReleaseHoldInput, ReleaseHoldResult } from "@application/ledger";

import { decodeAfterIdCursor, encodeBatchCursor } from "./job-cursor";
import type { Clock, EarningReleaseGateway } from "./ports";

/** The registry name and operation-key namespace for this job. */
export const EARNING_RELEASE_JOB = "earning-release";

/** Default earnings resolved per batch; keeps a single cron tick bounded. */
const DEFAULT_BATCH_SIZE = 100;

/**
 * The shared hold-release command this job depends on — just the `releaseHold`
 * operation of the task 14.2 {@link EarningLifecycleService}.
 */
export interface EarningReleaseCommand {
  releaseHold(input: ReleaseHoldInput): Promise<ReleaseHoldResult>;
}

export interface EarningReleaseJobDeps {
  readonly gateway: EarningReleaseGateway;
  readonly command: EarningReleaseCommand;
  readonly clock: Clock;
  /** Max earnings resolved per batch. Defaults to 100. */
  readonly batchSize?: number;
  /** Max batches per cron invocation (drains a backlog). Defaults to 5. */
  readonly maxBatchesPerRun?: number;
}

export class EarningReleaseJob implements BatchJob {
  readonly name = EARNING_RELEASE_JOB;
  readonly maxBatchesPerRun: number;
  private readonly deps: EarningReleaseJobDeps;
  private readonly batchSize: number;

  constructor(deps: EarningReleaseJobDeps) {
    this.deps = deps;
    this.batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE);
    this.maxBatchesPerRun = Math.max(1, deps.maxBatchesPerRun ?? 5);
  }

  async runBatch(context: BatchContext): Promise<BatchStepResult> {
    const now = context.nowEpochMs;
    const afterId = decodeAfterIdCursor(context.cursor);

    const earnings = await this.deps.gateway.listReleasableEarnings({
      nowEpochMs: now,
      limit: this.batchSize,
      afterId,
    });

    let processed = 0;
    for (const earning of earnings) {
      // The shared command is authoritative and idempotent: it re-checks the
      // hold with its own clock and no-ops if the earning already moved out of
      // `pending`. We count every attempt as processed for cursor progress.
      await this.deps.command.releaseHold({
        partnerId: earning.partnerId,
        earningId: earning.earningId,
      });
      processed += 1;
    }

    const drained = earnings.length < this.batchSize;
    const lastId = earnings.at(-1)?.earningId ?? null;
    return {
      processed,
      nextCursor: encodeBatchCursor(drained, lastId),
      done: drained,
    };
  }
}
