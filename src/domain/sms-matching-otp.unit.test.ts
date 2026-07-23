import { describe, expect, it } from "vitest";

import {
  decideSmsIngress,
  matchSmsToActiveOrder,
  parseServiceOtp,
  type SmsIngressPolicyInput,
  type SmsOrderCandidate,
} from "./sms-matching-otp";

const ingress = (overrides: Partial<SmsIngressPolicyInput> = {}): SmsIngressPolicyInput => ({
  principal: { partnerId: "partner-a", deviceId: "device-a" },
  device: { id: "device-a", partnerId: "partner-a" },
  number: { id: "number-a", partnerId: "partner-a", deviceId: "device-a" },
  messageId: "message-1",
  idempotencyKey: "sms-key-1",
  priorMessages: [],
  ...overrides,
});

// **Validates: Requirements 11.1, 11.3**
describe("Task 5.4 SMS ownership and deduplication policy", () => {
  it("accepts only when the authenticated Device and Number share one Partner", () => {
    expect(decideSmsIngress(ingress())).toEqual({ kind: "accept" });

    expect(decideSmsIngress(ingress({
      number: { id: "number-a", partnerId: "partner-b", deviceId: "device-a" },
    }))).toEqual({ kind: "reject", reason: "ownership_mismatch" });

    expect(decideSmsIngress(ingress({
      principal: { partnerId: "partner-a", deviceId: "device-b" },
    }))).toEqual({ kind: "reject", reason: "ownership_mismatch" });
  });

  it("deduplicates message and idempotency identifiers within the Device scope", () => {
    const priorMessages = [{
      deviceId: "device-a", messageId: "message-1", idempotencyKey: "sms-key-old",
    }];
    expect(decideSmsIngress(ingress({ priorMessages }))).toEqual({
      kind: "duplicate", matchedBy: "message_id",
    });
    expect(decideSmsIngress(ingress({
      messageId: "message-new", idempotencyKey: "sms-key-old", priorMessages,
    }))).toEqual({ kind: "duplicate", matchedBy: "idempotency_key" });
  });

  it("does not treat another Device's identifiers as duplicates", () => {
    expect(decideSmsIngress(ingress({
      priorMessages: [{
        deviceId: "device-b", messageId: "message-1", idempotencyKey: "sms-key-1",
      }],
    }))).toEqual({ kind: "accept" });
  });
});
const waitingOrder = (overrides: Partial<SmsOrderCandidate> = {}): SmsOrderCandidate => ({
  id: "order-a",
  numberId: "number-a",
  serviceCode: "wa",
  status: "waiting_sms",
  windowStartsAtMs: 1_000,
  windowEndsAtMs: 2_000,
  ...overrides,
});

// **Validates: Requirements 11.4, 11.5**
describe("Task 5.4 exact-one active order matcher", () => {
  it("matches exactly one waiting order for the number within the inclusive window", () => {
    expect(matchSmsToActiveOrder({
      numberId: "number-a", receivedAtMs: 1_000, orders: [waitingOrder()],
    })).toEqual({ status: "matched", orderId: "order-a", serviceCode: "wa" });
    expect(matchSmsToActiveOrder({
      numberId: "number-a", receivedAtMs: 2_000, orders: [waitingOrder()],
    })).toEqual({ status: "matched", orderId: "order-a", serviceCode: "wa" });
  });

  it("reports unmatched when status, number, time, or window is ineligible", () => {
    const orders = [
      waitingOrder({ id: "wrong-number", numberId: "number-b" }),
      waitingOrder({ id: "terminal", status: "success" }),
      waitingOrder({ id: "future", windowStartsAtMs: 2_001 }),
      waitingOrder({ id: "invalid-window", windowStartsAtMs: 3_000, windowEndsAtMs: 2_000 }),
    ];
    expect(matchSmsToActiveOrder({
      numberId: "number-a", receivedAtMs: 2_000, orders,
    })).toEqual({ status: "unmatched", candidateOrderIds: [] });
  });

  it("fails closed and returns deterministic audit IDs when multiple orders match", () => {
    const result = matchSmsToActiveOrder({
      numberId: "number-a",
      receivedAtMs: 1_500,
      orders: [waitingOrder({ id: "order-z" }), waitingOrder({ id: "order-a" })],
    });
    expect(result).toEqual({
      status: "ambiguous", candidateOrderIds: ["order-a", "order-z"],
    });
  });
});
// **Validates: Requirements 11.7**
describe("Task 5.4 WhatsApp OTP parser", () => {
  it("extracts one intact ASCII six-digit OTP with default or configured Unicode keywords", () => {
    expect(parseServiceOtp("wa", "🔐 Kode WhatsApp Anda: 482901.")).toEqual({
      status: "matched", otp: "482901",
    });
    expect(parseServiceOtp("wa", "Votre vérification : 654321 ✅", {
      keywords: ["vérification"],
    })).toEqual({ status: "matched", otp: "654321" });
  });

  it("requires a whole configured keyword", () => {
    expect(parseServiceOtp("wa", "Gunakan 123456 untuk masuk.")).toEqual({
      status: "rejected", reason: "missing_keyword",
    });
    expect(parseServiceOtp("wa", "xWhatsAppx 123456")).toEqual({
      status: "rejected", reason: "missing_keyword",
    });
  });

  it("rejects Unicode digits and candidates embedded in longer numbers", () => {
    for (const body of [
      "WhatsApp code １２３４５６",
      "WhatsApp code ١٢٣٤٥٦",
      "WhatsApp code 1234567",
      "WhatsApp code ١123456",
      "WhatsApp verification +6281234567890",
    ]) {
      expect(parseServiceOtp("wa", body)).toEqual({
        status: "rejected", reason: "no_candidate",
      });
    }
  });

  it("ignores long phone and separated date decoys beside one valid candidate", () => {
    expect(parseServiceOtp(
      "wa",
      "WhatsApp verification code 731904; phone +6281234567890; date 2026-03-01.",
    )).toEqual({ status: "matched", otp: "731904" });
  });

  it("rejects a sole labeled compact phone or date decoy", () => {
    expect(parseServiceOtp("wa", "WhatsApp verification, nomor: 081234")).toEqual({
      status: "rejected", reason: "decoy_candidate",
    });
    expect(parseServiceOtp("wa", "WhatsApp verification tanggal 240226")).toEqual({
      status: "rejected", reason: "decoy_candidate",
    });
  });
  it("rejects multiple candidates even when they repeat the same value", () => {
    expect(parseServiceOtp("wa", "WhatsApp code 123456, backup 654321")).toEqual({
      status: "rejected", reason: "ambiguous_candidates",
    });
    expect(parseServiceOtp("wa", "WhatsApp code 123456 then 123456")).toEqual({
      status: "rejected", reason: "ambiguous_candidates",
    });
  });

  it("does not use a generic fallback for other services or OTP lengths", () => {
    expect(parseServiceOtp("telegram", "WhatsApp code 123456")).toEqual({
      status: "rejected", reason: "unsupported_service",
    });
    expect(parseServiceOtp("wa", "WhatsApp code 1234")).toEqual({
      status: "rejected", reason: "no_candidate",
    });
    expect(parseServiceOtp("wa", "WhatsApp code 12345678")).toEqual({
      status: "rejected", reason: "no_candidate",
    });
  });
});
