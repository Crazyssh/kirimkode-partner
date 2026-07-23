import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  decideRequestPayout,
  type EarningState,
  type EarningStatus,
  EARNING_STATUSES,
  type PayoutAllocation,
  PAYOUT_MINIMUM_IDR,
} from "@domain/task-5-6";

// Feature: partner-platform, Property 23: Payout mengunci whole Earning tepat sekali
//
// For all pilihan Earning, payout hanya dapat dibuat jika seluruh Earning
// available, unlocked, totalnya minimal Rp1.000, dan amount sama dengan jumlah
// pilihan; setiap Earning muncul maksimal pada satu allocation sehingga payout
// paralel tidak dapat membayar Earning yang sama dua kali.
//
// **Validates: Requirements 14.1, 14.3, 14.6**
//
// Design references:
// - Requesting a payout locks the WHOLE of each selected available/unlocked
//   earning; amount must meet the minimum and equal the sum of the selection
//   (Design §"Earning dan Payout", Req 14.1). No partial allocation on MVP.
// - `decideRequestPayout` moves each selected earning available -> requested and
//   the ledger available -> locked atomically; a payout request is all-or-nothing
//   (Req 14.2).
// - Payout statuses requested/approved/processing/paid/rejected/failed (Req 14.3).
// - Each earning may appear in at most one payout allocation, so two concurrent
//   payout requests that both observe the same available earning cannot both
//   lock it (Req 14.6).
// - Pure domain test tidak memakai DB/network; concurrency disimulasikan dengan
//   in-memory fake repository (compare-and-set) — atomicity nyata tetap
//   integration test (Testing Strategy §Property-Based Testing).
// - numRuns minimum 100 (Property 23 bukan target 500-run nightly untuk
//   parser/pricing/state machine/ledger append-only).

const NUM_RUNS = 100;
const MINIMUM = PAYOUT_MINIMUM_IDR;

/**
 * In-memory payout repository that models the atomic lock at the persistence
 * boundary. `decideRequestPayout` is pure and only reads the earning states it
 * is handed; the compare-and-set (CAS) here is what actually enforces that a
 * given earning can be locked by at most one payout under concurrency.
 */
class FakePayoutRepository {
  private readonly earnings = new Map<string, EarningState>();
  readonly committedPayouts = new Map<
    string,
    { readonly amountIdr: number; readonly allocations: readonly PayoutAllocation[] }
  >();

  constructor(initial: readonly EarningState[]) {
    for (const earning of initial) {
      this.earnings.set(earning.id, earning);
    }
  }

  /** Snapshot the current state of the requested earning ids (a "read"). */
  read(ids: readonly string[]): EarningState[] {
    return ids.map((id) => this.earnings.get(id)!);
  }

  status(id: string): EarningStatus {
    return this.earnings.get(id)!.status;
  }

  /**
   * Attempt to commit a lock decision atomically. The CAS re-checks that every
   * allocated earning is still `available`; if any lost the race the whole
   * payout fails to commit (all-or-nothing) and nothing is mutated.
   */
  tryCommitLock(
    payoutId: string,
    amountIdr: number,
    allocations: readonly PayoutAllocation[],
  ): "committed" | "conflict" {
    for (const allocation of allocations) {
      if (this.earnings.get(allocation.earningId)!.status !== "available") {
        return "conflict";
      }
    }
    for (const allocation of allocations) {
      const earning = this.earnings.get(allocation.earningId)!;
      this.earnings.set(allocation.earningId, {
        ...earning,
        status: "requested",
      });
    }
    this.committedPayouts.set(payoutId, { amountIdr, allocations });
    return "committed";
  }
}

interface Scenario {
  readonly earnings: readonly { readonly amountIdr: number; readonly status: EarningStatus }[];
  /** Each request is a list of indices into `earnings` (may repeat / overlap). */
  readonly requests: readonly (readonly number[])[];
}

const scenarioArbitrary: fc.Arbitrary<Scenario> = fc
  .integer({ min: 1, max: 6 })
  .chain((count) =>
    fc.record({
      earnings: fc.array(
        fc.record({
          // Amounts straddle the minimum so single/combined selections exercise
          // both the below-minimum reject and valid lock paths.
          amountIdr: fc.integer({ min: 1, max: 2 * MINIMUM }),
          status: fc.constantFrom<EarningStatus>(...EARNING_STATUSES),
        }),
        { minLength: count, maxLength: count },
      ),
      requests: fc.array(
        fc.array(fc.integer({ min: 0, max: count - 1 }), {
          minLength: 0,
          maxLength: count + 1,
        }),
        { minLength: 1, maxLength: 4 },
      ),
    }),
  );

