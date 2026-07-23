import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  computeBucketBalances,
  type CreateEarningDecision,
  type CreateEarningInput,
  decideEarningOnSuccess,
  type EarningState,
  type LedgerTransaction,
  orderSuccessEventKey,
} from "@domain/task-5-6";

// Feature: partner-platform, Property 20: Success menghasilkan tepat satu Earning
//
// For all PartnerOrder dan jumlah pengulangan event OTP valid, perubahan pertama
// ke success menghasilkan tepat satu Earning pending dengan amount sama dengan
// payout snapshot dan event berikutnya tidak membuat Earning/ledger event
// tambahan. Kegagalan commit (failure boundary) pada unit-of-work tidak menyimpan
// apa pun sehingga retry berikutnya tetap dapat menghasilkan tepat satu Earning.
//
// **Validates: Requirements 13.1, 13.7**
//
// Design references:
// - "Order pertama kali success membuat satu Earning pending" dan retry order
//   sukses tidak menggandakan Earning (Components §9 "Earning dan Payout",
//   Req 13.1/13.7).
// - Earning dibuat dari payout pada OrderSnapshot yang immutable; ledger event
//   order-success memindah `platform_partner_payable -> partner_pending`
//   (Components §10 "Ledger dan Rekonsiliasi Finansial").
// - `eventKey` unik `order-success:{orderId}` membuat retry no-op deterministik
//   (Components §10).
// - Pure domain test tidak memakai DB/network; unit-of-work dipalsukan dengan
//   failure injection deterministik (Testing Strategy §Property-Based Testing).
// - numRuns minimum 100 (Property 20 bukan bagian target 500-run nightly untuk
//   parser/pricing/state machine/ledger append-only).

const NUM_RUNS = 100;

/**
 * Unit-of-work palsu yang meniru semantik transaksi atomik untuk pembuatan
 * Earning-on-success. Satu percobaan menghitung keputusan domain lalu:
 * - `no_change`  : Earning untuk order sudah ada -> tidak ada yang di-commit.
 * - `create`     : bila `injectFailure` maka commit dibatalkan (rollback) dan
 *                  tidak ada Earning/ledger transaction tersimpan; jika tidak,
 *                  keduanya ter-commit sebagai satu unit atomik.
 *
 * Dedupe (Req 13.7) dievaluasi dari state yang benar-benar ter-commit sehingga
 * commit yang gagal tidak pernah "menghabiskan" hak pembuatan Earning.
 */
class FakeEarningUnitOfWork {
  readonly committedEarnings: EarningState[] = [];
  readonly committedTransactions: LedgerTransaction[] = [];

  private hasEarningForOrder(orderId: string): boolean {
    return this.committedEarnings.some((earning) => earning.orderId === orderId);
  }

  applyOrderSuccess(
    input: Omit<CreateEarningInput, "earningExistsForOrder">,
    injectFailure: boolean,
  ): CreateEarningDecision {
    const decision = decideEarningOnSuccess({
      ...input,
      earningExistsForOrder: this.hasEarningForOrder(input.orderId),
    });

    if (decision.kind === "no_change") {
      // Deterministic idempotent no-op: nothing to commit.
      return decision;
    }

    if (injectFailure) {
      // Failure boundary: the transaction rolls back, nothing is persisted.
      throw new Error("EARNING_COMMIT_FAILED");
    }

    this.committedEarnings.push(decision.earning);
    this.committedTransactions.push(decision.transaction);
    return decision;
  }
}

interface SuccessAttempt {
  readonly earningId: string;
  readonly injectFailure: boolean;
}

const attemptArbitrary: fc.Arbitrary<SuccessAttempt> = fc.record({
  earningId: fc.uuid(),
  injectFailure: fc.boolean(),
});

describe("Property 20: Success menghasilkan tepat satu Earning", () => {
  it("commits exactly one pending Earning across repeated OTP-success events and any commit failure", () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.integer({ min: 1, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 4_102_444_800_000 }),
        fc.array(attemptArbitrary, { minLength: 1, maxLength: 12 }),
        (orderId, payoutIdr, succeededAtEpochMs, attempts) => {
          const succeededAt = new Date(succeededAtEpochMs);
          const uow = new FakeEarningUnitOfWork();

          for (const attempt of attempts) {
            try {
              uow.applyOrderSuccess(
                {
                  earningId: attempt.earningId,
                  orderId,
                  payoutIdr,
                  succeededAt,
                },
                attempt.injectFailure,
              );
            } catch {
              // Rollback: the atomic unit-of-work persisted nothing.
            }
          }

          // The earliest non-failing attempt is the one that commits; every
          // later event is a dedupe no-op, so exactly one Earning is created iff
          // at least one attempt was allowed to commit.
          const expectedCommitted = attempts.some((a) => !a.injectFailure)
            ? 1
            : 0;

          expect(uow.committedEarnings).toHaveLength(expectedCommitted);
          expect(uow.committedTransactions).toHaveLength(expectedCommitted);

          if (expectedCommitted === 1) {
            const [earning] = uow.committedEarnings;
            const [transaction] = uow.committedTransactions;

            // Exactly one pending Earning whose amount equals the payout snapshot.
            expect(earning.orderId).toBe(orderId);
            expect(earning.status).toBe("pending");
            expect(earning.amountIdr).toBe(payoutIdr);

            // The matching ledger event is stable-keyed and zero-sum:
            // payable -amount, pending +amount.
            expect(transaction.eventKey).toBe(orderSuccessEventKey(orderId));
            const balances = computeBucketBalances([...transaction.entries]);
            expect(balances.platform_partner_payable).toBe(-payoutIdr);
            expect(balances.partner_pending).toBe(payoutIdr);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
