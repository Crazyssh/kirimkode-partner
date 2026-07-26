import { describe, expect, it } from "vitest";

import {
  decideSmsIngress,
  foreignSenderMarkersForService,
  isForeignServiceSender,
  matchSmsToActiveOrder,
  parseServiceOtp,
  SERVICE_OTP_REGISTRY,
  THIRD_PARTY_SENDER_MARKERS,
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
  completedAtMs: null,
  ...overrides,
});

// **Validates: Requirements 11.4, 11.5**
describe("Task 5.4 exact-one active order matcher", () => {
  it("matches exactly one waiting order for the number within the inclusive window", () => {
    // `mode: "first"` marks the extract that settles the order and creates its
    // money, as opposed to a repeat that only refreshes the OTP.
    expect(matchSmsToActiveOrder({
      numberId: "number-a", receivedAtMs: 1_000, orders: [waitingOrder()],
    })).toEqual({ status: "matched", orderId: "order-a", serviceCode: "wa", mode: "first" });
    expect(matchSmsToActiveOrder({
      numberId: "number-a", receivedAtMs: 2_000, orders: [waitingOrder()],
    })).toEqual({ status: "matched", orderId: "order-a", serviceCode: "wa", mode: "first" });
  });

  it("matches a settled order that is still listening, as a repeat", () => {
    // The order already succeeded but has not released its number hold, so a
    // resent code belongs to it — and must be marked `repeat` so the pipeline
    // refreshes the OTP instead of settling the order (and its money) twice.
    expect(matchSmsToActiveOrder({
      numberId: "number-a",
      receivedAtMs: 1_500,
      orders: [waitingOrder({ status: "success", completedAtMs: null })],
    })).toEqual({ status: "matched", orderId: "order-a", serviceCode: "wa", mode: "repeat" });
  });

  it("stops matching a successful order once its hold was released", () => {
    // `completedAt` stamped means the number went back on sale: a later SMS must
    // never be delivered to this order, even inside its old window.
    expect(matchSmsToActiveOrder({
      numberId: "number-a",
      receivedAtMs: 1_500,
      orders: [waitingOrder({ status: "success", completedAtMs: 1_200 })],
    })).toEqual({ status: "unmatched", candidateOrderIds: [] });
  });

  it("reports unmatched when status, number, time, or window is ineligible", () => {
    const orders = [
      waitingOrder({ id: "wrong-number", numberId: "number-b" }),
      // A settled order whose hold was already released holds nothing.
      waitingOrder({ id: "closed-success", status: "success", completedAtMs: 500 }),
      waitingOrder({ id: "cancelled", status: "cancelled", completedAtMs: null }),
      waitingOrder({ id: "timed-out", status: "timeout", completedAtMs: null }),
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
  it("does not treat a word that merely contains a decoy label as a decoy", () => {
    // `iPhone` ends with `phone`, `update` with `date`, `hotel` with `tel`;
    // none is a standalone phone/date label, so the adjacent OTP is delivered.
    expect(parseServiceOtp("wa", "Kode WhatsApp iPhone 123456")).toEqual({
      status: "matched", otp: "123456",
    });
    expect(parseServiceOtp("wa", "Kode WhatsApp iPhone: 123456")).toEqual({
      status: "matched", otp: "123456",
    });
    expect(parseServiceOtp("wa", "Kode WhatsApp hotel 123456")).toEqual({
      status: "matched", otp: "123456",
    });
    expect(parseServiceOtp("wa", "WhatsApp update code: 123456")).toEqual({
      status: "matched", otp: "123456",
    });
  });

  it("requires the WhatsApp brand word — generic OTP words no longer qualify", () => {
    // Real foreign-service OTPs that DO contain 'kode'/'code'/'verification'
    // plus a six-digit code: without the brand word they must never match.
    expect(parseServiceOtp("wa", "Kode BCA Anda: 482901")).toEqual({
      status: "rejected", reason: "missing_keyword",
    });
    expect(parseServiceOtp("wa", "G-123456 is your Google verification code")).toEqual({
      status: "rejected", reason: "missing_keyword",
    });
    expect(parseServiceOtp("wa", "Verifikasi akun: 482901")).toEqual({
      status: "rejected", reason: "missing_keyword",
    });
  });

  it("rejects a sender that clearly names another service before parsing the body", () => {
    // Even a body that would parse (brand word + one candidate) is refused
    // when the sender belongs to another service.
    const body = "Kode WhatsApp Anda: 718-891";
    for (const sender of ["InfoBCA", "Telegram", "GOOGLE", "Gojek-Info"]) {
      expect(parseServiceOtp("wa", body, { sender })).toEqual({
        status: "rejected", reason: "foreign_sender",
      });
    }
    // Legitimate WhatsApp-route senders pass through.
    for (const sender of ["WhatsApp", "WhatsAppBusiness", "+6289911223344", ""]) {
      expect(parseServiceOtp("wa", body, { sender })).toEqual({
        status: "matched", otp: "718891",
      });
    }
  });

  it("isForeignServiceSender folds case and never flags empty or numeric senders", () => {
    expect(isForeignServiceSender("InfoBCA")).toBe(true);
    expect(isForeignServiceSender("TELEGRAM")).toBe(true);
    expect(isForeignServiceSender("WhatsApp")).toBe(false);
    expect(isForeignServiceSender("+6281234567890")).toBe(false);
    expect(isForeignServiceSender("")).toBe(false);
  });

  it("still rejects a standalone phone/date label immediately before the sole candidate", () => {
    // A genuine whole-word label adjacent to the only candidate is still a decoy.
    expect(parseServiceOtp("wa", "WhatsApp verification phone 123456")).toEqual({
      status: "rejected", reason: "decoy_candidate",
    });
    expect(parseServiceOtp("wa", "WhatsApp verification tel: 123456")).toEqual({
      status: "rejected", reason: "decoy_candidate",
    });
  });

  it("accepts the real WhatsApp dashed wire format and normalizes it to six digits", () => {
    // Verbatim real-world WhatsApp Business verification SMS (code as 718-891).
    const realBusiness = [
      "Akun WhatsApp Business Anda sedang didaftarkan di perangkat baru",
      "",
      "Jangan bagikan kode dengan siapa pun",
      "Kode WhatsApp Business Anda: 718-891",
      "rJbA/XP1K+V",
    ].join("\n");
    expect(parseServiceOtp("wa", realBusiness)).toEqual({ status: "matched", otp: "718891" });
    expect(
      parseServiceOtp("wa", "Your WhatsApp code: 123-456\n\nDon't share this code with others"),
    ).toEqual({ status: "matched", otp: "123456" });
  });

  it("never treats a hyphenated pair inside a longer chain or number as a candidate", () => {
    for (const body of [
      "WhatsApp code hubungi 0812-345-6789", // phone chain: every pair chained
      "WhatsApp code 555-123-4567",
      "WhatsApp code 0718-891", // digit touches the pair on the left
      "WhatsApp code 718-8912", // digit touches the pair on the right
    ]) {
      expect(parseServiceOtp("wa", body)).toEqual({
        status: "rejected", reason: "no_candidate",
      });
    }
    // A real dashed code stays deliverable beside a hyphenated phone decoy.
    expect(
      parseServiceOtp("wa", "WhatsApp code 718-891, phone 0812-345-6789"),
    ).toEqual({ status: "matched", otp: "718891" });
  });

  it("applies the ambiguity and decoy guards to dashed candidates too", () => {
    expect(parseServiceOtp("wa", "WhatsApp code 123-456 backup 654321")).toEqual({
      status: "rejected", reason: "ambiguous_candidates",
    });
    expect(parseServiceOtp("wa", "WhatsApp verification tel: 123-456")).toEqual({
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

// **Validates: Requirements 11.7**
describe("Task 5.4 per-service OTP parser registry", () => {
  it("rejects a service code that is not in the registry", () => {
    // Only the registry's short codes are supported; the spelled-out brand
    // names and unknown codes stay unsupported so a mis-seeded order can never
    // fall through to some other service's rules.
    for (const serviceCode of ["telegram", "instagram", "google", "whatsapp", "sx", "", "toString"]) {
      expect(parseServiceOtp(serviceCode, "WhatsApp code 123456")).toEqual({
        status: "rejected", reason: "unsupported_service",
      });
    }
  });

  it("derives each service's foreign markers so its own brand is never foreign", () => {
    // The safety property: a sender named after the service being parsed is the
    // legitimate sender. Derived from the registry, so the two lists cannot drift.
    for (const serviceCode of Object.keys(SERVICE_OTP_REGISTRY)) {
      const markers = foreignSenderMarkersForService(serviceCode);
      const ownMarkers = SERVICE_OTP_REGISTRY[serviceCode as keyof typeof SERVICE_OTP_REGISTRY]
        .senderBrandMarkers;
      for (const ownMarker of ownMarkers) {
        expect(markers).not.toContain(ownMarker);
      }
      // Every other registered brand IS foreign here.
      for (const [otherCode, otherSpec] of Object.entries(SERVICE_OTP_REGISTRY)) {
        if (otherCode === serviceCode) continue;
        for (const otherMarker of otherSpec.senderBrandMarkers) {
          expect(markers).toContain(otherMarker);
        }
      }
      // Brands the platform never sells stay foreign for everyone.
      expect(markers).toContain("bca");
    }
    expect(foreignSenderMarkersForService("tg")).not.toContain("telegram");
    expect(foreignSenderMarkersForService("tg")).toContain("whatsapp");
    expect(foreignSenderMarkersForService("wa")).toContain("telegram");
  });

  it("keeps the sold brands and the never-sold brands disjoint", () => {
    // The precondition behind the derivation: a brand the platform sells OTPs for
    // must not also sit in the always-foreign list, or that service would treat
    // its own sender as foreign and refuse every real OTP. Asserted here so
    // adding a service that collides with the third-party list fails loudly.
    const soldBrandMarkers = Object.values(SERVICE_OTP_REGISTRY)
      .flatMap((spec) => spec.senderBrandMarkers);
    for (const marker of soldBrandMarkers) {
      expect(THIRD_PARTY_SENDER_MARKERS).not.toContain(marker);
    }
    // And no two services claim the same marker, which would make one of them
    // foreign to itself.
    expect(new Set(soldBrandMarkers).size).toBe(soldBrandMarkers.length);
  });

  it("parses a real Telegram login code as five digits", () => {
    // Telegram login codes are FIVE digits (core.telegram.org/api/auth defines a
    // login code as "a sequence of 5 to 7 decimal digits" and pins test DCs to
    // the DC number "repeated five times"), so the `wa` six-digit rule would
    // never have matched one.
    expect(parseServiceOtp("tg", "Telegram code 51284")).toEqual({
      status: "matched", otp: "51284",
    });
    const withWarning = [
      "Telegram code: 51284",
      "",
      "Do not give this code to anyone, even if they say they are from Telegram!",
    ].join("\n");
    expect(parseServiceOtp("tg", withWarning)).toEqual({ status: "matched", otp: "51284" });
  });

  it("accepts Telegram's own sender and refuses another brand's for a tg order", () => {
    const body = "Telegram code 51284";
    // Regression guard for the misdelivery bug this registry exists to prevent:
    // `telegram` is in the shared marker vocabulary, but for a `tg` order the
    // Telegram sender is the legitimate one — refusing it would drop a real OTP.
    for (const sender of ["Telegram", "TELEGRAM", "+6289911223344", "32665", ""]) {
      expect(parseServiceOtp("tg", body, { sender })).toEqual({
        status: "matched", otp: "51284",
      });
    }
    for (const sender of ["WhatsApp", "GOOGLE", "Instagram", "InfoBCA"]) {
      expect(parseServiceOtp("tg", body, { sender })).toEqual({
        status: "rejected", reason: "foreign_sender",
      });
    }
  });

  it("does not let another service's OTP satisfy tg", () => {
    // No brand word: a WhatsApp body is not a Telegram code.
    expect(parseServiceOtp("tg", "Kode WhatsApp Anda: 482901")).toEqual({
      status: "rejected", reason: "missing_keyword",
    });
    // Brand word present but the code is the wrong length: a six-digit foreign
    // OTP quoted inside a Telegram-branded body must not be delivered as the
    // five-digit Telegram code.
    expect(parseServiceOtp("tg", "Telegram code 123456")).toEqual({
      status: "rejected", reason: "no_candidate",
    });
    // The dashed wire format is WhatsApp-only: `tg` declares no grouped form.
    expect(parseServiceOtp("tg", "Telegram code 123-45")).toEqual({
      status: "rejected", reason: "no_candidate",
    });
    expect(parseServiceOtp("tg", "xTelegramx 51284")).toEqual({
      status: "rejected", reason: "missing_keyword",
    });
  });

  it("applies the ambiguity and decoy guards to tg", () => {
    expect(parseServiceOtp("tg", "Telegram code 51284 atau 40915")).toEqual({
      status: "rejected", reason: "ambiguous_candidates",
    });
    expect(parseServiceOtp("tg", "Telegram code tel: 51284")).toEqual({
      status: "rejected", reason: "decoy_candidate",
    });
  });

  it("parses a real Instagram code SMS", () => {
    // Verbatim reported shape (shortcode 32665): code first, then the app-hash
    // line Android uses for autofill — which contributes no digits.
    expect(
      parseServiceOtp("ig", "<#> 682019 is your Instagram code. Don't share it. SIYRxKrru1t"),
    ).toEqual({ status: "matched", otp: "682019" });
    expect(parseServiceOtp("ig", "682019 is your Instagram code. Don't share it")).toEqual({
      status: "matched", otp: "682019",
    });
  });

  it("accepts Instagram's own sender and refuses another brand's for an ig order", () => {
    const body = "682019 is your Instagram code. Don't share it";
    for (const sender of ["Instagram", "INSTAGRAM", "32665", ""]) {
      expect(parseServiceOtp("ig", body, { sender })).toEqual({
        status: "matched", otp: "682019",
      });
    }
    // `facebook` stays foreign for `ig` on purpose: shared ownership does not
    // make a Facebook-sender SMS an Instagram code.
    for (const sender of ["Telegram", "WhatsApp", "Facebook", "InfoBCA"]) {
      expect(parseServiceOtp("ig", body, { sender })).toEqual({
        status: "rejected", reason: "foreign_sender",
      });
    }
  });

  it("does not let another service's OTP satisfy ig, and guards ambiguity and decoys", () => {
    expect(parseServiceOtp("ig", "Kode WhatsApp Anda: 482901")).toEqual({
      status: "rejected", reason: "missing_keyword",
    });
    expect(parseServiceOtp("ig", "G-123456 is your Google verification code")).toEqual({
      status: "rejected", reason: "missing_keyword",
    });
    // Grouped form is WhatsApp-only, so WA's dashed wire code is no ig candidate.
    expect(parseServiceOtp("ig", "Instagram code 718-891")).toEqual({
      status: "rejected", reason: "no_candidate",
    });
    expect(parseServiceOtp("ig", "682019 is your Instagram code, backup 731904")).toEqual({
      status: "rejected", reason: "ambiguous_candidates",
    });
    expect(parseServiceOtp("ig", "Instagram code nomor: 081234")).toEqual({
      status: "rejected", reason: "decoy_candidate",
    });
  });

  it("parses a real Google verification code behind its G- prefix", () => {
    // "G-491052 is your Google verification code" is the most-reported Google
    // shape. The prefix needs no rule: `-` is not a digit, so the six digits
    // after it are already an intact candidate — and codes that arrive without
    // the prefix still parse instead of being refused.
    expect(parseServiceOtp("go", "G-491052 is your Google verification code")).toEqual({
      status: "matched", otp: "491052",
    });
    expect(parseServiceOtp("go", "Your Google verification code is 491052")).toEqual({
      status: "matched", otp: "491052",
    });
  });

  it("accepts Google's own sender and refuses another brand's for a go order", () => {
    const body = "G-491052 is your Google verification code";
    for (const sender of ["Google", "GOOGLE", "22000", ""]) {
      expect(parseServiceOtp("go", body, { sender })).toEqual({
        status: "matched", otp: "491052",
      });
    }
    for (const sender of ["Telegram", "WhatsApp", "Instagram", "Gojek-Info"]) {
      expect(parseServiceOtp("go", body, { sender })).toEqual({
        status: "rejected", reason: "foreign_sender",
      });
    }
  });

  it("does not let another service's OTP satisfy go, and guards ambiguity and decoys", () => {
    expect(parseServiceOtp("go", "Kode WhatsApp Anda: 482901")).toEqual({
      status: "rejected", reason: "missing_keyword",
    });
    expect(parseServiceOtp("go", "Telegram code 51284")).toEqual({
      status: "rejected", reason: "missing_keyword",
    });
    expect(parseServiceOtp("go", "G-491052 is your Google code, or use 731904")).toEqual({
      status: "rejected", reason: "ambiguous_candidates",
    });
    expect(parseServiceOtp("go", "Google verification phone 123456")).toEqual({
      status: "rejected", reason: "decoy_candidate",
    });
  });

  it("keeps the WhatsApp brand word out of the other services' keyword lists", () => {
    // Each service's keywords are only its own brand word, so one body can never
    // satisfy two services at once.
    expect(parseServiceOtp("wa", "Telegram code 51284")).toEqual({
      status: "rejected", reason: "missing_keyword",
    });
    expect(parseServiceOtp("wa", "682019 is your Instagram code. Don't share it")).toEqual({
      status: "rejected", reason: "missing_keyword",
    });
  });
});
