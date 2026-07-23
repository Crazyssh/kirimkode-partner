import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  LEDGER_BUCKETS,
  type LedgerBucket,
  type LedgerTransaction,
} from "@domain/task-5-6";
import {
  reconcile,
  type ReconciliationInput,
  type ReconciliationIssueType,
  type ReconciliationSeverity,
} from "@domain/task-5-7";

// Feature: partner-platform, Property 31: Reconciliation mendeteksi pelanggaran invariant
//
// For all state valid yang diinjeksi TEPAT SATU pelanggaran invariant—order-
// number mismatch, duplicate earning, duplicate allocation, ledger tidak
// zero-sum, payout mismatch, earning≠snapshot, projection≠ledger, atau stale
// online device—reconciler:
//  - selalu melaporkan report inconsistent (issues non-kosong),
//  - menghasilkan issue dengan TIPE dan REFERENCE yang tepat (dan severity yang
//    tepat) untuk entitas yang melanggar, tanpa menandai entitas yang sehat,
//  - dan TIDAK memperbaiki uang secara diam-diam: input tidak pernah dimutasi
//    dan report hanya berisi daftar issue deskriptif (tidak ada balance
//    "diperbaiki"), karena remediasi selalu compensating action terpisah.
// Sebaliknya, dataset yang sepenuhnya konsisten tidak pernah menghasilkan issue
// (detektor presisi — tidak false-positive).
//
// **Validates: Requirements 20.2, 20.6**
//
// Design references:
// - "Rekonsiliasi memverifikasi zero-sum, snapshot=earning, earning unik/order,
//   allocation unik/earning, payout amount=jumlah allocation, dan kesesuaian
//   projection dengan ledger" (Design §10 Ledger dan Rekonsiliasi Finansial).
// - "Reconciliation memeriksa stale online device, number tanpa/berganda order
//   aktif, dan order-number state mismatch" (Design §7 Heartbeat/Recovery).
// - Property 31: "diinjeksi tepat satu pelanggaran ... reconciler menghasilkan
//   issue dengan tipe/reference yang tepat dan tidak memperbaiki uang secara
//   diam-diam" (Design §Correctness Properties, Req 20.2/20.6).
// - "perbaikan finansial hanya via compensating transaction — reconciler
//   bersifat read-only" (Design §Error Handling / Req 20.6).
// - Pure domain test tidak memakai DB/network (Testing Strategy).
// - Property 31 bukan bagian set 500-run (parser/pricing/state machine/ledger);
//   memakai numRuns di atas minimum 100 per Testing Strategy.

const NUM_RUNS = 300;

// "now" comfortably large so any derived lastSeenAt stays a non-negative epoch.
const NOW_EPOCH_MS = 10_000_000_000;

// Positive, safe-integer amount; keeps every derived sum a safe integer.
const amountArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 1_000_000 });
// A strictly non-zero delta used to break an equality invariant.
const nonzeroDeltaArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 1_000_000 });

// The full, deterministic scenario the property asserts against.
interface Scenario {
  readonly label: string;
  readonly input: ReconciliationInput;
  readonly primaryType: ReconciliationIssueType;
  readonly primaryRef: string;
  readonly primarySeverity: ReconciliationSeverity;
  // Exact set of issue types the reconciler must report for this single fault.
  readonly expectedTypeSet: readonly ReconciliationIssueType[];
}

// ---------------------------------------------------------------------------
// 1. order_number_pairing_mismatch (medium)
// ---------------------------------------------------------------------------

const ALL_NUMBER_STATUSES = [
  "reserved",
  "busy",
  "available",
  "offline",
  "disabled",
] as const;

const consistentPairArb = fc.oneof(
  fc.record({
    orderStatus: fc.constant("reserved"),
    numberStatus: fc.constant("reserved"),
  }),
  fc.record({
    orderStatus: fc.constantFrom("waiting_sms", "success"),
    numberStatus: fc.constant("busy"),
  }),
  fc.record({
    orderStatus: fc.constantFrom("cancelled", "timeout", "failed"),
    numberStatus: fc.constantFrom("available", "offline", "disabled"),
  }),
  // `created` and other non-constrained statuses are always consistent.
  fc.record({
    orderStatus: fc.constant("created"),
    numberStatus: fc.constantFrom(...ALL_NUMBER_STATUSES),
  }),
);

