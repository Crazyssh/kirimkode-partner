import {
  assertIdentifier,
  assertSafeAmount,
  assertValidTimestamp,
} from "./errors";
import {
  createTransferTransaction,
  earningReversalEventKey,
  holdReleaseEventKey,
  type LedgerTransaction,
  orderSuccessEventKey,
} from "./ledger";

/**
 * Earning lifecycle statuses (Req 13.2).
 * pending -> available -> requested -> paid
 *          \-> reversed  /-> reversed (from pending/available only)
 */
export const EARNING_STATUSES = [
  "pending",
  "available",
  "requested",
  "paid",
  "reversed",
] as const;

export type EarningStatus = (typeof EARNING_STATUSES)[number];

/** Default hold period before a pending earning becomes available: 24h. */
export const EARNING_HOLD_PERIOD_MS = 24 * 60 * 60 * 1000;

export interface EarningState {
  readonly id: string;
  readonly orderId: string;
  readonly amountIdr: number;
  readonly status: EarningStatus;
  readonly availableAt: Date;
}

// ---------------------------------------------------------------------------
// Earning on first order success (Req 13.1, 13.7)
// ---------------------------------------------------------------------------

export interface CreateEarningInput {
  readonly earningId: string;
  readonly orderId: string;
  /** Authoritative payout amount taken from the immutable OrderSnapshot. */
  readonly payoutIdr: number;
  readonly succeededAt: Date;
  readonly holdPeriodMs?: number;
  /** True when an Earning already exists for this order (dedupe guard). */
  readonly earningExistsForOrder: boolean;
}

export type CreateEarningDecision =
  | {
      readonly kind: "create";
      readonly eventKey: string;
      readonly earning: EarningState;
      readonly transaction: LedgerTransaction;
    }
  | {
      readonly kind: "no_change";
      readonly reason: "earning_already_exists";
      readonly eventKey: string;
    };

/**
 * The first time an order reaches `success` we create exactly one pending
 * Earning and the matching ledger event (payable -amount, pending +amount).
 * Retries are deduped by orderId, making the operation idempotent (Req 13.7).
 */
export function decideEarningOnSuccess(
  input: CreateEarningInput,
): CreateEarningDecision {
  assertIdentifier(input.orderId, "orderId");
  const eventKey = orderSuccessEventKey(input.orderId);

  if (input.earningExistsForOrder) {
    return { kind: "no_change", reason: "earning_already_exists", eventKey };
  }

  assertIdentifier(input.earningId, "earningId");
  assertSafeAmount(input.payoutIdr, "payoutIdr");
  assertValidTimestamp(input.succeededAt, "succeededAt");

  const holdPeriodMs = input.holdPeriodMs ?? EARNING_HOLD_PERIOD_MS;
  assertSafeAmount(holdPeriodMs, "holdPeriodMs", 0);
  const availableAt = new Date(input.succeededAt.getTime() + holdPeriodMs);

  const transaction = createTransferTransaction({
    eventType: "order-success",
    eventKey,
    referenceType: "order",
    referenceId: input.orderId,
    fromBucket: "platform_partner_payable",
    toBucket: "partner_pending",
    amountIdr: input.payoutIdr,
  });

  return {
    kind: "create",
    eventKey,
    earning: Object.freeze({
      id: input.earningId,
      orderId: input.orderId,
      amountIdr: input.payoutIdr,
      status: "pending",
      availableAt,
    }),
    transaction,
  };
}

// ---------------------------------------------------------------------------
// Hold release: pending -> available (Req 13.4)
// ---------------------------------------------------------------------------

export interface ReleaseHoldInput {
  readonly earning: EarningState;
  readonly now: Date;
  readonly hasActiveDispute: boolean;
}

