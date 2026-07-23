/**
 * `order-timeout` batch job (task 16.2).
 *
 * Runs roughly every minute. Each bounded batch resolves a page of orders past
 * their 20-minute expiry that are still `reserved`/`waiting_sms` (no OTP), and
 * drives each to `timeout` through the shared task 9.4
 * {@link import("@application/orders").OrderTransitionService.timeout} command —
 * the job holds no state-transition rules of its own (requirement 12.5). That
 * command owns the pure state-machine legality (a `success` order is never
 * timed out, the observed instant must have reached expiry), the paired number
 * release (`→ available|offline` per the effective device state), and the
 * transition/number-state history.
 *
 * Crash-safety / idempotency (requirements 20.2, 20.5): each item is timed out
 * under a deterministic {@link buildJobOperationKey} used as the command's
 * Idempotency-Key, so the effect + idempotency record commit together and a
 * re-run after a crash replays the first terminal result verbatim rather than
 * releasing a number twice. An already-terminal order is reported as an
 * idempotent success by the command and simply drops out of the next scan.
 */
import { buildJobOperationKey } from "@domain/task-16-1/cron-jobs";
import type { BatchContext, BatchJob, BatchStepResult } from "@application/cron";
import type { TerminalResult, TimeoutCommandInput } from "@application/orders";

import { decodeAfterIdCursor, encodeBatchCursor } from "./job-cursor";
import type { Clock, OrderTimeoutGateway } from "./ports";

/** The registry name and operation-key namespace for this job. */
export const ORDER_TIMEOUT_JOB = "order-timeout";

/** Terminal reason recorded on a timed-out order. */
const TIMEOUT_REASON = "ORDER_TIMEOUT";
/** The synthetic method/path bound into the command's idempotency hash. */
const TIMEOUT_METHOD = "POST";
const TIMEOUT_PATH = "/internal/cron/order-timeout";
/** The service principal recorded for the job-initiated timeout. */
const JOB_PRINCIPAL = "cron:order-timeout";

const DEFAULT_BATCH_SIZE = 100;

/**
 * The shared terminal-transition command this job depends on — just the
 * `timeout` operation of the task 9.4 {@link OrderTransitionService}.
 */
export interface OrderTimeoutCommand {
  timeout(input: TimeoutCommandInput): Promise<TerminalResult>;
}

export interface OrderTimeoutJobDeps {
  readonly gateway: OrderTimeoutGateway;
  readonly command: OrderTimeoutCommand;
  readonly clock: Clock;
  /** Max orders resolved per batch. Defaults to 100. */
  readonly batchSize?: number;
  /** Max batches per cron invocation (drains a backlog). Defaults to 5. */
  readonly maxBatchesPerRun?: number;
}

export class OrderTimeoutJob implements BatchJob {
  readonly name = ORDER_TIMEOUT_JOB;
  readonly maxBatchesPerRun: number;
  private readonly deps: OrderTimeoutJobDeps;
  private readonly batchSize: number;

  constructor(deps: OrderTimeoutJobDeps) {
    this.deps = deps;
    this.batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE);
    this.maxBatchesPerRun = Math.max(1, deps.maxBatchesPerRun ?? 5);
  }

  async runBatch(context: BatchContext): Promise<BatchStepResult> {
    const now = context.nowEpochMs;
    const afterId = decodeAfterIdCursor(context.cursor);

    const orderIds = await this.deps.gateway.listExpiredOrderIds({
      nowEpochMs: now,
      limit: this.batchSize,
      afterId,
    });

    let processed = 0;
    for (const orderId of orderIds) {
      await this.deps.command.timeout({
        orderId,
        principalId: JOB_PRINCIPAL,
        idempotencyKey: buildJobOperationKey(this.name, orderId),
        method: TIMEOUT_METHOD,
        path: TIMEOUT_PATH,
        observedAtEpochMs: now,
        reason: TIMEOUT_REASON,
      });
      processed += 1;
    }

    const drained = orderIds.length < this.batchSize;
    const lastId = orderIds.at(-1) ?? null;
    return {
      processed,
      nextCursor: encodeBatchCursor(drained, lastId),
      done: drained,
    };
  }
}