const inconsistentPairArb = fc.oneof(
  // reserved order must sit on a reserved number.
  fc.record({
    orderStatus: fc.constant("reserved"),
    numberStatus: fc.constantFrom("busy", "available", "offline", "disabled"),
  }),
  // waiting_sms/success must hold a busy number.
  fc.record({
    orderStatus: fc.constantFrom("waiting_sms", "success"),
    numberStatus: fc.constantFrom("reserved", "available", "offline", "disabled"),
  }),
  // terminal orders must have released the number (never reserved/busy).
  fc.record({
    orderStatus: fc.constantFrom("cancelled", "timeout", "failed"),
    numberStatus: fc.constantFrom("reserved", "busy"),
  }),
);

const orderNumberScenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    baseline: fc.array(consistentPairArb, { maxLength: 4 }),
    bad: inconsistentPairArb,
  })
  .map(({ baseline, bad }) => {
    const pairs = [...baseline, bad].map((p, i) => ({
      orderId: `order-${i}`,
      orderStatus: p.orderStatus,
      numberId: `num-${i}`,
      numberStatus: p.numberStatus,
    }));
    const badPair = pairs[pairs.length - 1];
    return {
      label: "order_number_pairing_mismatch",
      input: { orderNumberPairs: pairs },
      primaryType: "order_number_pairing_mismatch",
      primaryRef: badPair.orderId,
      primarySeverity: "medium",
      expectedTypeSet: ["order_number_pairing_mismatch"],
    };
  });

// ---------------------------------------------------------------------------
// 2. duplicate_earning_for_order (high) — earnings only, no snapshots.
// ---------------------------------------------------------------------------

const duplicateEarningScenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    orderCount: fc.integer({ min: 1, max: 4 }),
    dupSeed: fc.nat(),
    amounts: fc.array(amountArb, { minLength: 4, maxLength: 4 }),
    dupAmount: amountArb,
  })
  .map(({ orderCount, dupSeed, amounts, dupAmount }) => {
    const earnings = [];
    for (let i = 0; i < orderCount; i += 1) {
      earnings.push({
        id: `earn-${i}`,
        orderId: `order-${i}`,
        amountIdr: amounts[i],
        status: "pending",
      });
    }
    const d = dupSeed % orderCount;
    earnings.push({
      id: "earn-dup",
      orderId: `order-${d}`,
      amountIdr: dupAmount,
      status: "pending",
    });
    return {
      label: "duplicate_earning_for_order",
      input: { earnings },
      primaryType: "duplicate_earning_for_order",
      primaryRef: `order-${d}`,
      primarySeverity: "high",
      expectedTypeSet: ["duplicate_earning_for_order"],
    };
  });

// ---------------------------------------------------------------------------
// 3. duplicate_allocation_for_earning (high) — one earning in two allocations,
//    payout amounts still equal to their allocation totals.
// ---------------------------------------------------------------------------

const duplicateAllocationScenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    a: amountArb,
    b: amountArb,
    extras: fc.array(amountArb, { maxLength: 2 }),
  })
  .map(({ a, b, extras }) => {
    const payouts = [
      {
        id: "payout-bad",
        amountIdr: a + b,
        allocations: [
          { earningId: "earn-E", amountIdr: a },
          { earningId: "earn-E", amountIdr: b },
        ],
      },
      ...extras.map((amt, i) => ({
        id: `payout-${i}`,
        amountIdr: amt,
        allocations: [{ earningId: `earn-x-${i}`, amountIdr: amt }],
      })),
    ];
    return {
      label: "duplicate_allocation_for_earning",
      input: { payouts },
      primaryType: "duplicate_allocation_for_earning",
      primaryRef: "earn-E",
      primarySeverity: "high",
      expectedTypeSet: ["duplicate_allocation_for_earning"],
    };
  });

