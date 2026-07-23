/**
 * Earning hold-release and reversal application service (task 14.2).
 *
 * Two reusable commands that advance an Earning's lifecycle on top of the task
 * 14.1 ledger + projection repositories, keeping every legality rule in the
 * pure task 5.6 domain:
 *
 *  - **`releaseHold` (requirement 13.4).** After the 24h hold elapses without a
 *    dispute, a `pending` Earning becomes `available`. `decideHoldRelease` owns
 *    the rule (hold elapsed, no active dispute, still pending); the service then
 *    advances the projection `pending → available` with a compare-and-set and
 *    appends the zero-sum `hold-release` ledger event (pending → available) in
 *    one transaction. This is the command the earning-release cron (task 16.3)
 *    re-runs, so it must be idempotent: a retry finds the earning already
 *    `available` and is a deterministic no-op.
 *  - **`reverseEarning` (requirements 13.5, 20.6).** A valid refund/dispute
 *    moves a `pending`/`available` Earning to `reversed` and appends a
 *    compensating `earning-reversal` ledger event — the original financial
 *    records are never deleted. `decideEarningReversal` owns the rule, including
 *    the MVP guard that a `paid` Earning is NOT auto-reversed: instead the
 *    service records a ReconciliationIssue for manual handling and moves no
 *    money (requirement 20.6; design section 10).
 *
 * Correctness under concurrency and retry (requirement 20.2, 20.5): the
 * projection advance is a compare-and-set on the *expected* status and runs
 * before the ledger append inside the same transaction, so a stale read can
 * never append a ledger event without the matching projection move — if the
 * earning changed state since it was read, the CAS matches no row, the append
 * is skipped, and the whole unit is a safe no-op. The ledger `eventKey` is
 * additionally unique, making a duplicate append a deterministic no-op on its
 * own.
 */
import {
  decideEarningReversal,
  decideHoldRelease,
  type EarningState,
} from "@domain/task-5-6";

import type {
  EarningProjection,
  EarningProjectionRepository,
  LedgerRepository,
} from "./ports";
import type {
  Clock,
  EarningLifecycleTransactionRunner,
  IdGenerator,
  ReconciliationIssueRepository,
} from "./earning-lifecycle-ports";

/** Input for the reusable hold-release command (task 16.3 cron re-runs this). */
export interface ReleaseHoldInput {
  readonly partnerId: string;
  readonly earningId: string;
  /**
   * Whether a dispute is currently active on the earning. The MVP has no
   * dispute entity — a refund/dispute manifests as a reversal that already
   * moves the earning out of `pending` — so callers leave this `false`; the
   * seam lets a post-MVP dispute tracker block a release without a reversal.
   */
  readonly hasActiveDispute?: boolean;
}

/** The deterministic outcome of a hold-release attempt. */
export type ReleaseHoldResult =
  | { readonly kind: "released"; readonly earningId: string }
  | { readonly kind: "already_available"; readonly earningId: string }
  | { readonly kind: "hold_not_elapsed"; readonly earningId: string }
  | { readonly kind: "dispute_active"; readonly earningId: string }
  | { readonly kind: "invalid_state"; readonly earningId: string }
  | { readonly kind: "state_changed"; readonly earningId: string }
  | { readonly kind: "not_found" };

/** Input for the reversal command driven by a valid refund/dispute. */
export interface ReverseEarningInput {
  readonly partnerId: string;
  readonly earningId: string;
  /** Human-readable, non-sensitive reason retained on the ledger event/issue. */
  readonly reason: string;
}

/** The deterministic outcome of a reversal attempt. */
export type ReverseEarningResult =
  | { readonly kind: "reversed"; readonly earningId: string }
  | { readonly kind: "already_reversed"; readonly earningId: string }
  | {
      readonly kind: "reconciliation_required";
      readonly earningId: string;
      readonly issueId: string;
    }
  | { readonly kind: "invalid_state"; readonly earningId: string }
  | { readonly kind: "missing_reason"; readonly earningId: string }
  | { readonly kind: "state_changed"; readonly earningId: string }
  | { readonly kind: "not_found" };

export interface EarningLifecycleServiceDeps<Tx> {
  readonly runner: EarningLifecycleTransactionRunner<Tx>;
  readonly ledger: LedgerRepository<Tx>;
  readonly earnings: EarningProjectionRepository<Tx>;
  readonly reconciliation: ReconciliationIssueRepository<Tx>;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

/** Rebuild the pure-domain `EarningState` from a persisted projection row. */
function toEarningState(projection: EarningProjection): EarningState {
  return {
    id: projection.id,
    orderId: projection.orderId,
    amountIdr: projection.amountIdr,
    status: projection.status,
    availableAt: new Date(projection.availableAtEpochMs),
  };
}

export class EarningLifecycleService<Tx> {
  private readonly deps: EarningLifecycleServiceDeps<Tx>;

  constructor(deps: EarningLifecycleServiceDeps<Tx>) {
    this.deps = deps;
  }

