import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  matchSmsToActiveOrder,
  type SmsOrderCandidate,
  type SmsOrderMatch,
} from "@domain/sms-matching-otp";

// Feature: partner-platform, Property 16: Matching SMS tidak pernah ambigu
//
// For all nomor dan himpunan order aktif, SMS dikaitkan hanya jika tepat satu
// order `waiting_sms` cocok; cardinality nol atau lebih dari satu menyimpan
// status audit yang tepat dan tidak mengisi OTP order mana pun.
//
// **Validates: Requirements 11.4, 11.5**
//
// Design references:
// - Requirement 11.4: sebuah nomor dengan TEPAT SATU Partner_Order aktif yang
//   sesuai memicu ekstraksi OTP dan pengaitan SMS ke order tersebut.
// - Requirement 11.5: jika tidak ada order aktif ATAU terdapat kondisi ambigu,
//   SMS hanya disimpan untuk audit tanpa mengirim OTP ke buyer yang salah — jadi
//   tidak ada order yang boleh "dipilih" untuk diisi OTP.
// - `matchSmsToActiveOrder` (pure domain, task 5.4) adalah satu-satunya arbiter
//   kardinalitas: ia menyaring order pada nomor yang sama, berstatus
//   `waiting_sms`, dengan window `[start,end]` terhingga & valid yang memuat
//   waktu penerimaan, lalu memetakan 0 → `unmatched`, 1 → `matched`,
//   >1 → `ambiguous`.

const NUM_RUNS = 100;

// A tiny pool of number IDs so generated orders frequently share (or differ
// from) the SMS's target number, letting the same array drift across the zero /
// one / many active-order cardinalities the task asks us to exercise.
const numberIdArbitrary = fc.constantFrom("num-A", "num-B", "num-C");

// The full order lifecycle: only `waiting_sms` is eligible to receive an SMS,
// so every other status must be treated as a non-candidate no matter how well
// its window lines up.
const statusArbitrary = fc.constantFrom(
  "created",
  "reserved",
  "waiting_sms",
  "success",
  "cancelled",
  "timeout",
  "failed",
);

// Window/clock values are mostly finite integers packed into a narrow band so
// windows regularly straddle, contain, or miss the receive instant. A minority
// of non-finite values probes the finiteness guard (an SMS whose clock or an
// order whose window is NaN/±Infinity must never match).
const timeArbitrary = fc.oneof(
  { weight: 9, arbitrary: fc.integer({ min: 0, max: 20 }) },
  { weight: 1, arbitrary: fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY) },
);

interface OrderSpec {
  readonly numberId: string;
  readonly serviceCode: string;
  readonly status: string;
  readonly windowStartsAtMs: number;
  readonly windowEndsAtMs: number;
}

const orderSpecArbitrary: fc.Arbitrary<OrderSpec> = fc.record({
  numberId: numberIdArbitrary,
  serviceCode: fc.constantFrom("whatsapp", "telegram", "google", "facebook"),
  status: statusArbitrary,
  windowStartsAtMs: timeArbitrary,
  windowEndsAtMs: timeArbitrary,
});

// Assign IDs by index so every candidate ID is unique; this keeps
// `candidateOrderIds` free of accidental duplicates and lets us compare id sets
// exactly against an independent reference filter.
function withIds(specs: readonly OrderSpec[]): readonly SmsOrderCandidate[] {
  return specs.map((spec, index) =>
    Object.freeze({ id: `order-${index}`, ...spec }),
  );
}

// Independent reference for the acceptance criteria (requirement 11.4): an order
// is a genuine match iff it belongs to the SMS's number, is awaiting an SMS, and
// the finite receive instant falls inside its finite, non-inverted window.
function isTrueMatch(
  order: SmsOrderCandidate,
  numberId: string,
  receivedAtMs: number,
): boolean {
  return (
    order.numberId === numberId &&
    order.status === "waiting_sms" &&
    Number.isFinite(receivedAtMs) &&
    Number.isFinite(order.windowStartsAtMs) &&
    Number.isFinite(order.windowEndsAtMs) &&
    order.windowStartsAtMs <= order.windowEndsAtMs &&
    receivedAtMs >= order.windowStartsAtMs &&
    receivedAtMs <= order.windowEndsAtMs
  );
}

// Only a `matched` outcome names an order; unmatched/ambiguous must expose no
// order to fill an OTP into (requirement 11.5).
function selectsAnOrder(result: SmsOrderMatch): boolean {
  return "orderId" in result;
}

describe("Property 16: matching SMS tidak pernah ambigu", () => {
  it("associates an SMS to an order only when exactly one waiting_sms order matches", () => {
    fc.assert(
      fc.property(
        numberIdArbitrary,
        timeArbitrary,
        fc.array(orderSpecArbitrary, { maxLength: 6 }),
        (numberId, receivedAtMs, specs) => {
          const orders = withIds(specs);
          const result = matchSmsToActiveOrder({ numberId, receivedAtMs, orders });

          const trueMatches = orders.filter((order) =>
            isTrueMatch(order, numberId, receivedAtMs),
          );

          // The domain's cardinality classification must agree exactly with the
          // independent reference filter (requirements 11.4 & 11.5).
          if (trueMatches.length === 0) {
            expect(result.status).toBe("unmatched");
            if (result.status === "unmatched") {
              expect(result.candidateOrderIds).toEqual([]);
            }
            // No active order → nothing selected, only audit (11.5).
            expect(selectsAnOrder(result)).toBe(false);
          } else if (trueMatches.length === 1) {
            expect(result.status).toBe("matched");
            if (result.status === "matched") {
              expect(result.orderId).toBe(trueMatches[0].id);
              expect(result.serviceCode).toBe(trueMatches[0].serviceCode);
            }
          } else {
            expect(result.status).toBe("ambiguous");
            if (result.status === "ambiguous") {
              // The recorded candidates are exactly the matching order IDs,
              // sorted, so the audit trail is precise (11.5).
              const expectedIds = trueMatches.map(({ id }) => id).sort();
              expect(result.candidateOrderIds).toEqual(expectedIds);
            }
            // Ambiguity selects nothing to fill an OTP into (11.5).
            expect(selectsAnOrder(result)).toBe(false);
          }

          // Core invariant, stated both ways: an SMS is associated to an order
          // (an OTP target is chosen) IFF exactly one waiting_sms order matched.
          expect(selectsAnOrder(result)).toBe(trueMatches.length === 1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
