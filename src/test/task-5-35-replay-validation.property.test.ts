import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  isValid128BitNonce,
  type ReplayDecision,
  type ReplayValidationInput,
  validateReplayProtection,
} from "@domain/task-5-3/replay-policy";

/**
 * Feature: partner-platform, Property 28: Replay validation menerima hanya
 * request fresh dan unik. For all timestamp dan nonce request Agent, validator
 * menerima request hanya bila autentikasi valid, skew maksimum 300 detik, dan
 * nonce belum digunakan principal itu; duplicate/stale request ditolak sebelum
 * mutation.
 *
 * **Validates: Requirements 18.4, 18.5**
 *
 * Strategy: generate the full replay-decision input space — principal presence,
 * the three authentication signals (credential/signature/ownership),
 * server/request timestamps around the exact skew boundary, explicit and
 * defaulted skew/TTL configuration (including out-of-range values), and nonces
 * tagged with their independently-known 128-bit validity plus a used/unused
 * flag. From those independently-known predicates we assert the validator's
 * decision exactly, proving four invariants:
 *   1. A reject NEVER grants mutation (`mayMutate === false`), so every failing
 *      request is refused before any state change (Req 18.5).
 *   2. Authentication dominates: a missing principal or any failed
 *      credential/signature/ownership check yields `AUTHENTICATION_FAILED`
 *      regardless of freshness or nonce (Req 18.5).
 *   3. Acceptance requires ALL of: authenticated, times well-formed, skew within
 *      the configured maximum (default 300s), a valid 128-bit nonce, and the
 *      nonce unused for that principal — with `nonceExpiresAtSeconds = now + ttl`
 *      (Req 18.4).
 *   4. Any stale/future timestamp, malformed times, malformed nonce, or reused
 *      nonce yields `REPLAY_REJECTED` (Req 18.4).
 * The decision is also asserted to be deterministic across repeated calls.
 */

interface TaggedNonce {
  readonly value: string;
  readonly valid: boolean;
}

// Hex-encoded 128-bit nonce (32 hex chars).
const hexNonceArbitrary: fc.Arbitrary<TaggedNonce> = fc
  .array(fc.constantFrom(..."0123456789abcdefABCDEF".split("")), { minLength: 32, maxLength: 32 })
  .map((chars) => ({ value: chars.join(""), valid: true }));

// base64url-encoded 128-bit nonce (22 chars, optional == padding).
const base64UrlNonceArbitrary: fc.Arbitrary<TaggedNonce> = fc
  .tuple(
    fc.array(
      fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("")),
      { minLength: 22, maxLength: 22 },
    ),
    fc.constantFrom("", "=="),
  )
  .map(([chars, pad]) => ({ value: `${chars.join("")}${pad}`, valid: true }));

// Structurally invalid nonces that must all be rejected as non-128-bit.
const invalidNonceArbitrary: fc.Arbitrary<TaggedNonce> = fc
  .oneof(
    fc.constant(""),
    fc.constant("too-short"),
    fc.constant("0123456789abcdef0123456789abcde"), // 31 hex chars
    fc.constant("0123456789abcdef0123456789abcdef0"), // 33 hex chars
    fc.constant("!!!!!!!!!!!!!!!!!!!!!!"), // 22 chars outside the alphabet
    fc.string(),
  )
  .map((value) => ({ value, valid: isValid128BitNonce(value) }));

const nonceArbitrary: fc.Arbitrary<TaggedNonce> = fc.oneof(
  { weight: 3, arbitrary: hexNonceArbitrary },
  { weight: 2, arbitrary: base64UrlNonceArbitrary },
  { weight: 2, arbitrary: invalidNonceArbitrary },
);

const principalArbitrary = fc.oneof(
  { weight: 4, arbitrary: fc.uuid() },
  { weight: 1, arbitrary: fc.constantFrom("", " ") }, // "" is unauthenticated; " " is a valid principal
);