// ---------------------------------------------------------------------------
// 4. payout_allocation_mismatch (high) — one payout amount != allocation total,
//    all earningIds distinct so no duplicate allocation fires.
// ---------------------------------------------------------------------------

const payoutMismatchScenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    allocationTotal: amountArb,
    delta: nonzeroDeltaArb,
    extras: fc.array(amountArb, { maxLength: 2 }),
  })
  .map(({ allocationTotal, delta, extras }) => {
    const payouts = [
      {
        id: "payout-bad",
        amountIdr: allocationTotal + delta, // != allocation total
        allocations: [{ earningId: "earn-bad", amountIdr: allocationTotal }],
      },
      ...extras.map((amt, i) => ({
        id: `payout-${i}`,
        amountIdr: amt,
        allocations: [{ earningId: `earn-ok-${i}`, amountIdr: amt }],
      })),
    ];
    return {
      label: "payout_allocation_mismatch",
      input: { payouts },
      primaryType: "payout_allocation_mismatch",
      primaryRef: "payout-bad",
      primarySeverity: "high",
      expectedTypeSet: ["payout_allocation_mismatch"],
    };
  });

// ---------------------------------------------------------------------------
// 5. ledger_transaction_not_zero_sum (high) — one unbalanced transaction. This
//    necessarily also unbalances the whole ledger, so the deterministic
//    expected set is {transaction_not_zero_sum, global_imbalance}.
// ---------------------------------------------------------------------------

function balancedTransaction(index: number, amount: number): LedgerTransaction {
  const from = LEDGER_BUCKETS[index % LEDGER_BUCKETS.length];
  const to = LEDGER_BUCKETS[(index + 1) % LEDGER_BUCKETS.length];
  return {
    eventType: "order-success",
    eventKey: `tx-${index}`,
    referenceType: "order",
    referenceId: `order-${index}`,
    entries: [
      { bucket: from, amountIdrSigned: -amount },
      { bucket: to, amountIdrSigned: amount },
    ],
  };
}

const ledgerNotZeroSumScenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    balanced: fc.array(amountArb, { maxLength: 2 }),
    imbalance: nonzeroDeltaArb,
    bucketSeed: fc.nat(),
  })
  .map(({ balanced, imbalance, bucketSeed }) => {
    const bucket: LedgerBucket =
      LEDGER_BUCKETS[bucketSeed % LEDGER_BUCKETS.length];
    const badTx: LedgerTransaction = {
      eventType: "order-success",
      eventKey: "tx-bad",
      referenceType: "order",
      referenceId: "order-bad",
      entries: [{ bucket, amountIdrSigned: imbalance }], // sums to != 0
    };
    const ledgerTransactions = [
      ...balanced.map((amt, i) => balancedTransaction(i, amt)),
      badTx,
    ];
    return {
      label: "ledger_transaction_not_zero_sum",
      input: { ledgerTransactions },
      primaryType: "ledger_transaction_not_zero_sum",
      primaryRef: "tx-bad",
      primarySeverity: "high",
      expectedTypeSet: [
        "ledger_transaction_not_zero_sum",
        "ledger_global_imbalance",
      ],
    };
  });

// ---------------------------------------------------------------------------
// 6. earning_snapshot_mismatch (high) — one earning amount != snapshot payout,
//    all orderIds unique so no duplicate-earning issue.
// ---------------------------------------------------------------------------

const earningSnapshotScenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    count: fc.integer({ min: 1, max: 4 }),
    payouts: fc.array(amountArb, { minLength: 4, maxLength: 4 }),
    badSeed: fc.nat(),
    delta: nonzeroDeltaArb,
  })
  .map(({ count, payouts, badSeed, delta }) => {
    const b = badSeed % count;
    const orderSnapshots = [];
    const earnings = [];
    for (let i = 0; i < count; i += 1) {
      const payoutIdr = payouts[i];
      orderSnapshots.push({ orderId: `order-${i}`, payoutIdr });
      earnings.push({
        id: `earn-${i}`,
        orderId: `order-${i}`,
        amountIdr: i === b ? payoutIdr + delta : payoutIdr,
        status: "pending",
      });
    }
    return {
      label: "earning_snapshot_mismatch",
      input: { earnings, orderSnapshots },
      primaryType: "earning_snapshot_mismatch",
      primaryRef: `earn-${b}`,
      primarySeverity: "high",
      expectedTypeSet: ["earning_snapshot_mismatch"],
    };
  });

// ---------------------------------------------------------------------------
// 7. projection_ledger_mismatch (high) — single bucket differs from the
//    ledger-derived (here empty => 0) balance.
// ---------------------------------------------------------------------------

const projectionMismatchScenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    bucketSeed: fc.nat(),
    delta: nonzeroDeltaArb,
  })
  .map(({ bucketSeed, delta }) => {
    const bucket: LedgerBucket =
      LEDGER_BUCKETS[bucketSeed % LEDGER_BUCKETS.length];
    return {
      label: "projection_ledger_mismatch",
      input: { projectionBalances: { [bucket]: delta } },
      primaryType: "projection_ledger_mismatch",
      primaryRef: bucket,
      primarySeverity: "high",
      expectedTypeSet: ["projection_ledger_mismatch"],
    };
  });

// ---------------------------------------------------------------------------
// 8. stale_online_device (medium) — one online device older than the timeout;
//    every other online device is fresh, offline/disabled devices are ignored.
// ---------------------------------------------------------------------------

const otherDeviceSpecArb = fc.oneof(
  fc.record({ kind: fc.constant("online-fresh"), rawAge: fc.nat() }),
  fc.record({ kind: fc.constant("offline"), rawAge: fc.nat() }),
  fc.record({ kind: fc.constant("disabled"), rawAge: fc.nat() }),
);

const staleDeviceScenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    heartbeatTimeoutMs: fc.integer({ min: 1, max: 1_000_000 }),
    staleExtra: fc.integer({ min: 1, max: 1_000_000 }),
    others: fc.array(otherDeviceSpecArb, { maxLength: 4 }),
  })
  .map(({ heartbeatTimeoutMs, staleExtra, others }) => {
    const devices = [
      {
        id: "dev-bad",
        effectiveStatus: "online" as const,
        // age = timeout + staleExtra > timeout => strictly stale.
        lastSeenAtEpochMs: NOW_EPOCH_MS - (heartbeatTimeoutMs + staleExtra),
      },
      ...others.map((spec, i) => {
        if (spec.kind === "online-fresh") {
          // clamp age to <= timeout so it is never stale.
          const freshAge = spec.rawAge % (heartbeatTimeoutMs + 1);
          return {
            id: `dev-${i}`,
            effectiveStatus: "online" as const,
            lastSeenAtEpochMs: NOW_EPOCH_MS - freshAge,
          };
        }
        // offline/disabled devices are skipped regardless of staleness.
        return {
          id: `dev-${i}`,
          effectiveStatus: spec.kind as "offline" | "disabled",
          lastSeenAtEpochMs: NOW_EPOCH_MS - (heartbeatTimeoutMs + spec.rawAge),
        };
      }),
    ];
    return {
      label: "stale_online_device",
      input: { devices, nowEpochMs: NOW_EPOCH_MS, heartbeatTimeoutMs },
      primaryType: "stale_online_device",
      primaryRef: "dev-bad",
      primarySeverity: "medium",
      expectedTypeSet: ["stale_online_device"],
    };
  });

const scenarioArb: fc.Arbitrary<Scenario> = fc.oneof(
  orderNumberScenarioArb,
  duplicateEarningScenarioArb,
  duplicateAllocationScenarioArb,
  payoutMismatchScenarioArb,
  ledgerNotZeroSumScenarioArb,
  earningSnapshotScenarioArb,
  projectionMismatchScenarioArb,
  staleDeviceScenarioArb,
);

