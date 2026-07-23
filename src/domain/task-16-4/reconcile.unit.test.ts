import { describe, expect, it } from "vitest";

import {
  reconcilePartner,
  type PersistedFinding,
  type ReconcilePartnerInput,
  type ReconciliationLedgerTransaction,
} from "./reconcile";

const NOW = 1_000_000_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;

/** A well-formed, zero-sum ledger transaction moving `amount` between buckets. */
function transfer(
  eventKey: string,
  amount: number,
): ReconciliationLedgerTransaction {
  return {
    eventType: "order-success",
    eventKey,
    referenceType: "order",
    referenceId: eventKey,
    entries: [
      { bucket: "platform_partner_payable", amountIdrSigned: -amount },
      { bucket: "partner_pending", amountIdrSigned: amount },
    ],
  };
}

function findingsOf(input: ReconcilePartnerInput): readonly PersistedFinding[] {
  return reconcilePartner({
    nowEpochMs: NOW,
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    ...input,
  });
}

describe("reconcilePartner", () => {
  it("reports no findings for fully consistent state", () => {
    const findings = findingsOf({
      ledgerTransactions: [transfer("order-success:o1", 1000)],
      earnings: [{ id: "e1", orderId: "o1", amountIdr: 1000, status: "pending" }],
      orderSnapshots: [{ orderId: "o1", payoutIdr: 1000 }],
      projectionBalances: { partner_pending: 1000 },
      devices: [
        { id: "d1", effectiveStatus: "online", lastSeenAtEpochMs: NOW - 1000 },
      ],
      numbers: [{ numberId: "n1", status: "available", activeOrderIds: [] }],
    });
    expect(findings).toEqual([]);
  });

  it("classifies a non-zero-sum ledger transaction as ledger_imbalance", () => {
    const broken: ReconciliationLedgerTransaction = {
      eventType: "order-success",
      eventKey: "order-success:bad",
      referenceType: "order",
      referenceId: "bad",
      entries: [
        { bucket: "platform_partner_payable", amountIdrSigned: -1000 },
        { bucket: "partner_pending", amountIdrSigned: 900 },
      ],
    };
    const findings = findingsOf({ ledgerTransactions: [broken] });

    const imbalance = findings.filter((f) => f.type === "ledger_imbalance");
    expect(imbalance).toContainEqual(
      expect.objectContaining({
        type: "ledger_imbalance",
        referenceId: "order-success:bad",
        detailsSafeJson: expect.objectContaining({
          detector: "ledger_transaction_not_zero_sum",
        }),
      }),
    );
    // The global-balance check also fires; both are ledger_imbalance.
    expect(imbalance.length).toBeGreaterThanOrEqual(1);
  });

  it("classifies earning != snapshot as earning_snapshot_mismatch", () => {
    const findings = findingsOf({
      earnings: [{ id: "e1", orderId: "o1", amountIdr: 900, status: "pending" }],
      orderSnapshots: [{ orderId: "o1", payoutIdr: 1000 }],
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        type: "earning_snapshot_mismatch",
        referenceId: "e1",
        detailsSafeJson: expect.objectContaining({
          detector: "earning_snapshot_mismatch",
          expectedPayoutIdr: 1000,
          earningAmountIdr: 900,
        }),
      }),
    );
  });

  it("classifies duplicate earning per order as earning_snapshot_mismatch", () => {
    const findings = findingsOf({
      earnings: [
        { id: "e1", orderId: "o1", amountIdr: 1000, status: "pending" },
        { id: "e2", orderId: "o1", amountIdr: 1000, status: "pending" },
      ],
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        type: "earning_snapshot_mismatch",
        referenceId: "o1",
        detailsSafeJson: expect.objectContaining({
          detector: "duplicate_earning_for_order",
          count: 2,
        }),
      }),
    );
  });

  it("classifies duplicate allocation per earning as payout_allocation_mismatch", () => {
    const findings = findingsOf({
      payouts: [
        {
          id: "p1",
          amountIdr: 1000,
          allocations: [{ earningId: "e1", amountIdr: 1000 }],
        },
        {
          id: "p2",
          amountIdr: 1000,
          allocations: [{ earningId: "e1", amountIdr: 1000 }],
        },
      ],
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        type: "payout_allocation_mismatch",
        referenceId: "e1",
        detailsSafeJson: expect.objectContaining({
          detector: "duplicate_allocation_for_earning",
          count: 2,
        }),
      }),
    );
  });

  it("classifies payout amount != sum of allocations as payout_allocation_mismatch", () => {
    const findings = findingsOf({
      payouts: [
        {
          id: "p1",
          amountIdr: 1500,
          allocations: [{ earningId: "e1", amountIdr: 1000 }],
        },
      ],
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        type: "payout_allocation_mismatch",
        referenceId: "p1",
        detailsSafeJson: expect.objectContaining({
          detector: "payout_allocation_mismatch",
          payoutAmountIdr: 1500,
          allocationTotalIdr: 1000,
        }),
      }),
    );
  });

  it("classifies projection drift as projection_ledger_mismatch", () => {
    const findings = findingsOf({
      ledgerTransactions: [transfer("order-success:o1", 1000)],
      // Ledger-derived partner_pending = 1000; projection claims 500.
      projectionBalances: { partner_pending: 500 },
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        type: "projection_ledger_mismatch",
        referenceId: "partner_pending",
        detailsSafeJson: expect.objectContaining({
          detector: "projection_ledger_mismatch",
          projected: 500,
          ledgerDerived: 1000,
        }),
      }),
    );
  });

  it("classifies an order/number state mismatch as order_number_mismatch", () => {
    const findings = findingsOf({
      // waiting_sms order must hold a busy number; here it is available.
      orderNumberPairs: [
        {
          orderId: "o1",
          orderStatus: "waiting_sms",
          numberId: "n1",
          numberStatus: "available",
        },
      ],
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        type: "order_number_mismatch",
        referenceId: "o1",
        detailsSafeJson: expect.objectContaining({
          detector: "order_number_pairing_mismatch",
        }),
      }),
    );
  });

  it("classifies a stale online device as stale_financial_state", () => {
    const findings = findingsOf({
      devices: [
        {
          id: "d1",
          effectiveStatus: "online",
          lastSeenAtEpochMs: NOW - HEARTBEAT_TIMEOUT_MS - 5000,
        },
      ],
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        type: "stale_financial_state",
        referenceId: "d1",
        detailsSafeJson: expect.objectContaining({
          detector: "stale_online_device",
        }),
      }),
    );
  });

  it("flags a held number with no active order", () => {
    const findings = findingsOf({
      numbers: [{ numberId: "n1", status: "busy", activeOrderIds: [] }],
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        type: "order_number_mismatch",
        referenceId: "n1",
        detailsSafeJson: expect.objectContaining({
          detector: "number_missing_active_order",
        }),
      }),
    );
  });

  it("flags a number backing more than one active order", () => {
    const findings = findingsOf({
      numbers: [
        { numberId: "n1", status: "busy", activeOrderIds: ["o1", "o2"] },
      ],
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        type: "order_number_mismatch",
        referenceId: "n1",
        severity: "high",
        detailsSafeJson: expect.objectContaining({
          detector: "number_multiple_active_orders",
          activeOrderCount: 2,
        }),
      }),
    );
  });

  it("flags an idle number that still backs an active order", () => {
    const findings = findingsOf({
      numbers: [
        { numberId: "n1", status: "available", activeOrderIds: ["o1"] },
      ],
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        type: "order_number_mismatch",
        referenceId: "n1",
        detailsSafeJson: expect.objectContaining({
          detector: "number_active_order_not_held",
          activeOrderId: "o1",
        }),
      }),
    );
  });

  it("produces a deterministic dedupe key across identical runs (never repairs money)", () => {
    const input: ReconcilePartnerInput = {
      earnings: [{ id: "e1", orderId: "o1", amountIdr: 900, status: "pending" }],
      orderSnapshots: [{ orderId: "o1", payoutIdr: 1000 }],
    };
    const first = findingsOf(input);
    const second = findingsOf(input);
    expect(second).toEqual(first);
    // The detector only ever emits findings; there is no mutation surface.
    expect(first.map((f) => `${f.type}:${f.referenceId}`)).toEqual([
      "earning_snapshot_mismatch:e1",
    ]);
  });
});
