import { describe, expect, it } from "vitest";

import {
  decideEarningOnSuccess,
  decideEarningReversal,
  decideHoldRelease,
  EARNING_HOLD_PERIOD_MS,
  type EarningState,
} from "./earning";
import { Task56DomainError } from "./errors";
import {
  assertZeroSumEntries,
  computeBalancesFromTransactions,
  computeBucketBalances,
  createLedgerTransaction,
  isLedgerBalanced,
  type LedgerTransaction,
} from "./ledger";
import {
  assertPaymentReferenceAvailable,
  decidePayoutTransition,
  decideRequestPayout,
  PAYOUT_METHOD,
  PAYOUT_MINIMUM_IDR,
  type PayoutState,
} from "./payout";

const SUCCEEDED_AT = new Date("2025-01-01T00:00:00.000Z");

function availableEarning(overrides: Partial<EarningState> = {}): EarningState {
  return {
    id: "earn-1",
    orderId: "order-1",
    amountIdr: 1000,
    status: "available",
    availableAt: SUCCEEDED_AT,
    ...overrides,
  };
}

// **Validates: Requirements 13.6**
describe("ledger zero-sum and bucket balances", () => {
  it("rejects transactions with fewer than two entries", () => {
    expect(() =>
      assertZeroSumEntries([{ bucket: "partner_pending", amountIdrSigned: 0 }]),
    ).toThrowError(Task56DomainError);
  });

  it("rejects transactions whose signed entries do not sum to zero", () => {
    expect(() =>
      createLedgerTransaction({
        eventType: "order-success",
        eventKey: "k",
        referenceType: "order",
        referenceId: "order-1",
        entries: [
          { bucket: "platform_partner_payable", amountIdrSigned: -1000 },
          { bucket: "partner_pending", amountIdrSigned: 999 },
        ],
      }),
    ).toThrowError(/sum to zero/);
  });

  it("accepts a balanced double-entry transaction and derives balances", () => {
    const tx = createLedgerTransaction({
      eventType: "order-success",
      eventKey: "order-success:order-1",
      referenceType: "order",
      referenceId: "order-1",
      entries: [
        { bucket: "platform_partner_payable", amountIdrSigned: -1000 },
        { bucket: "partner_pending", amountIdrSigned: 1000 },
      ],
    });
    const balances = computeBucketBalances([...tx.entries]);
    expect(balances.platform_partner_payable).toBe(-1000);
    expect(balances.partner_pending).toBe(1000);
    expect(isLedgerBalanced(balances)).toBe(true);
  });
});

// **Validates: Requirements 13.1, 13.7**
describe("earning on first order success", () => {
  it("creates exactly one pending earning with payable->pending ledger event", () => {
    const decision = decideEarningOnSuccess({
      earningId: "earn-1",
      orderId: "order-1",
      payoutIdr: 1000,
      succeededAt: SUCCEEDED_AT,
      earningExistsForOrder: false,
    });
    expect(decision.kind).toBe("create");
    if (decision.kind !== "create") return;
    expect(decision.eventKey).toBe("order-success:order-1");
    expect(decision.earning.status).toBe("pending");
    expect(decision.earning.availableAt.getTime()).toBe(
      SUCCEEDED_AT.getTime() + EARNING_HOLD_PERIOD_MS,
    );
    const balances = computeBucketBalances([...decision.transaction.entries]);
    expect(balances.platform_partner_payable).toBe(-1000);
    expect(balances.partner_pending).toBe(1000);
  });

  it("is idempotent: an existing earning for the order is a no-op", () => {
    const decision = decideEarningOnSuccess({
      earningId: "earn-1",
      orderId: "order-1",
      payoutIdr: 1000,
      succeededAt: SUCCEEDED_AT,
      earningExistsForOrder: true,
    });
    expect(decision.kind).toBe("no_change");
    expect(decision.eventKey).toBe("order-success:order-1");
  });

  it("rejects non-positive payout amounts", () => {
    expect(() =>
      decideEarningOnSuccess({
        earningId: "earn-1",
        orderId: "order-1",
        payoutIdr: 0,
        succeededAt: SUCCEEDED_AT,
        earningExistsForOrder: false,
      }),
    ).toThrowError(Task56DomainError);
  });
});

// **Validates: Requirements 13.4**
describe("hold release pending -> available", () => {
  const pending = availableEarning({ status: "pending", availableAt: SUCCEEDED_AT });

  it("releases after the hold elapses without dispute", () => {
    const decision = decideHoldRelease({
      earning: pending,
      now: new Date(SUCCEEDED_AT.getTime() + 1),
      hasActiveDispute: false,
    });
    expect(decision.kind).toBe("release");
    if (decision.kind !== "release") return;
    const balances = computeBucketBalances([...decision.transaction.entries]);
    expect(balances.partner_pending).toBe(-1000);
    expect(balances.partner_available).toBe(1000);
  });

  it("blocks release before the hold elapses", () => {
    const decision = decideHoldRelease({
      earning: pending,
      now: new Date(SUCCEEDED_AT.getTime() - 1),
      hasActiveDispute: false,
    });
    expect(decision).toMatchObject({ kind: "reject", code: "hold_not_elapsed" });
  });

  it("blocks release while a dispute is active", () => {
    const decision = decideHoldRelease({
      earning: pending,
      now: new Date(SUCCEEDED_AT.getTime() + 1),
      hasActiveDispute: true,
    });
    expect(decision).toMatchObject({ kind: "reject", code: "dispute_active" });
  });

  it("is a no-op when already available", () => {
    const decision = decideHoldRelease({
      earning: availableEarning(),
      now: new Date(SUCCEEDED_AT.getTime() + 1),
      hasActiveDispute: false,
    });
    expect(decision.kind).toBe("no_change");
  });
});

