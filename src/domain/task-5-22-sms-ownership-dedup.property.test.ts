import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  decideSmsIngress,
  type SmsIngressPolicyInput,
} from "@domain/sms-matching-otp";

// Feature: partner-platform, Property 15: Ownership dan deduplikasi SMS
//
// For all SMS agent, request hanya dapat diproses bila Device dan Number berada
// pada Partner yang sama; pengulangan `(deviceId,messageId)` atau idempotency
// key menghasilkan maksimal satu SMS record dan satu efek pada order.
//
// Validates: Requirements 11.1, 11.3
//
// Design references:
// - (11.1) Dalam transaksi, service memvalidasi ownership device-number sebelum
//   menyimpan SMS (Components §8 SMS Matching dan OTP). `decideSmsIngress`
//   menolak (`ownership_mismatch`) bila principal tidak memiliki device atau
//   device tidak memiliki number pada partner yang sama.
// - (11.3) `messageId` unik per device dan `Idempotency-Key` mencegah duplicate
//   processing; `PartnerSms` unique `(deviceId, messageId)` (Data Models).
//   Ingress yang mengulang salah satu key mengembalikan `duplicate` sehingga
//   tidak menambah SMS record kedua (efek downstream ke order tidak digandakan).
// - Pure domain test tidak memakai DB/network; store SMS diwakili in-memory
//   fake (Testing Strategy). Efek "SMS record" = satu accept yang dipersist.
// - Property 15 bukan bagian target 500-run (parser/pricing/state-machine/
//   ledger), sehingga numRuns minimum 100.

const NUM_RUNS = 100;

// Small identifier pools sehingga retry (pengulangan) dan mismatch ownership
// benar-benar sering muncul di dalam satu sekuens.
const PARTNER_IDS = ["p0", "p1"] as const;
const DEVICE_IDS = ["d0", "d1", "d2"] as const;
const NUMBER_IDS = ["n0", "n1", "n2"] as const;
const MESSAGE_IDS = ["m0", "m1"] as const;
const IDEMPOTENCY_KEYS = ["k0", "k1"] as const;

interface AttemptSpec {
  // Principal (device credential) yang mengklaim request.
  readonly principalPartnerId: string;
  readonly principalDeviceId: string;
  // Device yang di-load untuk request.
  readonly deviceId: string;
  readonly devicePartnerId: string;
  // Number yang dirujuk SMS.
  readonly numberId: string;
  readonly numberPartnerId: string;
  readonly numberDeviceId: string;
  // Deduplication keys.
  readonly messageId: string;
  readonly idempotencyKey: string;
}

const attemptArbitrary: fc.Arbitrary<AttemptSpec> = fc.record({
  principalPartnerId: fc.constantFrom(...PARTNER_IDS),
  principalDeviceId: fc.constantFrom(...DEVICE_IDS),
  deviceId: fc.constantFrom(...DEVICE_IDS),
  devicePartnerId: fc.constantFrom(...PARTNER_IDS),
  numberId: fc.constantFrom(...NUMBER_IDS),
  numberPartnerId: fc.constantFrom(...PARTNER_IDS),
  numberDeviceId: fc.constantFrom(...DEVICE_IDS),
  messageId: fc.constantFrom(...MESSAGE_IDS),
  idempotencyKey: fc.constantFrom(...IDEMPOTENCY_KEYS),
});

// Sekuens ingress; retry eksplisit diselipkan agar pengulangan persis dari
// attempt sebelumnya benar-benar diuji, bukan hanya collision acak.
const scenarioArbitrary = fc
  .array(attemptArbitrary, { minLength: 1, maxLength: 16 })
  .chain((base) =>
    fc
      .array(fc.nat({ max: Math.max(0, base.length - 1) }), { maxLength: 6 })
      .map((retryIndices) => {
        const sequence = [...base];
        for (const index of retryIndices) {
          // Ulang attempt yang sudah ada (retry payload identik).
          sequence.push(base[index]);
        }
        return sequence;
      }),
  );

