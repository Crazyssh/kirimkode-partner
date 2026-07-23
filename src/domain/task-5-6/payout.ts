import type { EarningState } from "./earning";
import {
  assertIdentifier,
  Task56DomainError,
} from "./errors";
import {
  createTransferTransaction,
  type LedgerTransaction,
  payoutLockEventKey,
  payoutPaidEventKey,
  payoutUnlockEventKey,
} from "./ledger";

/** Payout lifecycle statuses (Req 14.3). */
export const PAYOUT_STATUSES = [
  "requested",
  "approved",
  "processing",
  "paid",
  "rejected",
  "failed",
] as const;

export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export type TerminalPayoutStatus = Extract<
  PayoutStatus,
  "paid" | "rejected" | "failed"
>;

/** Minimum payout for private beta MVP: Rp1.000. */
export const PAYOUT_MINIMUM_IDR = 1000;

/** MVP payouts are manual bank transfers only. */
export const PAYOUT_METHOD = "bank_transfer_manual" as const;

export interface PayoutAllocation {
  readonly earningId: string;
  readonly amountIdr: number;
}

export interface PayoutState {
  readonly id: string;
  readonly status: PayoutStatus;
  readonly amountIdr: number;
  readonly allocations: readonly PayoutAllocation[];
  readonly paymentReference: string | null;
}

const TERMINAL_STATUSES: ReadonlySet<PayoutStatus> = new Set([
  "paid",
  "rejected",
  "failed",
]);