// Skew configuration: undefined defaults to 300; explicit values include the
// boundary and out-of-range (negative) values that make the times ill-formed.
// Each config is paired with an offset that exercises the skew boundary exactly
// (both sides), plus interior and exterior points.
const skewAndOffsetArbitrary = fc
  .oneof(
    fc.constant<number | undefined>(undefined),
    fc.constantFrom(0, 1, 60, 300, 301, 1_000, -1),
  )
  .chain((skewConfig) => {
    const effectiveMaxSkew = skewConfig ?? 300;
    return fc.record({
      skewConfig: fc.constant(skewConfig),
      offset: fc.constantFrom(
        -(effectiveMaxSkew + 1),
        -effectiveMaxSkew,
        -1,
        0,
        1,
        effectiveMaxSkew,
        effectiveMaxSkew + 1,
      ),
    });
  });

// TTL configuration: undefined defaults to 600; 0 and negatives are invalid
// (ttl must be > 0) and must force a rejection even when authenticated + fresh.
const ttlConfigArbitrary = fc.oneof(
  fc.constant<number | undefined>(undefined),
  fc.constantFrom(1, 600, 3_600, 0, -5),
);

function safeInt(value: number): boolean {
  return Number.isSafeInteger(value);
}

/** Independent oracle mirroring the specified acceptance conditions. */
function expectedDecision(input: ReplayValidationInput, nonceValid: boolean): ReplayDecision {
  const authOk = Boolean(input.principalId)
    && input.credentialValid
    && input.signatureValid
    && input.ownershipValid;
  if (!authOk) {
    return { kind: "reject", mayMutate: false, code: "AUTHENTICATION_FAILED" };
  }

  const maxSkew = input.maxClockSkewSeconds ?? 300;
  const ttl = input.nonceTtlSeconds ?? 600;
  const timesOk = safeInt(input.timestampSeconds)
    && safeInt(input.nowSeconds)
    && safeInt(maxSkew)
    && safeInt(ttl)
    && maxSkew >= 0
    && ttl > 0;
  const fresh = timesOk && Math.abs(input.nowSeconds - input.timestampSeconds) <= maxSkew;
  if (!fresh) {
    return { kind: "reject", mayMutate: false, code: "REPLAY_REJECTED" };
  }
  if (!nonceValid || input.nonceAlreadyUsed) {
    return { kind: "reject", mayMutate: false, code: "REPLAY_REJECTED" };
  }
  return { kind: "accept", mayMutate: true, nonceExpiresAtSeconds: input.nowSeconds + ttl };
}

describe("Property 28: Replay validation accepts only fresh and unique requests", () => {
  it("accepts iff authenticated, within skew, and holding an unused valid nonce; rejects everything else before mutation", () => {
    fc.assert(
      fc.property(
        principalArbitrary,
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        nonceArbitrary,
        // A moderate base so now +/- offset stays a safe integer.
        fc.integer({ min: 1_000_000, max: 2_000_000_000 }),
        skewAndOffsetArbitrary,
        ttlConfigArbitrary,
        (principalId, credentialValid, signatureValid, ownershipValid, nonceAlreadyUsed, nonce, nowSeconds, skewAndOffset, ttlConfig) => {
          const input: ReplayValidationInput = {
            principalId,
            timestampSeconds: nowSeconds + skewAndOffset.offset,
            nonce: nonce.value,
            nowSeconds,
            credentialValid,
            signatureValid,
            ownershipValid,
            nonceAlreadyUsed,
            maxClockSkewSeconds: skewAndOffset.skewConfig,
            nonceTtlSeconds: ttlConfig,
          };

          const decision = validateReplayProtection(input);

          // Invariant 1: a reject never authorises a mutation.
          if (decision.kind === "reject") {
            expect(decision.mayMutate).toBe(false);
          }

          // Invariants 2-4: the decision matches the independent oracle.
          expect(decision).toEqual(expectedDecision(input, nonce.valid));

          // Determinism: the validator is a pure function of its input.
          expect(validateReplayProtection(input)).toEqual(decision);
        },
      ),
      { numRuns: 300 },
    );
  });
});
