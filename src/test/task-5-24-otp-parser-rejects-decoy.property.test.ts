import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseServiceOtp } from "@domain/sms-matching-otp";

// Feature: partner-platform, Property 17: Parser OTP service-specific menolak decoy
//
// For all pesan SMS dari setiap service di registry, parser hanya mengembalikan
// kandidat ketika keyword brand service itu ada dan tepat satu angka utuh
// sepanjang kode service itu ada; penambahan angka decoy, hilangnya keyword,
// kandidat ambigu, atau sender milik brand lain tidak boleh menghasilkan OTP.
//
// **Validates: Requirements 11.7**
//
// Design references:
// - Parser per layanan lewat registry: tiap service punya keyword brand, panjang
//   kode, dan bentuk grouped sendiri; fallback generik mati (Components §8, SMS
//   Matching dan OTP Parser).
// - Pure domain test tidak memakai DB/network (Testing Strategy).
// - Testing Strategy: parser ditargetkan 500 run di CI malam.

const NUM_RUNS = 500;

// The test's own copy of each registry entry's observable rules. Written out by
// hand on purpose: importing the registry would make the property assert the
// implementation against itself, whereas this table is the independent
// ground truth the parser has to satisfy.
interface ServiceModel {
  readonly serviceCode: string;
  /** Brand word in assorted casings — the parser folds case. */
  readonly keywordCasings: readonly string[];
  readonly digitLength: number;
  /** Group sizes of the accepted dashed wire form, when the service has one. */
  readonly groupSizes: readonly number[] | null;
  /** Display prefixes that really precede the code, e.g. Google's `G-`. */
  readonly codePrefixes: readonly string[];
}

const SERVICE_MODELS: readonly ServiceModel[] = Object.freeze([
  // WhatsApp: six digits, contiguous or as the real `718-891` wire form.
  Object.freeze({
    serviceCode: "wa",
    keywordCasings: Object.freeze(["WhatsApp", "whatsapp", "WHATSAPP", "WhatsAPP"]),
    digitLength: 6,
    groupSizes: Object.freeze([3, 3]),
    codePrefixes: Object.freeze([]),
  }),
  // Telegram: login codes are FIVE digits and never split by a separator.
  Object.freeze({
    serviceCode: "tg",
    keywordCasings: Object.freeze(["Telegram", "telegram", "TELEGRAM", "TeleGram"]),
    digitLength: 5,
    groupSizes: null,
    codePrefixes: Object.freeze([]),
  }),
  // Instagram: six contiguous digits, code first in the body.
  Object.freeze({
    serviceCode: "ig",
    keywordCasings: Object.freeze(["Instagram", "instagram", "INSTAGRAM", "InstaGram"]),
    digitLength: 6,
    groupSizes: null,
    codePrefixes: Object.freeze([]),
  }),
  // Google: six digits, usually shown behind a `G-` display prefix.
  Object.freeze({
    serviceCode: "go",
    keywordCasings: Object.freeze(["Google", "google", "GOOGLE", "GooGle"]),
    digitLength: 6,
    groupSizes: null,
    codePrefixes: Object.freeze(["G-"]),
  }),
]);

// Sender ids each brand really signs its OTP with. For its OWN service these are
// legitimate; for every other service they are the foreign-sender signal.
const BRAND_SENDERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  wa: Object.freeze(["WhatsApp", "WhatsAppBusiness"]),
  tg: Object.freeze(["Telegram", "TELEGRAM"]),
  ig: Object.freeze(["Instagram"]),
  go: Object.freeze(["Google", "GOOGLE"]),
});

// Routes that name no service at all: shortcodes, bare numbers, absent id.
const NEUTRAL_SENDERS = Object.freeze(["+6289911223344", "32665", "22000", ""]);

// Brands the platform never sells OTPs for — foreign for every service.
const THIRD_PARTY_SENDERS = Object.freeze(["InfoBCA", "SHOPEE", "bni", "Gojek-Info", "TikTok"]);

