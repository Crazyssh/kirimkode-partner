import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseServiceOtp } from "@domain/sms-matching-otp";

// Feature: partner-platform, Property 17: Parser OTP service-specific menolak decoy
//
// For all pesan WhatsApp SMS, parser hanya mengembalikan kandidat ketika keyword
// service valid ada dan tepat satu angka enam digit utuh ada; penambahan angka
// decoy, hilangnya keyword, atau kandidat ambigu tidak boleh menghasilkan OTP.
//
// **Validates: Requirements 11.7**
//
// Design references:
// - Parser MVP `wa`: butuh keyword terkonfigurasi + tepat satu kandidat 6 digit
//   utuh; fallback generik mati (Components §8, SMS Matching dan OTP Parser).
// - Pure domain test tidak memakai DB/network (Testing Strategy).
// - Testing Strategy: parser ditargetkan 500 run di CI malam.

const NUM_RUNS = 500;

// A token is one whitespace-separated fragment of the SMS body together with the
// ground-truth facts the parser must honour: how many intact ASCII six-digit
// runs it contributes (0 or 1), whether that single run is a labelled decoy, and
// whether it satisfies a configured keyword. Because fragments are always joined
// by a single space, no two digit runs ever merge, so the body's total intact
// candidate count is exactly the sum of per-token `candidates`.
interface Token {
  readonly text: string;
  readonly candidates: number;
  readonly isDecoyCandidate: boolean;
  readonly isKeyword: boolean;
  /** The normalized OTP this token yields when it is the sole candidate. */
  readonly otp: string | null;
}

// The single configured `wa` keyword is the brand word, in assorted casings;
// the parser folds case, so any of these standing as a whole word satisfies the
// keyword requirement. Generic OTP words are deliberately NOT keywords: they
// also appear in other services' OTPs, which must never be misdelivered.
const keywordArbitrary: fc.Arbitrary<Token> = fc
  .constantFrom("WhatsApp", "whatsapp", "WHATSAPP", "WhatsAPP")
  .map((text) => ({ text, candidates: 0, isDecoyCandidate: false, isKeyword: true, otp: null }));

// Neutral words that contain neither a configured keyword nor a decoy label, so
// they never flip keyword presence nor create a decoy prefix for a neighbour.
// The generic OTP vocabulary lives here now: on its own it must not admit an
// OTP, which is exactly the foreign-service misdelivery this property guards.
const safeWordArbitrary: fc.Arbitrary<Token> = fc
  .constantFrom(
    "halo", "pesan", "masuk", "silakan", "gunakan", "untuk", "akun", "anda", "segera",
    "kode", "code", "verification", "verifikasi",
  )
  .map((text) => ({ text, candidates: 0, isDecoyCandidate: false, isKeyword: false, otp: null }));

const sixDigits: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 6, maxLength: 6 })
  .map((digits) => digits.join(""));

// A standalone, intact six-digit run: the one legitimate OTP candidate shape.
const plainCandidateArbitrary: fc.Arbitrary<Token> = sixDigits.map((text) => ({
  text,
  candidates: 1,
  isDecoyCandidate: false,
  isKeyword: false,
  otp: text,
}));

// The real WhatsApp wire format: two three-digit groups joined by one hyphen
// (`718-891`). A standalone pair is one intact candidate whose OTP is the
// normalized six digits.
const dashedCandidateArbitrary: fc.Arbitrary<Token> = sixDigits.map((digits) => ({
  text: `${digits.slice(0, 3)}-${digits.slice(3)}`,
  candidates: 1,
  isDecoyCandidate: false,
  isKeyword: false,
  otp: digits,
}));

// A six-digit run immediately preceded by a phone/date label, e.g. `nomor: 481920`.
// It is an intact candidate, but when it is the sole candidate the parser must
// reject it as a decoy rather than deliver it.
const decoyCandidateArbitrary: fc.Arbitrary<Token> = fc
  .tuple(
    fc.constantFrom("date", "tanggal", "phone", "tel", "nomor", "telepon"),
    sixDigits,
    fc.boolean(),
  )
  .map(([label, digits, dashed]) => ({
    text: `${label}: ${dashed ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits}`,
    candidates: 1,
    isDecoyCandidate: true,
    isKeyword: false,
    otp: digits,
  }));

// Phone-like decoy: a digit run of length >= 7, which is never an intact
// six-digit candidate.
const longNumberArbitrary: fc.Arbitrary<Token> = fc
  .tuple(
    fc.boolean(),
    fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 7, maxLength: 14 }),
  )
  .map(([withPrefix, digits]) => ({
    text: (withPrefix ? "+62" : "") + digits.join(""),
    candidates: 0,
    isDecoyCandidate: false,
    isKeyword: false,
    otp: null,
  }));

// Hyphen-chained phones (0812-345-6789): every three-digit pair continues the
// chain, so the whole token contributes zero candidates.
const chainedPhoneArbitrary: fc.Arbitrary<Token> = fc
  .tuple(sixDigits, fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 3, maxLength: 4 }))
  .map(([digits, tail]) => ({
    text: `${digits.slice(0, 3)}-${digits.slice(3)}-${tail.join("")}`,
    candidates: 0,
    isDecoyCandidate: false,
    isKeyword: false,
    otp: null,
  }));

