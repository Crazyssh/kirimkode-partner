import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  createLedgerTransaction,
  type LedgerTransaction,
  orderSuccessEventKey,
} from "@domain/task-5-6";
import {
  decideRetention,
  isProtectedEvidence,
  reconcile,
  RETENTION_CATEGORIES,
  type RetentionCategory,
  type RetentionConfig,
  retentionWindowMs,
} from "@domain/task-5-7";

// Feature: partner-platform, Property 30: Retention meredaksi data sensitif tanpa merusak bukti finansial
//
// For all dataset dan waktu retention, keputusan retention HANYA meredaksi/
// menghapus data sensitif setelah jendelanya elapsed — raw SMS setelah 7 hari,
// OTP 24 jam setelah terminal, heartbeat setelah 30 hari, dan security log
// setelah 90 hari (sensitif => `redact`/`delete` iff `age >= window`, selain itu
// `retain`) — sedangkan audit serta ledger/payout SELALU dipertahankan sebagai
// bukti terproteksi berapa pun umurnya (termasuk < 7 tahun maupun jauh melewati
// 7 tahun). Karena keputusan retention tidak pernah menghapus/mengubah baris
// finansial/audit dan bersifat read-only, seluruh invariant finansial pada
// dataset yang konsisten tetap utuh (rekonsiliasi tetap consistent).
//
// **Validates: Requirements 19.4, 19.5**
//
// Design references:
// - Retensi: SMS mentah 7 hari; OTP sampai 24 jam setelah terminal; metadata
//   heartbeat 30 hari; security log 90 hari; audit dan ledger/payout 7 tahun
//   (Keputusan Final MVP "Retensi", Req 19.4).
// - "WHEN masa retention data sensitif berakhir, THE Partner_Platform SHALL
//   menghapus atau meredaksi data sensitif tanpa merusak catatan finansial dan
//   audit yang wajib dipertahankan" (Req 19.5) — audit/ledger/payout adalah
//   bukti terproteksi (`decideRetention` => `retain`, `protectedEvidence=true`).
// - Job retention tidak menghapus ciphertext tanpa menjaga metadata audit dan
//   perbaikan finansial hanya via compensating transaction — reconciler bersifat
//   read-only (Design §"Retention/key rotation gagal", Req 20.6).
// - Pure domain test tidak memakai DB/network (Testing Strategy).
// - Property 30 bukan bagian set 500-run (parser/pricing/state machine/ledger);
//   memakai minimum numRuns per Testing Strategy.

const NUM_RUNS = 300;

// A "now" comfortably beyond a century so that even a ~10-year age keeps the
// derived reference instant a valid non-negative epoch.
const NOW_EPOCH_MS = 100 * 365 * 24 * 60 * 60 * 1000; // ~3.15e12, still a safe int
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const SEVEN_YEARS_MS = 7 * 365 * 24 * 60 * 60 * 1000;

// Sensitive categories are disposed of once their window elapses; the disposal
// mode is fixed by the domain (SMS/OTP are redacted, operational logs deleted).
const EXPECTED_DISPOSAL: Readonly<Record<RetentionCategory, "redact" | "delete" | "protect">> =
  {
    sms_raw: "redact",
    otp: "redact",
    heartbeat_metadata: "delete",
    security_log: "delete",
    audit: "protect",
    ledger: "protect",
    payout: "protect",
  };

// Windows span tiny values (so `window +/- offset` lands on realistic
// boundaries) up to the shipped multi-year defaults.
const windowArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 10 }) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 604_800_000 }) }, // up to ~7 days
  { weight: 1, arbitrary: fc.constantFrom(SEVEN_YEARS_MS, 90 * 24 * 60 * 60 * 1000) },
);

const retentionConfigArb: fc.Arbitrary<RetentionConfig> = fc.record({
  smsRawMs: windowArb,
  otpAfterTerminalMs: windowArb,
  heartbeatMetadataMs: windowArb,
  securityLogMs: windowArb,
  auditMs: windowArb,
  ledgerPayoutMs: windowArb,
});

// Offsets deliberately cluster around each category boundary (`-2..+2`) and also
// include a fresh record (0 age) and a record aged ~10 years to prove protected
// evidence survives even well beyond every window.
const offsetArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(-2, -1, 0, 1, 2) },
  { weight: 2, arbitrary: fc.integer({ min: -5, max: 5 }) },
  { weight: 2, arbitrary: fc.constant(TEN_YEARS_MS) },
);

interface RecordSpec {
  readonly category: RetentionCategory;
  readonly offsetMs: number;
}

