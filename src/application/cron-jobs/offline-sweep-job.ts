/**
 * `offline-sweep` batch job (task 16.2).
 *
 * Runs roughly every 30 seconds (design: sweep 30s). Each bounded batch marks
 * every live device whose last heartbeat is older than the 90s heartbeat
 * timeout `online → offline`, then propagates the outage to that device's idle
 * (`available`) numbers, flipping them `available → offline` (requirements 6.2,
 * 6.3). A `reserved`/`busy` number backing an active order is excluded by the
 * query, so the sweep can never relocate an active order (requirement 12.5) —
 * the order keeps waiting until it times out or is cancelled, matching the
 * design's device-offline recovery contract.
 *
 * Crash-safety / idempotency (requirement 20.2): every write is a compare-and-set
 * on the source status inside the batch transaction, so a re-run after a crash
 * (the lease expired mid-batch) simply finds the device already `offline` /
 * numbers already `offline` and does nothing. The job pages by device `id` so a
 * device it could not lock this batch is retried next batch, and resets the
 * cursor once the backlog is drained so the next run scans from the top (a
 * device can go stale again after recovering).
 */
import { MVP_HEARTBEAT_TIMEOUT_SECONDS } from "@domain/task-5-2-device-inventory-pricing";
import type { BatchContext, BatchJob, BatchStepResult } from "@application/cron";

import { decodeAfterIdCursor, encodeBatchCursor } from "./job-cursor";
import type { Clock, IdGenerator, OfflineSweepGateway } from "./ports";

/** The registry name and operation-key namespace for this job. */
export const OFFLINE_SWEEP_JOB = "offline-sweep";

/** Reason recorded on a number's state history when the sweep takes it offline. */
const SWEEP_REASON = "offline_sweep";

/** Default devices scanned per batch; keeps a single cron tick bounded. */
const DEFAULT_BATCH_SIZE = 100;

export interface OfflineSweepJobDeps {
  readonly gateway: OfflineSweepGateway;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  /** Max devices row-locked per batch. Defaults to 100. */
  readonly batchSize?: number;
  /** Max batches per cron invocation (drains a backlog). Defaults to 5. */
  readonly maxBatchesPerRun?: number;
}

export class OfflineSweepJob implements BatchJob {
  readonly name = OFFLINE_SWEEP_JOB;
  readonly maxBatchesPerRun: number;
  private readonly deps: OfflineSweepJobDeps;
  private readonly batchSize: number;

  constructor(deps: OfflineSweepJobDeps) {
    this.deps = deps;
    this.batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE);
    this.maxBatchesPerRun = Math.max(1, deps.maxBatchesPerRun ?? 5);
  }

  async runBatch(context: BatchContext): Promise<BatchStepResult> {
    const now = context.nowEpochMs;
    const timeoutSeconds =
      (await this.deps.gateway.loadHeartbeatTimeoutSeconds()) ??
      MVP_HEARTBEAT_TIMEOUT_SECONDS;
    const timeoutMs = timeoutSeconds * 1000;
    const afterId = decodeAfterIdCursor(context.cursor);

    return this.deps.gateway.runInTransaction(async (tx) => {
      const devices = await tx.lockStaleOnlineDevices({
        nowEpochMs: now,
        timeoutMs,
        limit: this.batchSize,
        afterId,
      });

      let processed = 0;
      for (const device of devices) {
        // Flip the device offline first (compare-and-set on `online`), then
        // propagate the outage to its idle numbers. A concurrent heartbeat that
        // already recovered the device makes the CAS a no-op, and we skip its
        // numbers so we never fight the recovery path.
        const wentOffline = await tx.markDeviceOffline(device.id);
        if (!wentOffline) continue;
        processed += 1;

        const idleNumbers = await tx.listIdleAvailableNumbers(device.id);
        for (const number of idleNumbers) {
          await tx.applyNumberOffline({
            numberId: number.id,
            historyId: this.deps.idGenerator.uuid(),
            actorRef: this.name,
            reason: SWEEP_REASON,
            occurredAtEpochMs: now,
          });
        }
      }

      const drained = devices.length < this.batchSize;
      const lastId = devices.at(-1)?.id ?? null;
      return {
        processed,
        nextCursor: encodeBatchCursor(drained, lastId),
        done: drained,
      };
    });
  }
}
