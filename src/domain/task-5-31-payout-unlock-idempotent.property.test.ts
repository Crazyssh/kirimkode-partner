import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  computeBalancesFromTransactions,
  decidePayoutTransition,
  decideRequestPayout,
  isLedgerBalanced,
  type EarningState,
  type LedgerTransaction,
  type PayoutState,
  type PayoutStatus,
  PAYOUT_MINIMUM_IDR,
  payoutUnlockEventKey,
} from "@domain/task-5-6";

// Feature: partner-platform, Property 24: Kegagalan payout membuka lock secara idempotent
//
// For all payout belum paid, pengulangan transisi rejected/failed menghasilkan
// tepat satu unlock ledger event dan mengembalikan seluruh Earning terkait ke
// available tanpa mengubah total nilai ledger.
//
// **Validates: Requirements 14.5**
//
// Design references:
// - Payout state machine: requested|approved|processing -> rejected|failed
//   memicu earning locked -> available dengan SATU unlock ledger event
//   (payout-unlock:<id>); retry transisi terminal yang sudah berhasil adalah
//   no-op deterministik, sehingga unlock hanya menghasilkan satu event
//   (payout.ts, Req 14.5).
// - Unlock memindahkan seluruh amount dari partner_payout_locked kembali ke
//   partner_available; transaksi zero-sum sehingga total nilai ledger tidak
//   berubah (Design §10, Req 13.6).
// - Pure domain test tidak memakai DB/network (Testing Strategy).

const NUM_RUNS = 100;

// Non-paid, non-terminal source states from which reject/fail is a legal
// transition (VALID_SOURCES for rejected/failed). All three keep funds locked.
const SOURCE_STATUSES = ["requested", "approved", "processing"] as const;

type FailureCommandType = "reject" | "fail";

interface Scenario {
  // Whole-IDR earning amounts (each >= minimum so any selection is valid).
  readonly amounts: readonly number[];
  readonly sourceStatus: (typeof SOURCE_STATUSES)[number];
  readonly firstCommand: FailureCommandType;
  // Repeated terminal transitions used to probe idempotency: a mix of the same
  // and the opposite failure command must never emit another unlock event.
  readonly retries: readonly FailureCommandType[];
}

const scenarioArbitrary: fc.Arbitrary<Scenario> = fc.record({
  amounts: fc.array(
    fc.integer({ min: PAYOUT_MINIMUM_IDR, max: 10_000_000 }),
    { minLength: 1, maxLength: 6 },
  ),
  sourceStatus: fc.constantFrom(...SOURCE_STATUSES),
  firstCommand: fc.constantFrom<FailureCommandType>("reject", "fail"),
  retries: fc.array(fc.constantFrom<FailureCommandType>("reject", "fail"), {
    minLength: 0,
    maxLength: 5,
  }),
});

const AVAILABLE_AT = new Date("2026-01-01T00:00:00.000Z");

function failureCommand(type: FailureCommandType) {
  return { type, reason: "manual-review", actorRef: "admin-1" } as const;
}

describe("Property 24: Kegagalan payout membuka lock secara idempotent", () => {
  it("emits exactly one unlock event, returns every earning to available, and keeps the ledger conservative across repeated reject/fail transitions", () => {
    fc.assert(
      fc.property(scenarioArbitrary, (scenario) => {
        const payoutId = "payout-1";

        // Build the selected available earnings and lock them via the real
        // request-payout decision so allocations/amount are authoritative.
        const earnings: EarningState[] = scenario.amounts.map((amountIdr, i) => ({
          id: `earn-${i}`,
          orderId: `order-${i}`,
          amountIdr,
          status: "available",
          availableAt: AVAILABLE_AT,
        }));

        const lock = decideRequestPayout({ payoutId, earnings });
        expect(lock.kind).toBe("lock");
        if (lock.kind !== "lock") return;

        // The lock covers the WHOLE of every selected earning (Req 14.1/14.2).
        expect(lock.allocations.length).toBe(earnings.length);
        const lockedEarningIds = new Set(lock.allocations.map((a) => a.earningId));
        for (const earning of earnings) {
          expect(lockedEarningIds.has(earning.id)).toBe(true);
        }

        // Payout currently sits in a non-paid, funds-locked source state.
        let payout: PayoutState = {
          id: payoutId,
          status: scenario.sourceStatus as PayoutStatus,
          amountIdr: lock.amountIdr,
          allocations: lock.allocations,
          paymentReference: null,
        };

        const unlockEvents: LedgerTransaction[] = [];

        // First terminal failure transition: unlocks the whole payout once.
        const first = decidePayoutTransition(
          payout,
          failureCommand(scenario.firstCommand),
        );
        expect(first.kind).toBe("apply");
        if (first.kind !== "apply") return;
        // Every related earning moves locked -> available (Req 14.5).
        expect(first.earningNextStatus).toBe("available");
        expect(first.transaction).not.toBeNull();
        if (first.transaction === null) return;
        expect(first.transaction.eventType).toBe("payout-unlock");
        expect(first.transaction.eventKey).toBe(payoutUnlockEventKey(payoutId));
        // The unlock transaction is itself zero-sum (no change in ledger value).
        expect(
          first.transaction.entries.reduce((t, e) => t + e.amountIdrSigned, 0),
        ).toBe(0);
        unlockEvents.push(first.transaction);

        const terminalStatus = first.nextStatus;
        payout = { ...payout, status: terminalStatus };

        // Idempotency probe: retrying reject/fail on a terminal payout must never
        // produce another unlock event. Same command -> deterministic no-op;
        // opposite command -> rejected as a terminal-state conflict.
        for (const retry of scenario.retries) {
          const decision = decidePayoutTransition(payout, failureCommand(retry));
          const retryTarget: PayoutStatus =
            retry === "reject" ? "rejected" : "failed";

          if (retryTarget === terminalStatus) {
            expect(decision.kind).toBe("no_change");
          } else {
            expect(decision.kind).toBe("reject");
            if (decision.kind === "reject") {
              expect(decision.code).toBe("terminal_state_conflict");
            }
          }
          // Neither branch yields a transaction, so no unlock event is added.
          if (decision.kind === "apply" && decision.transaction !== null) {
            unlockEvents.push(decision.transaction);
          }
        }

        // Exactly one unlock event regardless of how many retries occurred.
        expect(unlockEvents.length).toBe(1);

        // Total ledger value is unchanged by the lock+unlock round trip:
        // the unlock exactly reverses the lock, leaving all buckets at zero.
        const balances = computeBalancesFromTransactions([
          lock.transaction,
          unlockEvents[0],
        ]);
        expect(balances.partner_payout_locked).toBe(0);
        expect(balances.partner_available).toBe(0);
        expect(isLedgerBalanced(balances)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