// Short numeric run of length 1..5 — never a candidate.
const shortNumberArbitrary: fc.Arbitrary<Token> = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 5 })
  .map((digits) => ({ text: digits.join(""), candidates: 0, isDecoyCandidate: false, isKeyword: false, otp: null }));

// Dates whose maximal digit runs are all <= 4 long — never a candidate.
const dateDecoyArbitrary: fc.Arbitrary<Token> = fc
  .constantFrom("2026-03-01", "01/02/2026", "31-12-2025", "2024/06/09")
  .map((text) => ({ text, candidates: 0, isDecoyCandidate: false, isKeyword: false, otp: null }));

// Six non-ASCII decimal digits (Arabic-Indic / fullwidth): the parser's candidate
// regex is ASCII-only, so these contribute zero candidates.
const unicodeDigitArbitrary: fc.Arbitrary<Token> = fc
  .constantFrom("\u0661\u0662\u0663\u0664\u0665\u0666", "\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16", "\u0660\u0669\u0668\u0667\u0666\u0665")
  .map((text) => ({ text, candidates: 0, isDecoyCandidate: false, isKeyword: false, otp: null }));

const emojiArbitrary: fc.Arbitrary<Token> = fc
  .constantFrom("\u{1F510}", "\u2705", "\u{1F4F1}", "\u{1F389}")
  .map((text) => ({ text, candidates: 0, isDecoyCandidate: false, isKeyword: false, otp: null }));

const tokenArbitrary: fc.Arbitrary<Token> = fc.oneof(
  keywordArbitrary,
  safeWordArbitrary,
  plainCandidateArbitrary,
  dashedCandidateArbitrary,
  decoyCandidateArbitrary,
  longNumberArbitrary,
  chainedPhoneArbitrary,
  shortNumberArbitrary,
  dateDecoyArbitrary,
  unicodeDigitArbitrary,
  emojiArbitrary,
);

// Mostly `wa`, but occasionally another service so the unsupported-service branch
// is exercised too.
const serviceArbitrary = fc.constantFrom("wa", "wa", "wa", "wa", "telegram", "ig", "");

// Observed sender ids: WhatsApp-route senders (alphanumeric id, shortcode, bare
// number, absent) alongside ids that clearly name another service. `isForeign`
// is the ground truth the parser's second defence layer must honour.
const senderArbitrary: fc.Arbitrary<Readonly<{ value: string | undefined; isForeign: boolean }>> =
  fc.oneof(
    fc
      .constantFrom("WhatsApp", "WhatsAppBusiness", "+6289911223344", "32665", "")
      .map((value) => ({ value, isForeign: false })),
    fc
      .constantFrom("InfoBCA", "Telegram", "GOOGLE", "Gojek-Info", "SHOPEE", "bni")
      .map((value) => ({ value, isForeign: true })),
    fc.constant({ value: undefined, isForeign: false }),
  );

describe("Property 17: service-specific OTP parser rejects decoys", () => {
  it("delivers an OTP only with a keyword and exactly one intact non-decoy six-digit candidate", () => {
    fc.assert(
      fc.property(
        serviceArbitrary,
        fc.array(tokenArbitrary, { maxLength: 8 }),
        senderArbitrary,
        (service, tokens, sender) => {
          const body = tokens.map((token) => token.text).join(" ");
          const result = parseServiceOtp(
            service,
            body,
            sender.value === undefined ? {} : { sender: sender.value },
          );

          // Non-`wa` services are unsupported regardless of body or sender.
          if (service !== "wa") {
            expect(result).toEqual({ status: "rejected", reason: "unsupported_service" });
            return;
          }

          // A sender naming another service is refused before the body is read,
          // so no foreign OTP can ever be delivered as this order's WA code.
          if (sender.isForeign) {
            expect(result).toEqual({ status: "rejected", reason: "foreign_sender" });
            return;
          }

          const candidateCount = tokens.reduce((sum, token) => sum + token.candidates, 0);
          const hasKeyword = tokens.some((token) => token.isKeyword);

          // Requirement 11.7 checked in the parser's own order: keyword first,
          // then candidate cardinality, then the decoy guard on the lone candidate.
          if (!hasKeyword) {
            expect(result).toEqual({ status: "rejected", reason: "missing_keyword" });
          } else if (candidateCount === 0) {
            expect(result).toEqual({ status: "rejected", reason: "no_candidate" });
          } else if (candidateCount > 1) {
            expect(result).toEqual({ status: "rejected", reason: "ambiguous_candidates" });
          } else {
            const only = tokens.find((token) => token.candidates === 1)!;
            if (only.isDecoyCandidate) {
              expect(result).toEqual({ status: "rejected", reason: "decoy_candidate" });
            } else {
              // The sole intact candidate (plain or dashed) determines the OTP;
              // a dashed pair normalizes to its six digits.
              expect(result).toEqual({ status: "matched", otp: only.otp });
            }
          }

          // Cross-cutting safety invariant: a match can only ever be six digits
          // present in the body (verbatim or as its dashed wire form), and only
          // when a keyword was present.
          if (result.status === "matched") {
            expect(/^[0-9]{6}$/.test(result.otp)).toBe(true);
            const dashedForm = `${result.otp.slice(0, 3)}-${result.otp.slice(3)}`;
            expect(body.includes(result.otp) || body.includes(dashedForm)).toBe(true);
            expect(hasKeyword).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