export function isTerminalPayoutStatus(
  status: PayoutStatus,
): status is TerminalPayoutStatus {
  return TERMINAL_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Request payout: lock whole selected earnings (Req 14.1, 14.2)
// ---------------------------------------------------------------------------

export interface RequestPayoutInput {
  readonly payoutId: string;
  readonly earnings: readonly EarningState[];
  readonly minimumIdr?: number;
}

export type RequestPayoutDecision =
  | {
      readonly kind: "lock";
      readonly eventKey: string;
      readonly amountIdr: number;
      readonly allocations: readonly PayoutAllocation[];
      /** Each selected earning transitions available -> requested. */
      readonly earningNextStatus: "requested";
      readonly transaction: LedgerTransaction;
    }
  | {
      readonly kind: "reject";
      readonly code:
        | "empty_selection"
        | "duplicate_earning"
        | "earning_not_available"
        | "below_minimum";
    };

/**
 * Requesting a payout locks the WHOLE of each selected available earning
 * (no partial allocation on MVP). All selected earnings move
 * available -> requested and the ledger moves available -> locked atomically.
 */
export function decideRequestPayout(
  input: RequestPayoutInput,
): RequestPayoutDecision {
  assertIdentifier(input.payoutId, "payoutId");
  const minimum = input.minimumIdr ?? PAYOUT_MINIMUM_IDR;

  if (input.earnings.length === 0) {
    return { kind: "reject", code: "empty_selection" };
  }

  const seen = new Set<string>();
  for (const earning of input.earnings) {
    if (seen.has(earning.id)) {
      return { kind: "reject", code: "duplicate_earning" };
    }
    seen.add(earning.id);
    if (earning.status !== "available") {
      return { kind: "reject", code: "earning_not_available" };
    }
  }

  const allocations: PayoutAllocation[] = input.earnings.map((earning) => ({
    earningId: earning.id,
    amountIdr: earning.amountIdr,
  }));
  const amountIdr = allocations.reduce(
    (total, allocation) => total + allocation.amountIdr,
    0,
  );
  if (!Number.isSafeInteger(amountIdr)) {
    throw new Task56DomainError(
      "INVALID_AMOUNT",
      "Total payout amount exceeds safe integer range",
    );
  }
  if (amountIdr < minimum) {
    return { kind: "reject", code: "below_minimum" };
  }

  return {
    kind: "lock",
    eventKey: payoutLockEventKey(input.payoutId),
    amountIdr,
    allocations: Object.freeze(allocations.map((a) => Object.freeze(a))),
    earningNextStatus: "requested",
    transaction: createTransferTransaction({
      eventType: "payout-lock",
      eventKey: payoutLockEventKey(input.payoutId),
      referenceType: "payout",
      referenceId: input.payoutId,
      fromBucket: "partner_available",
      toBucket: "partner_payout_locked",
      amountIdr,
    }),
  };
}

// ---------------------------------------------------------------------------
// Payment reference policy: unique, non-null (Req 14.4)
// ---------------------------------------------------------------------------

export function assertPaymentReferenceAvailable(
  reference: string,
  existingReferences: Iterable<string>,
): string {
  if (typeof reference !== "string" || reference.trim().length === 0) {
    throw new Task56DomainError(
      "MISSING_PAYMENT_REFERENCE",
      "A non-empty payment reference is required to mark a payout paid",
    );
  }
  const normalized = reference.trim();
  for (const existing of existingReferences) {
    if (existing === normalized) {
      throw new Task56DomainError(
        "DUPLICATE_PAYMENT_REFERENCE",
        "Payment reference must be unique across payouts",
      );
    }
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Payout state machine (Req 14.3, 14.4, 14.5)
// ---------------------------------------------------------------------------

export type PayoutCommand =
  | { readonly type: "approve" }
  | { readonly type: "process" }
  | {
      readonly type: "markPaid";
      readonly paymentReference: string;
      readonly paidAt: Date;
      readonly actorRef: string;
    }
  | { readonly type: "reject"; readonly reason: string; readonly actorRef: string }
  | { readonly type: "fail"; readonly reason: string; readonly actorRef: string };

const VALID_SOURCES: Readonly<Record<PayoutStatus, readonly PayoutStatus[]>> = {
  requested: [],
  approved: ["requested"],
  processing: ["approved"],
  paid: ["processing"],
  rejected: ["requested", "approved", "processing"],
  failed: ["requested", "approved", "processing"],
};

function targetStatus(command: PayoutCommand): PayoutStatus {
  switch (command.type) {
    case "approve":
      return "approved";
    case "process":
      return "processing";
    case "markPaid":
      return "paid";
    case "reject":
      return "rejected";
    case "fail":
      return "failed";
  }
}

export interface PayoutTransitionContext {
  readonly nextStatus: PayoutStatus;
  readonly paymentReference?: string;
  readonly paidAt?: Date;
  readonly actorRef?: string;
  readonly reason?: string;
  readonly method?: typeof PAYOUT_METHOD;
}

export type PayoutTransitionDecision =
  | ({
      readonly kind: "apply";
      readonly eventKey: string | null;
      /** Earning status after this transition, when funds move. */
      readonly earningNextStatus: "paid" | "available" | null;
      readonly transaction: LedgerTransaction | null;
    } & PayoutTransitionContext)
  | {
      readonly kind: "no_change";
      readonly reason: "already_in_target_state";
      readonly nextStatus: PayoutStatus;
    }
  | {
      readonly kind: "reject";
      readonly code:
        | "illegal_transition"
        | "terminal_state_conflict"
        | "missing_reason"
        | "missing_payment_reference"
        | "payment_reference_conflict"
        | "invalid_timestamp";
    };

/**
 * Payout state machine:
 *   requested -> approved -> processing -> paid
 *   requested|approved|processing -> rejected|failed (reason required)
 *
 * Ledger/earning effects:
 *   markPaid  : earnings requested -> paid;      locked -> paid
 *   reject/fail: earnings requested -> available; locked -> available (one unlock event)
 * Retrying a terminal transition that already succeeded is a deterministic
 * no-op, so the idempotent unlock only produces a single ledger event (Req 14.5).
 */
export function decidePayoutTransition(
  payout: PayoutState,
  command: PayoutCommand,
): PayoutTransitionDecision {
  const target = targetStatus(command);

  if (payout.status === target) {
    // A markPaid retry on an already-paid payout is only an idempotent no-op
    // when it carries the SAME payment reference. A different reference means a
    // second bank transfer under a new reference, which must be surfaced as a
    // conflict rather than swallowed as success (double-transfer detection).
    if (command.type === "markPaid") {
      const incomingReference = command.paymentReference.trim();
      if (incomingReference.length === 0) {
        return { kind: "reject", code: "missing_payment_reference" };
      }
      if (payout.paymentReference !== incomingReference) {
        return { kind: "reject", code: "payment_reference_conflict" };
      }
    }
    return {
      kind: "no_change",
      reason: "already_in_target_state",
      nextStatus: payout.status,
    };
  }

  if (isTerminalPayoutStatus(payout.status)) {
    return { kind: "reject", code: "terminal_state_conflict" };
  }

  if (!VALID_SOURCES[target].includes(payout.status)) {
    return { kind: "reject", code: "illegal_transition" };
  }

  if (command.type === "reject" || command.type === "fail") {
    if (typeof command.reason !== "string" || command.reason.trim().length === 0) {
      return { kind: "reject", code: "missing_reason" };
    }
    return {
      kind: "apply",
      nextStatus: target,
      actorRef: command.actorRef,
      reason: command.reason,
      eventKey: payoutUnlockEventKey(payout.id),
      earningNextStatus: "available",
      transaction: createTransferTransaction({
        eventType: "payout-unlock",
        eventKey: payoutUnlockEventKey(payout.id),
        referenceType: "payout",
        referenceId: payout.id,
        fromBucket: "partner_payout_locked",
        toBucket: "partner_available",
        amountIdr: payout.amountIdr,
      }),
    };
  }

  if (command.type === "markPaid") {
    if (
      typeof command.paymentReference !== "string" ||
      command.paymentReference.trim().length === 0
    ) {
      return { kind: "reject", code: "missing_payment_reference" };
    }
    if (
      !(command.paidAt instanceof Date) ||
      !Number.isFinite(command.paidAt.getTime())
    ) {
      return { kind: "reject", code: "invalid_timestamp" };
    }
    return {
      kind: "apply",
      nextStatus: target,
      paymentReference: command.paymentReference.trim(),
      paidAt: command.paidAt,
      actorRef: command.actorRef,
      method: PAYOUT_METHOD,
      eventKey: payoutPaidEventKey(payout.id),
      earningNextStatus: "paid",
      transaction: createTransferTransaction({
        eventType: "payout-paid",
        eventKey: payoutPaidEventKey(payout.id),
        referenceType: "payout",
        referenceId: payout.id,
        fromBucket: "partner_payout_locked",
        toBucket: "partner_paid",
        amountIdr: payout.amountIdr,
      }),
    };
  }

  // approve / process: workflow-only transitions with no ledger effect.
  return {
    kind: "apply",
    nextStatus: target,
    eventKey: null,
    earningNextStatus: null,
    transaction: null,
  };
}