// A token is one whitespace-separated fragment of the SMS body together with the
// ground-truth facts the parser must honour for the service under test: how many
// intact candidate runs it contributes (0 or 1), whether that single run is a
// labelled decoy, and whether it satisfies the service's brand keyword. Because
// fragments are always joined by a single space, no two digit runs ever merge
// and no dashed group can span a boundary, so the body's total candidate count
// is exactly the sum of per-token `candidates`.
interface Token {
  readonly text: string;
  readonly candidates: number;
  readonly isDecoyCandidate: boolean;
  readonly isKeyword: boolean;
  /** The normalized OTP this token yields when it is the sole candidate. */
  readonly otp: string | null;
}

const neutralToken = (text: string): Token => ({
  text, candidates: 0, isDecoyCandidate: false, isKeyword: false, otp: null,
});

const digitRun = (length: number): fc.Arbitrary<string> => fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: length, maxLength: length })
  .map((digits) => digits.join(""));

/** Split `digits` into the service's dashed wire form, e.g. `718-891`. */
function groupDigits(digits: string, groupSizes: readonly number[]): string {
  const groups: string[] = [];
  let offset = 0;
  for (const size of groupSizes) {
    groups.push(digits.slice(offset, offset + size));
    offset += size;
  }
  return groups.join("-");
}

// The service's brand word: the only configured keyword, in assorted casings.
// Generic OTP words are deliberately NOT keywords — they also appear in other
// services' OTPs, which must never be misdelivered.
const keywordArbitrary = (model: ServiceModel): fc.Arbitrary<Token> => fc
  .constantFrom(...model.keywordCasings)
  .map((text) => ({ text, candidates: 0, isDecoyCandidate: false, isKeyword: true, otp: null }));

// Neutral words that contain neither this service's brand word nor a decoy
// label, so they never flip keyword presence nor create a decoy prefix for a
// neighbour. The generic OTP vocabulary lives here: on its own it must not admit
// an OTP, which is exactly the foreign-service misdelivery this property guards.
const safeWordArbitrary: fc.Arbitrary<Token> = fc
  .constantFrom(
    "halo", "pesan", "masuk", "silakan", "gunakan", "untuk", "akun", "anda", "segera",
    "kode", "code", "verification", "verifikasi",
  )
  .map(neutralToken);

// A standalone, intact run of exactly the service's code length: the one
// legitimate candidate shape.
const plainCandidateArbitrary = (model: ServiceModel): fc.Arbitrary<Token> =>
  digitRun(model.digitLength).map((text) => ({
    text, candidates: 1, isDecoyCandidate: false, isKeyword: false, otp: text,
  }));

// The code behind its real display prefix (`G-123456`). The prefix is not a
// digit, so the run stays intact, and it is not a phone/date label, so the
// candidate is not a decoy.
const prefixedCandidateArbitrary = (model: ServiceModel): fc.Arbitrary<Token> => fc
  .tuple(fc.constantFrom(...model.codePrefixes), digitRun(model.digitLength))
  .map(([prefix, digits]) => ({
    text: `${prefix}${digits}`,
    candidates: 1,
    isDecoyCandidate: false,
    isKeyword: false,
    otp: digits,
  }));

// The dashed wire form, for the services that accept one: a standalone group
// chain is one intact candidate whose OTP is the normalized digits.
const dashedCandidateArbitrary = (
  model: ServiceModel,
  groupSizes: readonly number[],
): fc.Arbitrary<Token> => digitRun(model.digitLength).map((digits) => ({
  text: groupDigits(digits, groupSizes),
  candidates: 1,
  isDecoyCandidate: false,
  isKeyword: false,
  otp: digits,
}));