export type ReleaseHoldDecision =
  | {
      readonly kind: "release";
      readonly eventKey: string;
      readonly nextStatus: "available";
      readonly transaction: LedgerTransaction;
    }
  | { readonly kind: "no_change"; readonly reason: "already_available"; readonly eventKey: string }
  | {
      readonly kind: "reject";
      readonly code: "hold_not_elapsed" | "dispute_active" | "invalid_state";
      readonly eventKey: string;
    };

/**
 * After the 24h hold elapses without a dispute, a pending earning becomes
 * available. Releasing an already-available earning is a deterministic no-op.
 */
export function decideHoldRelease(input: ReleaseHoldInput): ReleaseHoldDecision {
  const { earning, now, hasActiveDispute } = input;
  assertValidTimestamp(now, "now");
  assertValidTimestamp(earning.availableAt, "earning.availableAt");
  const eventKey = holdReleaseEventKey(earning.id);

  if (earning.status === "available") {
    return { kind: "no_change", reason: "already_available", eventKey };
  }
  if (earning.status !== "pending") {
    return { kind: "reject", code: "invalid_state", eventKey };
  }
  if (hasActiveDispute) {
    return { kind: "reject", code: "dispute_active", eventKey };
  }
  if (now.getTime() < earning.availableAt.getTime()) {
    return { kind: "reject", code: "hold_not_elapsed", eventKey };
  }

  return {
    kind: "release",
    eventKey,
    nextStatus: "available",
    transaction: createTransferTransaction({
      eventType: "hold-release",
      eventKey,
      referenceType: "earning",
      referenceId: earning.id,
      fromBucket: "partner_pending",
      toBucket: "partner_available",
      amountIdr: earning.amountIdr,
    }),
  };
}

// ---------------------------------------------------------------------------
// Reversal: pending/available -> reversed (Req 13.5)
// ---------------------------------------------------------------------------

export interface ReverseEarningInput {
  readonly earning: EarningState;
  readonly reason: string;
}

export type ReverseEarningDecision =
  | {
      readonly kind: "reverse";
      readonly eventKey: string;
      readonly nextStatus: "reversed";
      readonly transaction: LedgerTransaction;
    }
  | { readonly kind: "no_change"; readonly reason: "already_reversed"; readonly eventKey: string }
  | {
      readonly kind: "reconciliation_required";
      readonly reason: "paid_earning_manual_reconciliation";
      readonly eventKey: string;
    }
  | {
      readonly kind: "reject";
      readonly code: "invalid_state" | "missing_reason";
      readonly eventKey: string;
    };

/**
 * A valid refund/dispute reversal moves a pending or available earning to
 * reversed and appends a reversing ledger event; the original financial
 * records are never deleted (Req 13.5). A `paid` earning cannot be auto-reversed
 * on MVP and instead becomes a reconciliation issue for manual handling.
 * A `requested` earning is locked inside a payout and must be resolved via the
 * payout before it can be reversed.
 */
export function decideEarningReversal(
  input: ReverseEarningInput,
): ReverseEarningDecision {
  const { earning, reason } = input;
  const eventKey = earningReversalEventKey(earning.id);

  if (earning.status === "reversed") {
    return { kind: "no_change", reason: "already_reversed", eventKey };
  }
  if (earning.status === "paid") {
    return {
      kind: "reconciliation_required",
      reason: "paid_earning_manual_reconciliation",
      eventKey,
    };
  }
  if (earning.status !== "pending" && earning.status !== "available") {
    return { kind: "reject", code: "invalid_state", eventKey };
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return { kind: "reject", code: "missing_reason", eventKey };
  }

  const fromBucket =
    earning.status === "pending" ? "partner_pending" : "partner_available";

  return {
    kind: "reverse",
    eventKey,
    nextStatus: "reversed",
    transaction: createTransferTransaction({
      eventType: "earning-reversal",
      eventKey,
      referenceType: "earning",
      referenceId: earning.id,
      fromBucket,
      toBucket: "partner_reversed",
      amountIdr: earning.amountIdr,
    }),
  };
}
