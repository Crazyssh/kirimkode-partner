/**
 * `retention-redaction` batch job (task 16.3).
 *
 * Enforces the design's retention windows (requirements 19.4, 19.5) by walking
 * an ordered list of disposable categories and redacting/pruning each once its
 * window has fully elapsed:
 *
 *  - `sms_raw` — redact raw inbound SMS ciphertext 7 days after `receivedAtServer`.
 *  - `otp` — redact an order's extracted OTP 24h after the order reached a
 *    terminal state (`terminalAt`).
 *  - `heartbeat_metadata` — prune `DeviceHeartbeat` samples after 30 days.
 *  - `security_log` — prune `SecurityEvent` rows after 90 days.
 *  - `rate_limit_counter` — prune `rate_limit_counters` rows whose own
 *    `expiresAt` has passed. This one is not window-configured: the row already
 *    carries the instant it stops counting, so the boundary is `expiresAt <= now`
 *    (see {@link import("./ports").RETENTION_EXPIRY_PASSES}). Without it the
 *    shared rate-limit table would accumulate one dead row per limiter key
 *    forever (requirement 2.7).
 *
 * The protected financial/audit evidence (`audit`, `ledger`, `payout`, retained
 * 7 years) is NEVER touched by this job: those categories are absent from the
 * pass list and, as defence-in-depth, {@link isProtectedEvidence} is asserted
 * before every pass, so retention can never destroy required financial or audit
 * records (requirement 19.5).
 *
 * Resumable cursor: the lease carries a `{ category, afterId }` cursor. Each
 * bounded batch works the current category from `afterId`; when that category
 * drains, the cursor advances to the next category (`afterId` reset); when the
 * last category drains, the run reports `done` and resets the cursor to `null`
 * so the next run starts a fresh sweep. A crash mid-run resumes from the last
 * persisted `{ category, afterId }`.
 *
 * Idempotency (requirement 20.2): each disposal is guarded so a re-run is a
 * no-op — redaction stamps `redactedAt` / nulls the OTP columns (excluded from
 * the next select), and prunes delete rows (which cannot be reselected). The
 * window boundary comes from the pure task 5.7 domain
 * ({@link retentionWindowMs}), the same source of truth {@link decideRetention}
 * uses, so the job never redacts a record before its window elapses.
 */
import {
  DEFAULT_RETENTION_CONFIG,
  isProtectedEvidence,
  retentionWindowMs,
  type RetentionConfig,
} from "@domain/task-5-7";
import type { JobCursor } from "@application/cron";
import type { BatchContext, BatchJob, BatchStepResult } from "@application/cron";

import type {
  Clock,
  RetentionBatchInput,
  RetentionBatchResult,
  RetentionGateway,
  RetentionPass,
} from "./ports";
import { isRetentionExpiryPass, RETENTION_PASSES } from "./ports";

/** The registry name for this job. */
export const RETENTION_REDACTION_JOB = "retention-redaction";

/** Default candidate records disposed of per batch; keeps a cron tick bounded. */
const DEFAULT_BATCH_SIZE = 200;

/**
 * The composite resumable cursor: which category is being processed and where
 * within it. `null` (or an unrecognised shape) means "start a fresh sweep from
 * the first category".
 */
interface RetentionCursor {
  readonly category: RetentionPass;
  readonly afterId: string | null;
}

export interface RetentionRedactionJobDeps {
  readonly gateway: RetentionGateway;
  readonly clock: Clock;
  /** Max records disposed of per batch. Defaults to 200. */
  readonly batchSize?: number;
  /**
   * Max batches per cron invocation. Defaults to 8 so a single tick can walk
   * every category's backlog; the runner stops early on `done` or lease loss.
   */
  readonly maxBatchesPerRun?: number;
}

export class RetentionRedactionJob implements BatchJob {
  readonly name = RETENTION_REDACTION_JOB;
  readonly maxBatchesPerRun: number;
  private readonly deps: RetentionRedactionJobDeps;
  private readonly batchSize: number;

  constructor(deps: RetentionRedactionJobDeps) {
    this.deps = deps;
    this.batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE);
    this.maxBatchesPerRun = Math.max(1, deps.maxBatchesPerRun ?? 8);
  }

  async runBatch(context: BatchContext): Promise<BatchStepResult> {
    const now = context.nowEpochMs;
    const retention =
      (await this.deps.gateway.loadRetentionConfig()) ?? DEFAULT_RETENTION_CONFIG;

    const { index, afterId } = decodeCursor(context.cursor);
    const category = RETENTION_PASSES[index];

    // A self-expiring pass carries its boundary in the row itself, so `now` IS
    // the boundary — there is no configured window to subtract, and such a table
    // can never be protected financial/audit evidence.
    if (!isRetentionExpiryPass(category)) {
      // Defence-in-depth: never let a protected financial/audit category be
      // disposed of, even if the pass list were mis-edited (requirement 19.5).
      if (isProtectedEvidence(category)) {
        return advance(index, 0);
      }
    }

    const olderThanEpochMs = isRetentionExpiryPass(category)
      ? now
      : now - retentionWindowMs(category, retention);
    const input: RetentionBatchInput = {
      olderThanEpochMs,
      nowEpochMs: now,
      limit: this.batchSize,
      afterId,
    };
    const result = await this.runPass(category, input);

    if (!result.drained) {
      // Stay on this category, resume after the last id examined.
      return {
        processed: result.processed,
        nextCursor: { category, afterId: result.lastId } satisfies RetentionCursor,
        done: false,
      };
    }
    return advance(index, result.processed);
  }

  private runPass(
    category: RetentionPass,
    input: RetentionBatchInput,
  ): Promise<RetentionBatchResult> {
    switch (category) {
      case "sms_raw":
        return this.deps.gateway.redactRawSms(input);
      case "otp":
        return this.deps.gateway.redactOtp(input);
      case "heartbeat_metadata":
        return this.deps.gateway.pruneHeartbeatMetadata(input);
      case "security_log":
        return this.deps.gateway.pruneSecurityEvents(input);
      case "rate_limit_counter":
        return this.deps.gateway.pruneExpiredRateLimitCounters(input);
    }
  }
}

/** Resolve the persisted cursor to a `{ index, afterId }` starting point. */
function decodeCursor(cursor: JobCursor): {
  readonly index: number;
  readonly afterId: string | null;
} {
  if (cursor !== null && typeof cursor === "object" && !Array.isArray(cursor)) {
    const raw = cursor as { category?: unknown; afterId?: unknown };
    const index = RETENTION_PASSES.indexOf(raw.category as RetentionPass);
    if (index >= 0) {
      const afterId = typeof raw.afterId === "string" ? raw.afterId : null;
      return { index, afterId };
    }
  }
  return { index: 0, afterId: null };
}

/**
 * Advance to the next category once the current one drained. When the last
 * category drained the sweep is complete: report `done` and reset the cursor so
 * the next run starts fresh from the first category.
 */
function advance(index: number, processed: number): BatchStepResult {
  const next = index + 1;
  if (next < RETENTION_PASSES.length) {
    return {
      processed,
      nextCursor: {
        category: RETENTION_PASSES[next],
        afterId: null,
      } satisfies RetentionCursor,
      done: false,
    };
  }
  return { processed, nextCursor: null, done: true };
}

export type { RetentionConfig };
