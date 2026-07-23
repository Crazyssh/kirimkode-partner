import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  computeBalancesFromTransactions,
  decideEarningOnSuccess,
  decideHoldRelease,
  decideEarningReversal,
  decidePayoutTransition,
  decideRequestPayout,
  isLedgerBalanced,
  LEDGER_BUCKETS,
  type LedgerBucket,
  type LedgerTransaction,
  type PayoutState,
  PAYOUT_MINIMUM_IDR,
} from "@domain/task-5-6";

// Feature: partner-platform, Property 22: Ledger konservatif dan append-only
//
// For all urutan event finansial valid (success, hold-release, reversal, payout
// lock, dan payout paid), (a) jumlah signed entry setiap LedgerTransaction
// adalah nol, (b) saldo projection (turunan dari status Earning/Payout) sama
// dengan SUM bucket ledger, dan (c) reversal maupun retry hanya MENAMBAH
// transaksi pembalik/no-op tanpa mengubah atau menghapus transaksi asli. Ledger
// adalah satu-satunya sumber kebenaran nominal; tidak ada kolom balance mutable.
//
// **Validates: Requirements 13.5, 13.6**
//
// Design references:
// - Ledger append-only memakai LedgerTransaction dan minimal dua LedgerEntry per
//   event; jumlah signed entry per transaction harus nol. Bucket:
//   platform_partner_payable, partner_pending, partner_available,
//   partner_payout_locked, partner_paid, partner_reversed (Design §10).
// - Saldo portal dihitung dari SUM ledger entries per bucket, bukan kolom balance
//   mutable; PartnerEarning/PartnerPayout hanya projection dan ledger adalah
//   sumber kebenaran nominal (Design §10, Req 13.6).
// - Reversal membuat compensating transaction yang dapat diaudit dan TIDAK
//   menghapus catatan keuangan asli (Req 13.5). eventKey unik membuat retry
//   menjadi no-op deterministik, sehingga log tetap append-only.
// - Pure domain test tidak memakai DB/network (Testing Strategy).
// - Testing Strategy: ledger adalah salah satu target 500-run pada nightly CI.

const NUM_RUNS = 500;

// Base clock; the exact instants are irrelevant to the conservation invariants,
// only that hold-release observes a time at/after availableAt.
const SUCCEEDED_AT = new Date("2026-01-01T00:00:00.000Z");
const PAID_AT = new Date("2026-02-01T00:00:00.000Z");

type Terminal =
  | "pending"
  | "available"
  | "reversed_pending"
  | "reversed_available"
  | "locked"
  | "paid";

interface EarningSpec {
  readonly amountIdr: number;
  readonly terminal: Terminal;
  // Repeated events that must be deterministic no-ops (append-only guard).
  readonly successRetries: number;
  readonly releaseRetries: number;
  readonly reversalRetries: number;
}

// Amounts are whole IDR at or above the payout minimum so that any earning is a
// valid single-earning payout; magnitude is irrelevant to zero-sum/projection.
const specArbitrary: fc.Arbitrary<EarningSpec> = fc.record({
  amountIdr: fc.integer({ min: PAYOUT_MINIMUM_IDR, max: 10_000_000 }),
  terminal: fc.constantFrom<Terminal>(
    "pending",
    "available",
    "reversed_pending",
    "reversed_available",
    "locked",
    "paid",
  ),
  successRetries: fc.integer({ min: 0, max: 2 }),
  releaseRetries: fc.integer({ min: 0, max: 2 }),
  reversalRetries: fc.integer({ min: 0, max: 2 }),
});

const scenarioArbitrary = fc.array(specArbitrary, {
  minLength: 1,
  maxLength: 8,
});

function emptyExpected(): Record<LedgerBucket, number> {
  const balances = {} as Record<LedgerBucket, number>;
  for (const bucket of LEDGER_BUCKETS) {
    balances[bucket] = 0;
  }
  return balances;
}