const recordSpecArb: fc.Arbitrary<RecordSpec> = fc.record({
  category: fc.constantFrom(...RETENTION_CATEGORIES),
  offsetMs: offsetArb,
});

interface Scenario {
  readonly retention: RetentionConfig;
  readonly records: readonly RecordSpec[];
  // Amount backing a consistent financial dataset used to confirm that the
  // retention decision leaves financial invariants intact (Req 19.5).
  readonly financialAmountIdr: number;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  retention: retentionConfigArb,
  records: fc.array(recordSpecArb, { minLength: 1, maxLength: 20 }),
  financialAmountIdr: fc.integer({ min: 1, max: 5_000 }),
});

function consistentSuccessLedger(amountIdr: number): LedgerTransaction {
  // A well-formed, zero-sum order-success transaction: payable -> pending.
  return createLedgerTransaction({
    eventType: "order-success",
    eventKey: orderSuccessEventKey("order-1"),
    referenceType: "order",
    referenceId: "order-1",
    entries: [
      { bucket: "platform_partner_payable", amountIdrSigned: -amountIdr },
      { bucket: "partner_pending", amountIdrSigned: amountIdr },
    ],
  });
}

describe("Property 30: Retention meredaksi data sensitif tanpa merusak bukti finansial", () => {
  it("redacts/deletes sensitive data only past its window while always preserving protected financial/audit evidence and financial invariants", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        for (const spec of scenario.records) {
          const window = retentionWindowMs(spec.category, scenario.retention);
          // Age never goes negative; reference stays a valid non-negative epoch.
          const ageMs = Math.max(0, window + spec.offsetMs);
          const referenceEpochMs = NOW_EPOCH_MS - ageMs;

          const decision = decideRetention({
            category: spec.category,
            referenceEpochMs,
            nowEpochMs: NOW_EPOCH_MS,
            retention: scenario.retention,
          });

          // The decision echoes its category and reports the exact age.
          expect(decision.category).toBe(spec.category);
          expect(decision.ageMs).toBe(ageMs);

          const disposal = EXPECTED_DISPOSAL[spec.category];

          if (disposal === "protect") {
            // Req 19.5: audit/ledger/payout are protected evidence and are
            // retained regardless of age — including well past every window
            // (offsets of ~10 years) and the < 7-year case.
            expect(decision.protectedEvidence).toBe(true);
            expect(isProtectedEvidence(spec.category)).toBe(true);
            expect(decision.action).toBe("retain");
          } else {
            // Req 19.4: sensitive data is disposed of exactly at/after its
            // window boundary and never before it.
            expect(decision.protectedEvidence).toBe(false);
            expect(isProtectedEvidence(spec.category)).toBe(false);
            const elapsed = ageMs >= window;
            expect(decision.action).toBe(elapsed ? disposal : "retain");
          }
        }

        // Req 19.5: because retention decisions are read-only and never remove
        // protected financial/audit rows, a consistent financial dataset stays
        // fully consistent — no invariant is disturbed by retention.
        const amount = scenario.financialAmountIdr;
        const report = reconcile({
          ledgerTransactions: [consistentSuccessLedger(amount)],
          earnings: [
            { id: "earn-1", orderId: "order-1", amountIdr: amount, status: "pending" },
          ],
          orderSnapshots: [{ orderId: "order-1", payoutIdr: amount }],
          payouts: [],
          projectionBalances: {
            platform_partner_payable: -amount,
            partner_pending: amount,
          },
        });
        expect(report.consistent).toBe(true);
        expect(report.issues).toHaveLength(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("keeps protected financial/audit evidence at exactly the 7-year boundary", () => {
    // Anchor for Req 19.5: even a ledger/payout/audit record aged precisely at
    // the 7-year window (and one year beyond) is still retained.
    for (const category of ["audit", "ledger", "payout"] as const) {
      for (const ageMs of [SEVEN_YEARS_MS, SEVEN_YEARS_MS + TEN_YEARS_MS]) {
        const decision = decideRetention({
          category,
          referenceEpochMs: NOW_EPOCH_MS - ageMs,
          nowEpochMs: NOW_EPOCH_MS,
          retention: {
            smsRawMs: 7 * 24 * 60 * 60 * 1000,
            otpAfterTerminalMs: 24 * 60 * 60 * 1000,
            heartbeatMetadataMs: 30 * 24 * 60 * 60 * 1000,
            securityLogMs: 90 * 24 * 60 * 60 * 1000,
            auditMs: SEVEN_YEARS_MS,
            ledgerPayoutMs: SEVEN_YEARS_MS,
          },
        });
        expect(decision.action).toBe("retain");
        expect(decision.protectedEvidence).toBe(true);
      }
    }
  });
});
