import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  computeBucketBalances,
  decideRequestPayout,
  EARNING_STATUSES,
  type EarningState,
  type EarningStatus,
  payoutLockEventKey,
  PAYOUT_MINIMUM_IDR,
  type RequestPayoutDecision,
} from "@domain/task-5-6";

// Feature: partner-platform, Property 23: Payout mengunci whole Earning tepat sekali
//
// For all pilihan Earning, payout hanya dapat dibuat jika seluruh Earning
// available (unlocked), totalnya minimal Rp1.000, dan tidak ada Earning yang
// dipilih dua kali; ketika lock terjadi, amount payout sama dengan jumlah utuh
// setiap Earning terpilih (tanpa partial allocation). Pada simulasi request
// paralel di fake repository, setiap Earning hanya dapat terkunci pada satu
// payout — payout kedua yang mengincar Earning yang sama membaca statusnya
// sebagai `requested` dan ditolak, sehingga satu Earning tidak pernah muncul di
// lebih dari satu allocation.
//
// **Validates: Requirements 14.1, 14.3, 14.6**
//
// Design references:
// - "Payout mengunci seluruh Earning terpilih: available->requested" dan MVP
//   tanpa partial allocation (Design §9 "Earning dan Payout", tabel Finansial;
//   Req 14.1/14.2).
// - Minimum payout private beta Rp1.000 (Design tabel Finansial, Req 14.1).
// - "setiap Earning muncul maksimal pada satu allocation sehingga payout paralel
//   tidak dapat membayar Earning yang sama dua kali" (Property 23; Req 14.6).
// - Ledger event payout-lock memindah partner_available -> partner_payout_locked
//   secara zero-sum (Design §10 "Ledger dan Rekonsiliasi Finansial").
// - Pure domain test tidak memakai DB/network; concurrency dimodelkan dengan
//   in-memory fake repository yang men-serialize commit (Testing Strategy
//   §Property-Based Testing). Atomicity/`FOR UPDATE SKIP LOCKED` nyata tetap
//   integration test.
// - Property 23 bukan bagian target 500-run nightly (parser/pricing/state
//   machine/ledger append-only), sehingga numRuns minimum 100.

const NUM_RUNS = 100;

interface EarningSpec {
  readonly amountIdr: number;
  readonly status: EarningStatus;
}

// Amounts span both sides of the Rp1.000 minimum so single-earning selections
// can be rejected `below_minimum` while multi-earning selections can clear it.
const specArbitrary: fc.Arbitrary<EarningSpec> = fc.record({
  amountIdr: fc.integer({ min: 1, max: 5_000 }),
  status: fc.constantFrom<EarningStatus>(...EARNING_STATUSES),
});

// A payout request: an id plus raw selectors reduced modulo the pool size in the
// test body. Selectors may repeat (to exercise duplicate rejection) or be empty.
const requestArbitrary = fc.record({
  payoutId: fc.uuid(),
  rawSelection: fc.array(fc.nat({ max: 1_000 }), { maxLength: 6 }),
});

type ExpectedDecision =
  | { readonly kind: "lock" }
  | {
      readonly kind: "reject";
      readonly code:
        | "empty_selection"
        | "duplicate_earning"
        | "earning_not_available"
        | "below_minimum";
    };

/**
 * Deterministic replica of `decideRequestPayout`'s acceptance predicate against
 * the CURRENT committed status of each selected earning. Rejection precedence
 * mirrors the domain: empty -> duplicate/not-available (in order) -> minimum.
 */
function expectedDecision(
  selected: readonly EarningState[],
  minimumIdr: number,
): ExpectedDecision {
  if (selected.length === 0) {
    return { kind: "reject", code: "empty_selection" };
  }
  const seen = new Set<string>();
  for (const earning of selected) {
    if (seen.has(earning.id)) {
      return { kind: "reject", code: "duplicate_earning" };
    }
    seen.add(earning.id);
    if (earning.status !== "available") {
      return { kind: "reject", code: "earning_not_available" };
    }
  }
  const amount = selected.reduce((total, e) => total + e.amountIdr, 0);
  if (amount < minimumIdr) {
    return { kind: "reject", code: "below_minimum" };
  }
  return { kind: "lock" };
}

/**
 * In-memory fake repository that serializes concurrent payout requests the way
 * a database would. `requestPayout` reads the current committed earning states,
 * runs the pure domain decision, and — only when it locks — commits atomically
 * by transitioning each selected earning available -> requested (compare-and-set
 * on the still-available state). A later request that selects an
 * already-locked earning therefore sees `requested` and is rejected, so no
 * earning is ever locked into two payouts.
 */