// **Validates: Requirements 13.5**
describe("earning reversal", () => {
  it("reverses an available earning into the reversed bucket", () => {
    const decision = decideEarningReversal({
      earning: availableEarning(),
      reason: "buyer refund",
    });
    expect(decision.kind).toBe("reverse");
    if (decision.kind !== "reverse") return;
    const balances = computeBucketBalances([...decision.transaction.entries]);
    expect(balances.partner_available).toBe(-1000);
    expect(balances.partner_reversed).toBe(1000);
  });

  it("reverses a pending earning from the pending bucket", () => {
    const decision = decideEarningReversal({
      earning: availableEarning({ status: "pending" }),
      reason: "dispute",
    });
    expect(decision.kind).toBe("reverse");
    if (decision.kind !== "reverse") return;
    const balances = computeBucketBalances([...decision.transaction.entries]);
    expect(balances.partner_pending).toBe(-1000);
    expect(balances.partner_reversed).toBe(1000);
  });

  it("cannot auto-reverse a paid earning; flags reconciliation", () => {
    const decision = decideEarningReversal({
      earning: availableEarning({ status: "paid" }),
      reason: "dispute",
    });
    expect(decision.kind).toBe("reconciliation_required");
  });

  it("requires a reason", () => {
    const decision = decideEarningReversal({
      earning: availableEarning(),
      reason: "   ",
    });
    expect(decision).toMatchObject({ kind: "reject", code: "missing_reason" });
  });
});

// **Validates: Requirements 14.1, 14.2**
describe("request payout locks whole earnings", () => {
  it("locks all selected available earnings with no partial allocation", () => {
    const decision = decideRequestPayout({
      payoutId: "payout-1",
      earnings: [
        availableEarning({ id: "earn-1", amountIdr: 1000 }),
        availableEarning({ id: "earn-2", amountIdr: 2000 }),
      ],
    });
    expect(decision.kind).toBe("lock");
    if (decision.kind !== "lock") return;
    expect(decision.amountIdr).toBe(3000);
    expect(decision.allocations).toHaveLength(2);
    expect(decision.allocations.map((a) => a.amountIdr)).toEqual([1000, 2000]);
    const balances = computeBucketBalances([...decision.transaction.entries]);
    expect(balances.partner_available).toBe(-3000);
    expect(balances.partner_payout_locked).toBe(3000);
  });

  it("rejects amounts below the minimum payout", () => {
    const decision = decideRequestPayout({
      payoutId: "payout-1",
      earnings: [availableEarning({ amountIdr: PAYOUT_MINIMUM_IDR - 1 })],
    });
    expect(decision).toMatchObject({ kind: "reject", code: "below_minimum" });
  });

  it("rejects when any earning is not available", () => {
    const decision = decideRequestPayout({
      payoutId: "payout-1",
      earnings: [availableEarning({ status: "requested" })],
    });
    expect(decision).toMatchObject({
      kind: "reject",
      code: "earning_not_available",
    });
  });

  it("rejects an empty selection", () => {
    const decision = decideRequestPayout({ payoutId: "payout-1", earnings: [] });
    expect(decision).toMatchObject({ kind: "reject", code: "empty_selection" });
  });
});

