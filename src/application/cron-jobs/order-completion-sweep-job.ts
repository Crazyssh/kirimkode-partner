/**
 * `order-completion-sweep` batch job (listening window).
 *
 * Runs roughly every minute alongside the other recovery jobs. A `success` order
 * no longer releases its number when its first OTP is extracted: it keeps holding
 * it while it is *listening* for a repeat code (services routinely resend one),
 * and so the number cannot be resold while a resent SMS for that buyer is still
 * in flight. The hold ends exactly once — either the buyer completes the order,
 * or this job closes the window after `expiresAt`. Without it an abandoned order
 * would hold its number forever.
 *
 * Each bounded batch resolves a page of orders whose listening window has closed
 * (`success`, `completedAt IS NULL`, past `expiresAt`) and drives each through the
 * shared {@link import("@application/orders").OrderTransitionService.complete}
 * command with `trigger: "expiry_sweep"` — the job holds no state rules of its own
 * (requirement 12.5). That command owns the pure release decision
 * ({@link import("@domain/order-listening-window").decideListeningHoldRelease}),
 * the `completedAt` stamp, and the paired number release (`→ available|offline`
 * per the effective device state). The order's status is untouched and no money
 * moves: it already settled as `success`.
 *
 * The batch `now` is passed as the observed instant rather than letting the
 * command re-read the clock, so the expiry check and the release disposition are
 * judged at the same moment for every order in the page.
 *
 * Crash-safety / idempotency (requirements 20.2, 20.5): each order is completed
 * under a deterministic {@link buildJobOperationKey} used as the command's
 * Idempotency-Key, so the effect + idempotency record commit together and a
 * re-run after a crash replays the first result verbatim rather than releasing a
 * number twice. An already-completed order is reported as an idempotent success
 * by the command and drops out of the next scan.
 */
import { buildJobOperationKey } from "@domain/task-16-1/cron-jobs";
import type { BatchContext, BatchJob, BatchStepResult } from "@application/cron";
import type { CompleteCommandInput, CompleteResult } from "@application/orders";

import { decodeAfterIdCursor, encodeBatchCursor } from "./job-cursor";
import type { Clock } from "./ports";

/** The registry name and operation-key namespace for this job. */
export const ORDER_COMPLETION_SWEEP_JOB = "order-completion-sweep";

/** The synthetic method/path bound into the command's idempotency hash. */
const SWEEP_METHOD = "POST";
const SWEEP_PATH = "/internal/cron/order-completion-sweep";
/** The service principal recorded for the job-initiated completion. */
const JOB_PRINCIPAL = "cron:order-completion-sweep";

const DEFAULT_BATCH_SIZE = 100;

/**
 * Read port for the completion sweep. Resolves a bounded, id-ordered page of
 * orders whose listening window has closed, so the job can release each hold
 * through the shared completion command.
 *
 * Declared here beside the job's deps because it is this job's contract alone;
 * infrastructure supplies the Prisma adapter and raw Prisma never leaves it.
 */
export interface OrderCompletionSweepGateway {
  /**
   * Ids of up to `limit` orders that are `success` with `completedAt` unset and
   * whose `expiresAt` is *strictly before* `nowEpochMs`, ordered by `id ASC`
   * after `afterId`.
   *
   * The strict comparison is load-bearing, not a rounding choice. The pure
   * release decision treats the window as inclusive of `expiresAt` (matching the
   * SMS matcher, so a code arriving exactly at the deadline is still delivered)
   * and therefore rejects an `expiry_sweep` observed at `expiresAt` itself. Since
   * this job mints a constant Idempotency-Key per order over a constant payload,
   * such a rejection would be persisted by the idempotency engine and replayed on
   * every later run — the order could never be swept and its number would stay
   * held for good. Selecting only strictly-expired windows keeps every returned
   * row one the command will accept.
   */
  listExpiredListeningOrderIds(input: {
    readonly nowEpochMs: number;
    readonly limit: number;
    readonly afterId: string | null;
  }): Promise<readonly string[]>;
}

/**
 * The shared completion command this job depends on — just the `complete`
 * operation of the task 9.4 {@link import("@application/orders").OrderTransitionService}.
 */
export interface OrderCompletionSweepCommand {
  complete(input: CompleteCommandInput): Promise<CompleteResult>;
}

export interface OrderCompletionSweepJobDeps {
  readonly gateway: OrderCompletionSweepGateway;
  readonly command: OrderCompletionSweepCommand;
  readonly clock: Clock;
  /** Max orders completed per batch. Defaults to 100. */
  readonly batchSize?: number;
  /** Max batches per cron invocation (drains a backlog). Defaults to 5. */
  readonly maxBatchesPerRun?: number;
}

export class OrderCompletionSweepJob implements BatchJob {
  readonly name = ORDER_COMPLETION_SWEEP_JOB;
  readonly maxBatchesPerRun: number;
  private readonly deps: OrderCompletionSweepJobDeps;
  private readonly batchSize: number;

  constructor(deps: OrderCompletionSweepJobDeps) {
    this.deps = deps;
    this.batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE);
    this.maxBatchesPerRun = Math.max(1, deps.maxBatchesPerRun ?? 5);
  }

  async runBatch(context: BatchContext): Promise<BatchStepResult> {
    const now = context.nowEpochMs;
    const afterId = decodeAfterIdCursor(context.cursor);

    const orderIds = await this.deps.gateway.listExpiredListeningOrderIds({
      nowEpochMs: now,
      limit: this.batchSize,
      afterId,
    });

    let processed = 0;
    for (const orderId of orderIds) {
      // A constant key per order is safe across re-runs because the command's
      // idempotency payload is `{orderId, trigger}` and deliberately excludes the
      // observed instant. The sweep re-samples `now` every ~1-minute run, so
      // binding it into the request hash would make each run a different payload
      // under the same key and poison the key with a permanent
      // IDEMPOTENCY_CONFLICT — the hold could then never be released. The instant
      // still drives the expiry check and the release disposition; it is simply
      // not part of the operation's identity.
      await this.deps.command.complete({
        orderId,
        principalId: JOB_PRINCIPAL,
        idempotencyKey: buildJobOperationKey(this.name, orderId),
        method: SWEEP_METHOD,
        path: SWEEP_PATH,
        trigger: "expiry_sweep",
        actorRef: JOB_PRINCIPAL,
        observedAtEpochMs: now,
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