class FakePayoutRepository {
  private readonly earnings: Map<string, EarningState>;
  readonly committedPayouts: {
    readonly id: string;
    readonly amountIdr: number;
    readonly earningIds: readonly string[];
  }[] = [];

  constructor(initial: readonly EarningState[]) {
    this.earnings = new Map(initial.map((e) => [e.id, e]));
  }

  current(id: string): EarningState {
    const earning = this.earnings.get(id);
    if (!earning) throw new Error(`unknown earning ${id}`);
    return earning;
  }

  requestPayout(
    payoutId: string,
    selectionIds: readonly string[],
  ): RequestPayoutDecision {
    const selected = selectionIds.map((id) => this.current(id));
    const decision = decideRequestPayout({ payoutId, earnings: selected });

    if (decision.kind === "lock") {
      for (const allocation of decision.allocations) {
        const cur = this.current(allocation.earningId);
        // CAS guard: the domain only decides `lock` when every selected earning
        // is available, so this must hold at commit time in the serialized model.
        expect(cur.status).toBe("available");
        this.earnings.set(allocation.earningId, { ...cur, status: "requested" });
      }
      this.committedPayouts.push({
        id: payoutId,
        amountIdr: decision.amountIdr,
        earningIds: decision.allocations.map((a) => a.earningId),
      });
    }

    return decision;
  }
}

describe("Property 23: Payout mengunci whole Earning tepat sekali", () => {
  it("locks the whole of each selected available earning at most once across parallel payout requests", () => {
    fc.assert(
      fc.property(
        fc.array(specArbitrary, { minLength: 1, maxLength: 8 }),
        fc.array(requestArbitrary, { minLength: 1, maxLength: 6 }),
        (pool, requests) => {
          const initial: EarningState[] = pool.map((spec, index) => ({
            id: `earn-${index}`,
            orderId: `order-${index}`,
            amountIdr: spec.amountIdr,
            status: spec.status,
            availableAt: new Date("2026-01-01T00:00:00.000Z"),
          }));
          const repo = new FakePayoutRepository(initial);

          const lockedEarningIds: string[] = [];

          for (const request of requests) {
            // Reduce raw selectors into valid pool indices; may repeat/be empty.
            const selectionIds = request.rawSelection.map(
              (n) => `earn-${n % pool.length}`,
            );
            const selectedBefore = selectionIds.map((id) => repo.current(id));
            const expected = expectedDecision(selectedBefore, PAYOUT_MINIMUM_IDR);

            const decision = repo.requestPayout(request.payoutId, selectionIds);

            // (14.1/14.3) Decision matches the acceptance predicate exactly.
            expect(decision.kind).toBe(expected.kind);
            if (expected.kind === "reject" && decision.kind === "reject") {
              expect(decision.code).toBe(expected.code);
            }

            if (decision.kind === "lock") {
              const expectedAmount = selectedBefore.reduce(
                (total, e) => total + e.amountIdr,
                0,
              );
              // Whole-earning locking: amount == sum of each selected earning's
              // full amount, and one allocation per selected earning (no partial).
              expect(decision.amountIdr).toBe(expectedAmount);
              expect(decision.amountIdr).toBeGreaterThanOrEqual(
                PAYOUT_MINIMUM_IDR,
              );
              expect(decision.earningNextStatus).toBe("requested");
              expect(decision.allocations.map((a) => a.earningId)).toEqual(
                selectionIds,
              );
              for (const [i, allocation] of decision.allocations.entries()) {
                expect(allocation.amountIdr).toBe(selectedBefore[i].amountIdr);
              }

              // Ledger event moves available -> locked, zero-sum.
              expect(decision.eventKey).toBe(
                payoutLockEventKey(request.payoutId),
              );
              const balances = computeBucketBalances([
                ...decision.transaction.entries,
              ]);
              expect(balances.partner_available).toBe(-expectedAmount);
              expect(balances.partner_payout_locked).toBe(expectedAmount);

              lockedEarningIds.push(...decision.allocations.map((a) => a.earningId));
            }
          }

          // (14.6) Every earning is locked into at most one payout: no earning id
          // appears in more than one committed allocation across all requests.
          expect(new Set(lockedEarningIds).size).toBe(lockedEarningIds.length);

          const committedIds = repo.committedPayouts.flatMap((p) => p.earningIds);
          expect(new Set(committedIds).size).toBe(committedIds.length);

          // Only earnings that were originally available can ever be locked, and
          // every locked earning now sits in `requested`.
          const originallyAvailable = new Set(
            initial.filter((e) => e.status === "available").map((e) => e.id),
          );
          for (const id of committedIds) {
            expect(originallyAvailable.has(id)).toBe(true);
            expect(repo.current(id).status).toBe("requested");
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