// **Validates: Requirements 14.3, 14.4, 14.5**
describe("payout state machine", () => {
  function payout(overrides: Partial<PayoutState> = {}): PayoutState {
    return {
      id: "payout-1",
      status: "requested",
      amountIdr: 1000,
      allocations: [{ earningId: "earn-1", amountIdr: 1000 }],
      paymentReference: null,
      ...overrides,
    };
  }

  it("follows requested->approved->processing->paid", () => {
    expect(decidePayoutTransition(payout(), { type: "approve" })).toMatchObject({
      kind: "apply",
      nextStatus: "approved",
    });
    expect(
      decidePayoutTransition(payout({ status: "approved" }), { type: "process" }),
    ).toMatchObject({ kind: "apply", nextStatus: "processing" });
  });

  it("marks paid with reference/time/actor and locked->paid ledger", () => {
    const decision = decidePayoutTransition(payout({ status: "processing" }), {
      type: "markPaid",
      paymentReference: "TRX-123",
      paidAt: new Date("2025-01-02T00:00:00.000Z"),
      actorRef: "admin-1",
    });
    expect(decision.kind).toBe("apply");
    if (decision.kind !== "apply") return;
    expect(decision.nextStatus).toBe("paid");
    expect(decision.paymentReference).toBe("TRX-123");
    expect(decision.method).toBe(PAYOUT_METHOD);
    expect(decision.earningNextStatus).toBe("paid");
    const balances = computeBucketBalances([...decision.transaction!.entries]);
    expect(balances.partner_payout_locked).toBe(-1000);
    expect(balances.partner_paid).toBe(1000);
  });

  it("rejects markPaid without a payment reference", () => {
    const decision = decidePayoutTransition(payout({ status: "processing" }), {
      type: "markPaid",
      paymentReference: "  ",
      paidAt: new Date(),
      actorRef: "admin-1",
    });
    expect(decision).toMatchObject({
      kind: "reject",
      code: "missing_payment_reference",
    });
  });

  it("unlocks earnings back to available on reject with reason", () => {
    const decision = decidePayoutTransition(payout(), {
      type: "reject",
      reason: "invalid bank account",
      actorRef: "admin-1",
    });
    expect(decision.kind).toBe("apply");
    if (decision.kind !== "apply") return;
    expect(decision.nextStatus).toBe("rejected");
    expect(decision.earningNextStatus).toBe("available");
    const balances = computeBucketBalances([...decision.transaction!.entries]);
    expect(balances.partner_payout_locked).toBe(-1000);
    expect(balances.partner_available).toBe(1000);
  });

  it("requires a reason to fail a payout", () => {
    const decision = decidePayoutTransition(payout(), {
      type: "fail",
      reason: "",
      actorRef: "admin-1",
    });
    expect(decision).toMatchObject({ kind: "reject", code: "missing_reason" });
  });

  it("treats retrying a terminal transition as an idempotent no-op", () => {
    const decision = decidePayoutTransition(payout({ status: "rejected" }), {
      type: "reject",
      reason: "invalid bank account",
      actorRef: "admin-1",
    });
    expect(decision.kind).toBe("no_change");
  });

  it("rejects transitioning out of a different terminal state", () => {
    const decision = decidePayoutTransition(payout({ status: "paid" }), {
      type: "reject",
      reason: "late",
      actorRef: "admin-1",
    });
    expect(decision).toMatchObject({
      kind: "reject",
      code: "terminal_state_conflict",
    });
  });

  it("rejects illegal transitions such as requested->paid", () => {
    const decision = decidePayoutTransition(payout(), {
      type: "markPaid",
      paymentReference: "TRX-1",
      paidAt: new Date(),
      actorRef: "admin-1",
    });
    expect(decision).toMatchObject({ kind: "reject", code: "illegal_transition" });
  });
});

// **Validates: Requirements 14.4**
describe("payment reference policy", () => {
  it("normalizes and accepts a unique reference", () => {
    expect(assertPaymentReferenceAvailable("  TRX-9 ", ["TRX-1"])).toBe("TRX-9");
  });

  it("rejects an empty reference", () => {
    expect(() => assertPaymentReferenceAvailable("", [])).toThrowError(
      Task56DomainError,
    );
  });

  it("rejects a duplicate reference", () => {
    expect(() =>
      assertPaymentReferenceAvailable("TRX-1", ["TRX-1"]),
    ).toThrowError(/unique/);
  });
});

// **Validates: Requirements 13.1, 13.4, 14.1, 14.2, 14.4**
describe("end-to-end zero-sum ledger across a full earning lifecycle", () => {
  it("keeps the whole ledger balanced from success through paid", () => {
    const success = decideEarningOnSuccess({
      earningId: "earn-1",
      orderId: "order-1",
      payoutIdr: 1000,
      succeededAt: SUCCEEDED_AT,
      earningExistsForOrder: false,
    });
    if (success.kind !== "create") throw new Error("expected create");

    const release = decideHoldRelease({
      earning: success.earning,
      now: new Date(success.earning.availableAt.getTime() + 1),
      hasActiveDispute: false,
    });
    if (release.kind !== "release") throw new Error("expected release");

    const lock = decideRequestPayout({
      payoutId: "payout-1",
      earnings: [{ ...success.earning, status: "available" }],
    });
    if (lock.kind !== "lock") throw new Error("expected lock");

    const paid = decidePayoutTransition(
      {
        id: "payout-1",
        status: "processing",
        amountIdr: lock.amountIdr,
        allocations: lock.allocations,
        paymentReference: null,
      },
      {
        type: "markPaid",
        paymentReference: "TRX-1",
        paidAt: new Date(),
        actorRef: "admin-1",
      },
    );
    if (paid.kind !== "apply" || paid.transaction === null) {
      throw new Error("expected paid apply");
    }

    const transactions: LedgerTransaction[] = [
      success.transaction,
      release.transaction,
      lock.transaction,
      paid.transaction,
    ];
    const balances = computeBalancesFromTransactions(transactions);
    expect(isLedgerBalanced(balances)).toBe(true);
    expect(balances.platform_partner_payable).toBe(-1000);
    expect(balances.partner_paid).toBe(1000);
    expect(balances.partner_pending).toBe(0);
    expect(balances.partner_available).toBe(0);
    expect(balances.partner_payout_locked).toBe(0);
  });
});