// A candidate immediately preceded by a phone/date label, e.g. `nomor: 481920`.
// It is an intact candidate, but when it is the sole candidate the parser must
// reject it as a decoy rather than deliver it.
const decoyCandidateArbitrary = (model: ServiceModel): fc.Arbitrary<Token> => fc
  .tuple(
    fc.constantFrom("date", "tanggal", "phone", "tel", "nomor", "telepon"),
    digitRun(model.digitLength),
    fc.boolean(),
  )
  .map(([label, digits, dashed]) => ({
    text: `${label}: ${dashed && model.groupSizes !== null
      ? groupDigits(digits, model.groupSizes)
      : digits}`,
    candidates: 1,
    isDecoyCandidate: true,
    isKeyword: false,
    otp: digits,
  }));

// Phone-like decoy: a digit run longer than the code, so every window of code
// length inside it is bordered by another digit and none is intact.
const longNumberArbitrary = (model: ServiceModel): fc.Arbitrary<Token> => fc
  .tuple(
    fc.boolean(),
    fc.array(fc.integer({ min: 0, max: 9 }), {
      minLength: model.digitLength + 1,
      maxLength: model.digitLength + 8,
    }),
  )
  .map(([withPrefix, digits]) => neutralToken((withPrefix ? "+62" : "") + digits.join("")));

// Hyphen-chained phones (0812-345-6789): the maximal digit runs are 3, 3 and
// 3..4 long, so for a five- or six-digit code no contiguous candidate exists,
// and for a service with a dashed form every group pair continues the chain.
const chainedPhoneArbitrary: fc.Arbitrary<Token> = fc
  .tuple(digitRun(6), fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 3, maxLength: 4 }))
  .map(([digits, tail]) =>
    neutralToken(`${digits.slice(0, 3)}-${digits.slice(3)}-${tail.join("")}`));

// Numeric run shorter than the code — never a candidate.
const shortNumberArbitrary = (model: ServiceModel): fc.Arbitrary<Token> => fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: model.digitLength - 1 })
  .map((digits) => neutralToken(digits.join("")));

// Dates whose maximal digit runs are all <= 4 long — never a candidate, and no
// group chain of the accepted dashed form either.
const dateDecoyArbitrary: fc.Arbitrary<Token> = fc
  .constantFrom("2026-03-01", "01/02/2026", "31-12-2025", "2024/06/09")
  .map(neutralToken);

// Non-ASCII decimal digits (Arabic-Indic / fullwidth): the parser's candidate
// regex is ASCII-only, so these contribute zero candidates.
const unicodeDigitArbitrary: fc.Arbitrary<Token> = fc
  .constantFrom("١٢٣٤٥٦", "１２３４５６", "٠٩٨٧٦٥")
  .map(neutralToken);

const emojiArbitrary: fc.Arbitrary<Token> = fc
  .constantFrom("\u{1F510}", "✅", "\u{1F4F1}", "\u{1F389}")
  .map(neutralToken);

function tokenArbitrary(model: ServiceModel): fc.Arbitrary<Token> {
  return fc.oneof(
    keywordArbitrary(model),
    safeWordArbitrary,
    plainCandidateArbitrary(model),
    decoyCandidateArbitrary(model),
    longNumberArbitrary(model),
    chainedPhoneArbitrary,
    shortNumberArbitrary(model),
    dateDecoyArbitrary,
    unicodeDigitArbitrary,
    emojiArbitrary,
    // Only for the services that really use these shapes: a dashed wire form is
    // a candidate for `wa` alone, a `G-` prefix for `go` alone.
    ...(model.groupSizes === null ? [] : [dashedCandidateArbitrary(model, model.groupSizes)]),
    ...(model.codePrefixes.length === 0 ? [] : [prefixedCandidateArbitrary(model)]),
  );
}