// A fully consistent dataset spanning every check — the precision control.
const consistentScenarioArb: fc.Arbitrary<ReconciliationInput> = fc
  .record({
    amount: amountArb,
    freshAge: fc.nat(),
    timeout: fc.integer({ min: 1, max: 1_000_000 }),
  })
  .map(({ amount, freshAge, timeout }) => {
    const balancedTx: LedgerTransaction = {
      eventType: "order-success",
      eventKey: "tx-1",
      referenceType: "order",
      referenceId: "order-1",
      entries: [
        { bucket: "platform_partner_payable", amountIdrSigned: -amount },
        { bucket: "partner_pending", amountIdrSigned: amount },
      ],
    };
    return {
      ledgerTransactions: [balancedTx],
      earnings: [
        { id: "earn-1", orderId: "order-1", amountIdr: amount, status: "pending" },
      ],
      orderSnapshots: [{ orderId: "order-1", payoutIdr: amount }],
      payouts: [
        {
          id: "payout-1",
          amountIdr: amount,
          allocations: [{ earningId: "earn-1", amountIdr: amount }],
        },
      ],
      projectionBalances: {
        platform_partner_payable: -amount,
        partner_pending: amount,
      },
      orderNumberPairs: [
        { orderId: "order-1", orderStatus: "success", numberId: "num-1", numberStatus: "busy" },
      ],
      devices: [
        {
          id: "dev-fresh",
          effectiveStatus: "online" as const,
          lastSeenAtEpochMs: NOW_EPOCH_MS - (freshAge % (timeout + 1)),
        },
        {
          id: "dev-off",
          effectiveStatus: "offline" as const,
          lastSeenAtEpochMs: NOW_EPOCH_MS - (timeout + 1_000),
        },
      ],
      nowEpochMs: NOW_EPOCH_MS,
      heartbeatTimeoutMs: timeout,
    };
  });

describe("Property 31: Reconciliation mendeteksi pelanggaran invariant", () => {
  it("flags exactly one injected invariant violation with the right type/reference and never repairs money silently", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        // Snapshot the input to prove the reconciler is read-only (no silent
        // money repair): remediation must be a separate compensating action.
        const before = structuredClone(scenario.input);

        const report = reconcile(scenario.input);

        // Read-only: the reconciler never mutates or "fixes" the supplied state.
        expect(scenario.input).toStrictEqual(before);

        // The reconciler always evaluates the same fixed set of invariants.
        expect(report.checkedInvariants).toBe(9);

        // An injected mismatch always makes the report inconsistent.
        expect(report.consistent).toBe(false);
        expect(report.issues.length).toBeGreaterThan(0);

        // The report is purely a list of detected issues — no repaired balances.
        expect(Object.keys(report).sort()).toStrictEqual([
          "checkedInvariants",
          "consistent",
          "issues",
        ]);

        // The reported issue types are exactly those implied by the single fault
        // — no healthy entity is ever flagged.
        const reportedTypes = [...new Set(report.issues.map((i) => i.type))].sort();
        expect(reportedTypes).toStrictEqual([...scenario.expectedTypeSet].sort());

        // Exactly one primary issue, pointing at the exact offending entity.
        const primaries = report.issues.filter(
          (i) => i.type === scenario.primaryType,
        );
        expect(primaries).toHaveLength(1);
        expect(primaries[0].referenceId).toBe(scenario.primaryRef);
        expect(primaries[0].severity).toBe(scenario.primarySeverity);

        // Detected issues are frozen — the report is not a mutation handle.
        expect(Object.isFrozen(report.issues)).toBe(true);
        expect(Object.isFrozen(primaries[0])).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("reports no issues for a fully consistent dataset spanning every invariant", () => {
    fc.assert(
      fc.property(consistentScenarioArb, (input) => {
        const report = reconcile(input);
        expect(report.checkedInvariants).toBe(9);
        expect(report.consistent).toBe(true);
        expect(report.issues).toHaveLength(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