describe("Property 23: Payout mengunci whole Earning tepat sekali", () => {
  it("locks only whole available earnings and never pays one earning through two payouts", () => {
    fc.assert(
      fc.property(scenarioArbitrary, (scenario) => {
        const initial: EarningState[] = scenario.earnings.map((e, i) => ({
          id: `earn-${i}`,
          orderId: `order-${i}`,
          amountIdr: e.amountIdr,
          status: e.status,
          availableAt: new Date(0),
        }));
        const initialStatus = new Map(initial.map((e) => [e.id, e.status]));
        const initialAmount = new Map(initial.map((e) => [e.id, e.amountIdr]));

        const repo = new FakePayoutRepository(initial);

        // Phase 1 — parallel reads + pure decisions against the SAME snapshot.
        // Every request observes the initial state (no request has committed
        // yet), which is exactly how concurrent requests can both see an
        // earning as available and both decide to lock it.
        const decided = scenario.requests.map((selection, r) => {
          const payoutId = `payout-${r}`;
          const ids = selection.map((idx) => `earn-${idx}`);
          const decision = decideRequestPayout({
            payoutId,
            earnings: repo.read(ids),
            minimumIdr: MINIMUM,
          });
          return { payoutId, selection, ids, decision };
        });

        // Reference decision that mirrors the domain's in-order scan: the first
        // violation encountered wins (empty selection, then per-earning duplicate
        // vs not-available in list order, then below-minimum).
        const expectedRejectCode = (ids: readonly string[]): string | null => {
          if (ids.length === 0) return "empty_selection";
          const seen = new Set<string>();
          for (const id of ids) {
            if (seen.has(id)) return "duplicate_earning";
            seen.add(id);
            if (initialStatus.get(id) !== "available") {
              return "earning_not_available";
            }
          }
          const total = ids.reduce((sum, id) => sum + initialAmount.get(id)!, 0);
          if (total < MINIMUM) return "below_minimum";
          return null;
        };

        for (const { ids, decision } of decided) {
          // --- Validate the pure decision against Req 14.1 rules. ---
          const expectedCode = expectedRejectCode(ids);
          if (expectedCode !== null) {
            expect(decision.kind).toBe("reject");
            if (decision.kind !== "reject") return;
            expect(decision.code).toBe(expectedCode);
            continue;
          }

          const total = ids.reduce((sum, id) => sum + initialAmount.get(id)!, 0);

          // Otherwise a valid whole-earning lock (Req 14.1, 14.3).
          expect(decision.kind).toBe("lock");
          if (decision.kind !== "lock") return;
          expect(decision.earningNextStatus).toBe("requested");
          // amount == sum of selection, one allocation per earning, whole amount.
          expect(decision.amountIdr).toBe(total);
          expect(decision.allocations.map((a) => a.earningId).sort()).toEqual(
            [...ids].sort(),
          );
          for (const allocation of decision.allocations) {
            expect(allocation.amountIdr).toBe(initialAmount.get(allocation.earningId));
          }
        }

        // Phase 2 — serialize the commits with CAS (a valid interleaving of the
        // concurrent requests). Winners lock their earnings; a request that lost
        // the race on any earning fails to commit entirely.
        for (const { payoutId, decision } of decided) {
          if (decision.kind === "lock") {
            repo.tryCommitLock(payoutId, decision.amountIdr, decision.allocations);
          }
        }

        // --- Req 14.6: every earning is allocated to at most one payout. ---
        const lockCount = new Map<string, number>();
        for (const [, payout] of repo.committedPayouts) {
          // Committed payout amount still equals the sum of its allocations.
          const allocTotal = payout.allocations.reduce(
            (sum, a) => sum + a.amountIdr,
            0,
          );
          expect(payout.amountIdr).toBe(allocTotal);
          expect(payout.amountIdr).toBeGreaterThanOrEqual(MINIMUM);

          for (const allocation of payout.allocations) {
            lockCount.set(
              allocation.earningId,
              (lockCount.get(allocation.earningId) ?? 0) + 1,
            );
          }
        }
        for (const [, count] of lockCount) {
          expect(count).toBe(1);
        }

        // Every locked earning was `available` in the initial snapshot and is now
        // `requested`; nothing else changed. This guarantees the "whole earning
        // locked exactly once" outcome under concurrency.
        for (const earning of initial) {
          if (lockCount.has(earning.id)) {
            expect(initialStatus.get(earning.id)).toBe("available");
            expect(repo.status(earning.id)).toBe("requested");
          } else {
            expect(repo.status(earning.id)).toBe(initialStatus.get(earning.id));
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
