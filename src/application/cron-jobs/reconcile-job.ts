/**
 * `reconcile` batch job (task 16.4).
 *
 * The operational + financial reconciler. Each bounded batch resolves a page of
 * partners (ordered by id) and, for every tenant, loads its financial and
 * operational projection and runs the pure task 16.4
 * {@link reconcilePartner} detector. Every invariant violation it finds — stale
 * online devices, order/number state mismatches, duplicate earning/allocation,
 * ledger imbalance, snapshot/earning and payout/allocation mismatches, and
 * projection-vs-ledger drift (design sections 7 and 10) — is persisted as a
 * `ReconciliationIssue` through the gateway, which dedupes each
 * `(partnerId, type, referenceId)` open issue.
 *
 * The reconciler is strictly read-and-record: it NEVER repairs money. A
 * persisted issue is a durable signal that blocks risky financial operations
 * and drives manual, out-of-band remediation (requirement 20.6). Because the
 * detector is deterministic and the repository dedupes open issues, re-running
 * the job over unchanged state records no new rows — so a crash mid-run and the
 * subsequent lease-recovery re-run are idempotent (requirement 20.2).
 *
 * Resumable cursor: the lease carries `{ afterId: partnerId }`. Each batch
 * continues after the last partner it processed; when a batch drains the
 * backlog (fewer partners than the page size) the run reports `done` and resets
 * the cursor to `null`, so the next run starts a fresh sweep from the top (new
 * state accrues over time). A crash mid-run resumes from the last persisted
 * partner id.
 */
import { MVP_HEARTBEAT_TIMEOUT_SECONDS } from "@domain/task-5-2-device-inventory-pricing";
import { reconcilePartner } from "@domain/task-16-4";
import type { BatchContext, BatchJob, BatchStepResult } from "@application/cron";

import { decodeAfterIdCursor, encodeBatchCursor } from "./job-cursor";
import type { Clock, ReconciliationGateway } from "./ports";

/** The registry name for this job. */
export const RECONCILE_JOB = "reconcile";

/** Default partners scanned per batch; keeps a single cron tick bounded. */
const DEFAULT_BATCH_SIZE = 25;

export interface ReconcileJobDeps {
  readonly gateway: ReconciliationGateway;
  readonly clock: Clock;
  /** Max partners reconciled per batch. Defaults to 25. */
  readonly batchSize?: number;
  /** Max batches per cron invocation (drains a backlog). Defaults to 4. */
  readonly maxBatchesPerRun?: number;
}

export class ReconcileJob implements BatchJob {
  readonly name = RECONCILE_JOB;
  readonly maxBatchesPerRun: number;
  private readonly deps: ReconcileJobDeps;
  private readonly batchSize: number;

  constructor(deps: ReconcileJobDeps) {
    this.deps = deps;
    this.batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE);
    this.maxBatchesPerRun = Math.max(1, deps.maxBatchesPerRun ?? 4);
  }

  async runBatch(context: BatchContext): Promise<BatchStepResult> {
    const now = context.nowEpochMs;
    const timeoutSeconds =
      (await this.deps.gateway.loadHeartbeatTimeoutSeconds()) ??
      MVP_HEARTBEAT_TIMEOUT_SECONDS;
    const heartbeatTimeoutMs = timeoutSeconds * 1000;
    const afterId = decodeAfterIdCursor(context.cursor);

    const partnerIds = await this.deps.gateway.listPartnerIds({
      limit: this.batchSize,
      afterId,
    });

    let processed = 0;
    for (const partnerId of partnerIds) {
      // Hand the batch instant to the projection too: whether a settled order
      // still holds its number (its listening window is open) is a clock
      // question, and judging it on the same `now` the detector uses keeps the
      // whole run consistent.
      const state = await this.deps.gateway.loadPartnerState(partnerId);
      const findings = reconcilePartner({
        ...state,
        nowEpochMs: now,
        heartbeatTimeoutMs,
      });
      // Always record (a no-finding tenant is a cheap no-op) so the dedupe path
      // is exercised uniformly; the gateway skips already-open issues.
      await this.deps.gateway.recordIssues({ partnerId, findings });
      processed += 1;
    }

    const drained = partnerIds.length < this.batchSize;
    const lastId = partnerIds.at(-1) ?? null;
    return {
      processed,
      nextCursor: encodeBatchCursor(drained, lastId),
      done: drained,
    };
  }
}