describe("Property 22: Ledger konservatif dan append-only", () => {
  it("keeps every transaction zero-sum, projection == SUM bucket, and the log append-only across balanced/reversal event sequences", () => {
    fc.assert(
      fc.property(scenarioArbitrary, (specs) => {
        // The append-only ledger log and per-append immutability snapshots.
        const log: LedgerTransaction[] = [];
        const snapshots: string[] = [];
        // Projection balances derived independently from Earning/Payout status.
        const expected = emptyExpected();

        // Append a transaction while enforcing zero-sum + append-only immutability:
        // the new transaction is frozen and none of the previously recorded
        // transactions may have changed.
        function appendTx(tx: LedgerTransaction): void {
          const sum = tx.entries.reduce((t, e) => t + e.amountIdrSigned, 0);
          expect(sum).toBe(0);
          expect(tx.entries.length).toBeGreaterThanOrEqual(2);
          expect(Object.isFrozen(tx)).toBe(true);
          expect(Object.isFrozen(tx.entries)).toBe(true);
          for (let k = 0; k < log.length; k++) {
            expect(JSON.stringify(log[k])).toBe(snapshots[k]);
          }
          log.push(tx);
          snapshots.push(JSON.stringify(tx));
        }

        specs.forEach((spec, i) => {
          const earningId = `earn-${i}`;
          const orderId = `order-${i}`;
          const payoutId = `payout-${i}`;
          const amount = spec.amountIdr;

          // --- Order success: payable -A, pending +A (Req 13.1). ---
          const success = decideEarningOnSuccess({
            earningId,
            orderId,
            payoutIdr: amount,
            succeededAt: SUCCEEDED_AT,
            earningExistsForOrder: false,
          });
          expect(success.kind).toBe("create");
          if (success.kind !== "create") return;
          appendTx(success.transaction);
          let earning = success.earning; // pending
          // payable is touched exactly once and never deleted afterwards.
          expected.platform_partner_payable -= amount;

          // Retried success events are deterministic no-ops: no new transaction.
          for (let r = 0; r < spec.successRetries; r++) {
            const before = log.length;
            const retry = decideEarningOnSuccess({
              earningId,
              orderId,
              payoutIdr: amount,
              succeededAt: SUCCEEDED_AT,
              earningExistsForOrder: true,
            });
            expect(retry.kind).toBe("no_change");
            expect(log.length).toBe(before);
          }

          const needsRelease =
            spec.terminal === "available" ||
            spec.terminal === "reversed_available" ||
            spec.terminal === "locked" ||
            spec.terminal === "paid";

          if (needsRelease) {
            const releaseNow = new Date(earning.availableAt.getTime() + 1);
            const release = decideHoldRelease({
              earning,
              now: releaseNow,
              hasActiveDispute: false,
            });
            expect(release.kind).toBe("release");
            if (release.kind !== "release") return;
            appendTx(release.transaction);
            earning = { ...earning, status: "available" };

            for (let r = 0; r < spec.releaseRetries; r++) {
              const before = log.length;
              const retry = decideHoldRelease({
                earning,
                now: releaseNow,
                hasActiveDispute: false,
              });
              expect(retry.kind).toBe("no_change");
              expect(log.length).toBe(before);
            }
          }

          if (spec.terminal === "pending") {
            expected.partner_pending += amount;
          } else if (spec.terminal === "available") {
            expected.partner_available += amount;
          } else if (
            spec.terminal === "reversed_pending" ||
            spec.terminal === "reversed_available"
          ) {
            // Reversal APPENDS a compensating transaction; the original success
            // transaction is untouched (Req 13.5).
            const reversal = decideEarningReversal({ earning, reason: "refund" });
            expect(reversal.kind).toBe("reverse");
            if (reversal.kind !== "reverse") return;
            appendTx(reversal.transaction);
            earning = { ...earning, status: "reversed" };
            expected.partner_reversed += amount;

            for (let r = 0; r < spec.reversalRetries; r++) {
              const before = log.length;
              const retry = decideEarningReversal({ earning, reason: "refund" });
              expect(retry.kind).toBe("no_change");
              expect(log.length).toBe(before);
            }
          } else {
            // locked or paid: request payout locks the WHOLE earning.
            const lock = decideRequestPayout({ payoutId, earnings: [earning] });
            expect(lock.kind).toBe("lock");
            if (lock.kind !== "lock") return;
            appendTx(lock.transaction);
            earning = { ...earning, status: "requested" };

            if (spec.terminal === "locked") {
              expected.partner_payout_locked += amount;
            } else {
              // requested -> approved -> processing -> paid.
              let payout: PayoutState = {
                id: payoutId,
                status: "requested",
                amountIdr: lock.amountIdr,
                allocations: lock.allocations,
                paymentReference: null,
              };

              const approve = decidePayoutTransition(payout, { type: "approve" });
              expect(approve.kind).toBe("apply");
              if (approve.kind !== "apply") return;
              expect(approve.transaction).toBeNull(); // workflow-only, no ledger effect
              payout = { ...payout, status: "approved" };

              const process = decidePayoutTransition(payout, { type: "process" });
              expect(process.kind).toBe("apply");
              if (process.kind !== "apply") return;
              expect(process.transaction).toBeNull();
              payout = { ...payout, status: "processing" };

              const paid = decidePayoutTransition(payout, {
                type: "markPaid",
                paymentReference: `TRX-${i}`,
                paidAt: PAID_AT,
                actorRef: "admin-1",
              });
              expect(paid.kind).toBe("apply");
              if (paid.kind !== "apply" || paid.transaction === null) return;
              appendTx(paid.transaction);
              expected.partner_paid += amount;
            }
          }
        });

        // (a) Every LedgerTransaction is individually zero-sum.
        for (const tx of log) {
          expect(tx.entries.reduce((t, e) => t + e.amountIdrSigned, 0)).toBe(0);
        }

        // (b) Projection saldo == SUM bucket ledger (Req 13.6).
        const ledgerBalances = computeBalancesFromTransactions(log);
        for (const bucket of LEDGER_BUCKETS) {
          expect(ledgerBalances[bucket]).toBe(expected[bucket]);
        }

        // (c) The ledger is globally conservative: all buckets sum to zero.
        expect(isLedgerBalanced(ledgerBalances)).toBe(true);

        // (d) Append-only: nothing was mutated or removed (Req 13.5).
        expect(log.length).toBe(snapshots.length);
        for (let k = 0; k < log.length; k++) {
          expect(JSON.stringify(log[k])).toBe(snapshots[k]);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