interface StoredSms {
  readonly deviceId: string;
  readonly messageId: string;
  readonly idempotencyKey: string;
}

describe("Property 15: Ownership dan deduplikasi SMS", () => {
  it("hanya memproses SMS dengan ownership konsisten dan menghasilkan maksimal satu record per (device,messageId)/(device,key)", () => {
    fc.assert(
      fc.property(scenarioArbitrary, (attempts) => {
        // Persisted SMS records (efek). Hanya accept yang menambah record,
        // sama seperti transaksi yang menyimpan `PartnerSms`.
        const store: StoredSms[] = [];
        const accepted: StoredSms[] = [];

        for (const spec of attempts) {
          const input: SmsIngressPolicyInput = {
            principal: {
              partnerId: spec.principalPartnerId,
              deviceId: spec.principalDeviceId,
            },
            device: { id: spec.deviceId, partnerId: spec.devicePartnerId },
            number: {
              id: spec.numberId,
              partnerId: spec.numberPartnerId,
              deviceId: spec.numberDeviceId,
            },
            messageId: spec.messageId,
            idempotencyKey: spec.idempotencyKey,
            priorMessages: store,
          };

          // Independent ownership oracle (Components §8, Requirement 11.1):
          // principal harus memiliki device, dan device harus memiliki number,
          // seluruhnya pada partner yang sama.
          const ownsDevice =
            spec.principalDeviceId === spec.deviceId &&
            spec.principalPartnerId === spec.devicePartnerId;
          const ownsNumber =
            spec.numberDeviceId === spec.deviceId &&
            spec.numberPartnerId === spec.devicePartnerId;
          const owned = ownsDevice && ownsNumber;

          // (11.3, purity) Keputusan tidak boleh memutasi store SMS existing.
          const storeBefore = structuredClone(store);
          const decision = decideSmsIngress(input);
          expect(store).toStrictEqual(storeBefore);

          if (!owned) {
            // (11.1) Fail-closed: ownership mismatch selalu ditolak, tidak
            // pernah menghasilkan record/efek.
            expect(decision).toEqual({ kind: "reject", reason: "ownership_mismatch" });
            continue;
          }

          // Dedup dihitung hanya terhadap record pada device yang sama.
          const sameDevice = store.filter((r) => r.deviceId === spec.deviceId);
          const dupMessage = sameDevice.some((r) => r.messageId === spec.messageId);
          const dupKey = sameDevice.some((r) => r.idempotencyKey === spec.idempotencyKey);

          if (dupMessage) {
            // (11.3) Pengulangan messageId => duplicate, tanpa record kedua.
            expect(decision).toEqual({ kind: "duplicate", matchedBy: "message_id" });
          } else if (dupKey) {
            // (11.3) Pengulangan idempotency key => duplicate, tanpa record kedua.
            expect(decision).toEqual({ kind: "duplicate", matchedBy: "idempotency_key" });
          } else {
            // Novel + owned => accept, dan satu record dipersist.
            expect(decision).toEqual({ kind: "accept" });
            const record: StoredSms = {
              deviceId: spec.deviceId,
              messageId: spec.messageId,
              idempotencyKey: spec.idempotencyKey,
            };
            store.push(record);
            accepted.push(record);
          }
        }

        // (11.3) Invariant global "maksimal satu efek": tidak ada dua SMS record
        // ter-accept yang berbagi (deviceId, messageId) atau (deviceId, key).
        const messageKeys = accepted.map((r) => `${r.deviceId}\u0000${r.messageId}`);
        expect(new Set(messageKeys).size).toBe(messageKeys.length);

        const idempotencyKeys = accepted.map((r) => `${r.deviceId}\u0000${r.idempotencyKey}`);
        expect(new Set(idempotencyKeys).size).toBe(idempotencyKeys.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