  /**
   * Release a pending Earning's 24h hold (`pending → available`). Reusable by
   * the earning-release cron (task 16.3). Idempotent: a retry after the release
   * committed finds the earning already `available` and reports it without
   * touching the ledger.
   */
  async releaseHold(input: ReleaseHoldInput): Promise<ReleaseHoldResult> {
    const earning = await this.deps.earnings.findEarningById(
      input.partnerId,
      input.earningId,
    );
    if (earning === null) {
      return { kind: "not_found" };
    }

    const decision = decideHoldRelease({
      earning: toEarningState(earning),
      now: new Date(this.deps.clock.nowEpochMs()),
      hasActiveDispute: input.hasActiveDispute ?? false,
    });

    switch (decision.kind) {
      case "no_change":
        return { kind: "already_available", earningId: input.earningId };
      case "reject":
        return { kind: decision.code, earningId: input.earningId };
      case "release": {
        const applied = await this.deps.runner.run(async (tx) => {
          // Compare-and-set first: only a still-`pending` row is advanced, so a
          // concurrent release/reversal (which moved it out of `pending`) is a
          // no-op and the ledger append below is skipped — a stale read can
          // never append the hold-release event without the matching move.
          const cas = await this.deps.earnings.updateEarningStatus(tx, {
            earningId: input.earningId,
            partnerId: input.partnerId,
            expectedStatus: "pending",
            nextStatus: "available",
          });
          if (cas.outcome === "no_op") {
            return false;
          }
          // The CAS won: append the zero-sum hold-release event in the same
          // unit. Its unique `eventKey` keeps a duplicate a deterministic no-op.
          await this.deps.ledger.appendTransaction(tx, {
            partnerId: input.partnerId,
            transaction: decision.transaction,
          });
          return true;
        });
        return applied
          ? { kind: "released", earningId: input.earningId }
          : { kind: "state_changed", earningId: input.earningId };
      }
    }
  }

  /**
   * Reverse an Earning after a valid refund/dispute (`pending`/`available` →
   * `reversed`) with a compensating ledger event, never deleting the original
   * records. A `paid` Earning is not auto-reversed on MVP: a ReconciliationIssue
   * is recorded for manual handling and no money is moved (requirement 20.6).
   */
  async reverseEarning(
    input: ReverseEarningInput,
  ): Promise<ReverseEarningResult> {
    const earning = await this.deps.earnings.findEarningById(
      input.partnerId,
      input.earningId,
    );
    if (earning === null) {
      return { kind: "not_found" };
    }

    const decision = decideEarningReversal({
      earning: toEarningState(earning),
      reason: input.reason,
    });

    switch (decision.kind) {
      case "no_change":
        return { kind: "already_reversed", earningId: input.earningId };
      case "reject":
        return decision.code === "missing_reason"
          ? { kind: "missing_reason", earningId: input.earningId }
          : { kind: "invalid_state", earningId: input.earningId };
      case "reconciliation_required": {
        // A `paid` Earning cannot be auto-reversed: record a durable issue for
        // manual action instead of silently moving money (requirement 20.6).
        const issueId = await this.recordPaidReversalIssue(earning, input.reason);
        return {
          kind: "reconciliation_required",
          earningId: input.earningId,
          issueId,
        };
      }
      case "reverse": {
        const applied = await this.deps.runner.run(async (tx) => {
          // CAS on the exact status the reversal was decided from, so a
          // concurrent transition (e.g. a hold-release that moved it to
          // `available`, or a payout that moved it to `requested`) is a no-op
          // and the compensating ledger event is not appended against a stale
          // bucket.
          const cas = await this.deps.earnings.updateEarningStatus(tx, {
            earningId: input.earningId,
            partnerId: input.partnerId,
            expectedStatus: earning.status,
            nextStatus: "reversed",
            reversedAtEpochMs: this.deps.clock.nowEpochMs(),
          });
          if (cas.outcome === "no_op") {
            return false;
          }
          await this.deps.ledger.appendTransaction(tx, {
            partnerId: input.partnerId,
            transaction: decision.transaction,
          });
          return true;
        });
        return applied
          ? { kind: "reversed", earningId: input.earningId }
          : { kind: "state_changed", earningId: input.earningId };
      }
    }
  }

  /** Record (or reuse) the ReconciliationIssue for a blocked paid reversal. */
  private async recordPaidReversalIssue(
    earning: EarningProjection,
    reason: string,
  ): Promise<string> {
    const result = await this.deps.runner.run((tx) =>
      this.deps.reconciliation.recordIssue(tx, {
        id: this.deps.idGenerator.uuid(),
        partnerId: earning.partnerId,
        type: "stale_financial_state",
        referenceId: earning.id,
        severity: "high",
        detailsSafeJson: {
          issue: "paid_earning_reversal_blocked",
          earningId: earning.id,
          orderId: earning.orderId,
          amountIdr: earning.amountIdr,
          reason,
        },
      }),
    );
    return result.issueId;
  }
}
