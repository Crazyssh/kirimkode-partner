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
}

// Configured `wa` keywords in assorted casings; the parser folds case, so any of
// these standing as a whole word must satisfy the keyword requirement.
const keywordArbitrary: fc.Arbitrary<Token> = fc
  .constantFrom(
    "WhatsApp", "whatsapp", "WHATSAPP",
    "kode", "Kode", "KODE",
    "code", "Code", "CODE",
    "verification", "Verification",
    "verifikasi", "VERIFIKASI",
  )
  .map((text) => ({ text, candidates: 0, isDecoyCandidate: false, isKeyword: true }));

// Neutral words that contain neither a configured keyword nor a decoy label, so
// they never flip keyword presence nor create a decoy prefix for a neighbour.
const safeWordArbitrary: fc.Arbitrary<Token> = fc
  .constantFrom("halo", "pesan", "masuk", "silakan", "gunakan", "untuk", "akun", "anda", "segera")
  .map((text) => ({ text, candidates: 0, isDecoyCandidate: false, isKeyword: false }));

const sixDigits: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 6, maxLength: 6 })
  .map((digits) => digits.join(""));

// A standalone, intact six-digit run: the one legitimate OTP candidate shape.
const plainCandidateArbitrary: fc.Arbitrary<Token> = sixDigits.map((text) => ({
  text,
  candidates: 1,
  isDecoyCandidate: false,
  isKeyword: false,
}));

// A six-digit run immediately preceded by a phone/date label, e.g. `nomor: 481920`.
// It is an intact candidate, but when it is the sole candidate the parser must
// reject it as a decoy rather than deliver it.
const decoyCandidateArbitrary: fc.Arbitrary<Token> = fc
  .tuple(fc.constantFrom("date", "tanggal", "phone", "tel", "nomor", "telepon"), sixDigits)
  .map(([label, digits]) => ({
    text: `${label}: ${digits}`,
    candidates: 1,
    isDecoyCandidate: true,
    isKeyword: false,
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
  }));

// Short numeric run of length 1..5 — never a candidate.
const shortNumberArbitrary: fc.Arbitrary<Token> = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 5 })
  .map((digits) => ({ text: digits.join(""), candidates: 0, isDecoyCandidate: false, isKeyword: false }));

// Dates whose maximal digit runs are all <= 4 long — never a candidate.
const dateDecoyArbitrary: fc.Arbitrary<Token> = fc
  .constantFrom("2026-03-01", "01/02/2026", "31-12-2025", "2024/06/09")
  .map((text) => ({ text, candidates: 0, isDecoyCandidate: false, isKeyword: false }));

// Six non-ASCII decimal digits (Arabic-Indic / fullwidth): the parser's candidate
// regex is ASCII-only, so these contribute zero candidates.
const unicodeDigitArbitrary: fc.Arbitrary<Token> = fc
  .constantFrom("\u0661\u0662\u0663\u0664\u0665\u0666", "\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16", "\u0660\u0669\u0668\u0667\u0666\u0665")
  .map((text) => ({ text, candidates: 0, isDecoyCandidate: false, isKeyword: false }));

const emojiArbitrary: fc.Arbitrary<Token> = fc
  .constantFrom("\u{1F510}", "\u2705", "\u{1F4F1}", "\u{1F389}")
  .map((text) => ({ text, candidates: 0, isDecoyCandidate: false, isKeyword: false }));

const tokenArbitrary: fc.Arbitrary<Token> = fc.oneof(
  keywordArbitrary,
  safeWordArbitrary,
  plainCandidateArbitrary,
  decoyCandidateArbitrary,
  longNumberArbitrary,
  shortNumberArbitrary,
  dateDecoyArbitrary,
  unicodeDigitArbitrary,
  emojiArbitrary,
);

// Mostly `wa`, but occasionally another service so the unsupported-service branch
// is exercised too.
const serviceArbitrary = fc.constantFrom("wa", "wa", "wa", "wa", "telegram", "ig", "");

describe("Property 17: service-specific OTP parser rejects decoys", () => {
  it("delivers an OTP only with a keyword and exactly one intact non-decoy six-digit candidate", () => {
    fc.assert(
      fc.property(
        serviceArbitrary,
        fc.array(tokenArbitrary, { maxLength: 8 }),
        (service, tokens) => {
          const body = tokens.map((token) => token.text).join(" ");
          const result = parseServiceOtp(service, body);

          // Non-`wa` services are unsupported regardless of body content.
          if (service !== "wa") {
            expect(result).toEqual({ status: "rejected", reason: "unsupported_service" });
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
              // The sole intact candidate is a standalone six-digit token, so its
              // text is exactly the OTP the parser must return.
              expect(result).toEqual({ status: "matched", otp: only.text });
            }
          }

          // Cross-cutting safety invariant: a match can only ever be a six-digit
          // string present in the body, and only when a keyword was present.
          if (result.status === "matched") {
            expect(/^[0-9]{6}$/.test(result.otp)).toBe(true);
            expect(body.includes(result.otp)).toBe(true);
            expect(hasKeyword).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