// Observed sender ids for the service under test. `isForeign` is the ground
// truth the parser's second defence layer must honour: a brand's own id is
// legitimate for its own service and foreign for every other one, so `Telegram`
// flips from foreign (`wa`) to legitimate (`tg`) with the service code.
function senderArbitrary(
  model: ServiceModel,
): fc.Arbitrary<Readonly<{ value: string | undefined; isForeign: boolean }>> {
  const ownSenders = [...(BRAND_SENDERS[model.serviceCode] ?? []), ...NEUTRAL_SENDERS];
  const foreignSenders = [
    ...Object.entries(BRAND_SENDERS)
      .filter(([code]) => code !== model.serviceCode)
      .flatMap(([, senders]) => senders),
    ...THIRD_PARTY_SENDERS,
  ];
  return fc.oneof(
    fc.constantFrom(...ownSenders).map((value) => ({ value, isForeign: false })),
    fc.constantFrom(...foreignSenders).map((value) => ({ value, isForeign: true })),
    fc.constant({ value: undefined as string | undefined, isForeign: false }),
  );
}

// Service codes outside the registry. The spelled-out brand names are included
// on purpose: only the short codes are supported, so `telegram` must stay
// unsupported even though `tg` now parses.
const UNSUPPORTED_SERVICE_CODES = Object.freeze([
  "telegram", "instagram", "google", "whatsapp", "sx", "", "toString",
]);

interface Scenario {
  readonly model: ServiceModel;
  /** The code actually handed to the parser — unsupported codes reuse a model. */
  readonly serviceCode: string;
  readonly supported: boolean;
  readonly tokens: readonly Token[];
  readonly sender: Readonly<{ value: string | undefined; isForeign: boolean }>;
}

const scenarioArbitrary: fc.Arbitrary<Scenario> = fc
  .oneof(
    // Mostly registered services, so every entry's rules get exercised…
    { weight: 6, arbitrary: fc.constantFrom(...SERVICE_MODELS).map((model) => ({
      model, serviceCode: model.serviceCode, supported: true,
    })) },
    // …and occasionally an unknown code so the unsupported branch stays covered.
    { weight: 1, arbitrary: fc.constantFrom(...SERVICE_MODELS).chain((model) =>
      fc.constantFrom(...UNSUPPORTED_SERVICE_CODES).map((serviceCode) => ({
        model, serviceCode, supported: false,
      }))) },
  )
  .chain(({ model, serviceCode, supported }) => fc
    .tuple(fc.array(tokenArbitrary(model), { maxLength: 8 }), senderArbitrary(model))
    .map(([tokens, sender]) => ({ model, serviceCode, supported, tokens, sender })));

describe("Property 17: service-specific OTP parser rejects decoys", () => {
  it("delivers an OTP only with the service's keyword and exactly one intact non-decoy candidate", () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ model, serviceCode, supported, tokens, sender }) => {
        const body = tokens.map((token) => token.text).join(" ");
        const result = parseServiceOtp(
          serviceCode,
          body,
          sender.value === undefined ? {} : { sender: sender.value },
        );

        // A code outside the registry is unsupported regardless of body or sender.
        if (!supported) {
          expect(result).toEqual({ status: "rejected", reason: "unsupported_service" });
          return;
        }

        // A sender naming ANOTHER service is refused before the body is read, so
        // no foreign OTP can ever be delivered as this order's code — while this
        // service's own brand sender is never treated as foreign.
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
            // The sole intact candidate (plain, prefixed, or dashed) determines
            // the OTP; a dashed group chain normalizes to its digits.
            expect(result).toEqual({ status: "matched", otp: only.otp });
          }
        }

        // Cross-cutting safety invariant: a match can only ever be the service's
        // own code length, present in the body (verbatim or as its dashed wire
        // form), and only when that service's keyword was present.
        if (result.status === "matched") {
          expect(new RegExp(`^[0-9]{${model.digitLength}}$`).test(result.otp)).toBe(true);
          const presentVerbatim = body.includes(result.otp);
          const presentGrouped = model.groupSizes !== null
            && body.includes(groupDigits(result.otp, model.groupSizes));
          expect(presentVerbatim || presentGrouped).toBe(true);
          expect(hasKeyword).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
