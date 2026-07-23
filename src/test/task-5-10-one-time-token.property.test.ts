import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  consumeOneTimeToken,
  issueOneTimeToken,
  ONE_TIME_TOKEN_TTL_MS,
  type OneTimeTokenRecord,
  type OneTimeTokenType,
} from "@domain/task-5-1/one-time-token";
import { installFakeClock, restoreFakeClock, type FakeClock } from "@test/fake-clock";

/**
 * Feature: partner-platform, Property 3: Token sekali pakai berbatas waktu
 *
 * For all token verifikasi/reset dan waktu observasi, token hanya dapat mengubah
 * state tepat sekali ketika hash cocok, belum digunakan, dan waktu belum melewati
 * expiry; semua kondisi lain tidak mengubah state akun.
 *
 * Validates: Requirements 2.6
 *
 * Strategy: vary token type/expiry, presented hash (case + mismatch + invalid
 * format), expected member/type, the observation clock, and a retry sequence.
 * A fake clock drives every `nowEpochMs` value so time is deterministic. The test
 * proves that across an arbitrary number of retries at most ONE consume succeeds,
 * a success only happens when every match condition holds and the clock is before
 * expiry, and every rejection leaves the token's used state unchanged.
 */

const CORRECT_MEMBER_ID = "member-1";
const WRONG_MEMBER_ID = "member-2";

// A valid stored hash is 64 lowercase hex chars. Deriving it from 32 bytes keeps
// the generator inside the accepted input space by construction.
const hexHashArbitrary = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));

const tokenTypeArbitrary = fc.constantFrom<OneTimeTokenType>(
  "email_verification",
  "password_reset",
);

// How the presented hash relates to the stored hash for a given attempt.
type HashVariant = "exact" | "uppercased" | "different" | "invalid_format";
const hashVariantArbitrary = fc.constantFrom<HashVariant>(
  "exact",
  "uppercased",
  "different",
  "invalid_format",
);

function presentedHash(storedHashHex: string, differentHashHex: string, variant: HashVariant): string {
  switch (variant) {
    case "exact":
      return storedHashHex;
    case "uppercased":
      return storedHashHex.toUpperCase();
    case "different":
      // Guarantee a genuinely different valid hash by flipping the last nibble.
      return differentHashHex === storedHashHex
        ? storedHashHex.slice(0, 63) + (storedHashHex[63] === "0" ? "1" : "0")
        : differentHashHex;
    case "invalid_format":
      return "not-a-valid-sha256-hash";
  }
}

describe("Task 5.10 one-time token single-use, time-bounded", () => {
  let clock: FakeClock;

  beforeEach(() => {
    clock = installFakeClock("2026-01-01T00:00:00.000Z");
  });

  afterEach(() => {
    restoreFakeClock();
  });

  it("changes account state at most once and only under matching, fresh, unexpired conditions", () => {
    fc.assert(
      fc.property(
        fc.record({
          issuedType: tokenTypeArbitrary,
          issuedAtEpochMs: fc.integer({ min: 1_600_000_000_000, max: 1_900_000_000_000 }),
          storedHashHex: hexHashArbitrary,
          differentHashHex: hexHashArbitrary,
          attempts: fc.array(
            fc.record({
              offsetMs: fc.integer({
                min: -3_600_000,
                max: ONE_TIME_TOKEN_TTL_MS.email_verification + 3_600_000,
              }),
              memberId: fc.constantFrom(CORRECT_MEMBER_ID, WRONG_MEMBER_ID),
              type: tokenTypeArbitrary,
              hashVariant: hashVariantArbitrary,
            }),
            { minLength: 1, maxLength: 6 },
          ),
        }),
        ({ issuedType, issuedAtEpochMs, storedHashHex, differentHashHex, attempts }) => {
          const issued: OneTimeTokenRecord = issueOneTimeToken({
            id: "token-1",
            memberId: CORRECT_MEMBER_ID,
            type: issuedType,
            tokenHash: storedHashHex,
            issuedAtEpochMs,
          });

          // The account state is captured entirely by the current token's used marker.
          let current = issued;
          let successCount = 0;

          for (const attempt of attempts) {
            const nowEpochMs = issuedAtEpochMs + attempt.offsetMs;
            // Drive `now` through the fake clock harness deterministically.
            clock.set(new Date(nowEpochMs));
            expect(Date.now()).toBe(nowEpochMs);

            const usedBefore = current.usedAtEpochMs;
            const presented = presentedHash(storedHashHex, differentHashHex, attempt.hashVariant);

            const result = consumeOneTimeToken({
              token: current,
              expectedMemberId: attempt.memberId,
              expectedType: attempt.type,
              presentedTokenHash: presented,
              nowEpochMs: Date.now(),
            });

            const matchesIdentity =
              attempt.memberId === CORRECT_MEMBER_ID &&
              attempt.type === issuedType &&
              (attempt.hashVariant === "exact" || attempt.hashVariant === "uppercased");

            if (result.consumed) {
              // A success is only legal on a fresh token, before expiry, with a full match.
              expect(usedBefore).toBeNull();
              expect(matchesIdentity).toBe(true);
              expect(nowEpochMs).toBeLessThan(current.expiresAtEpochMs);

              // Exactly one state change: the marker moves from null to `now`.
              expect(result.token.usedAtEpochMs).toBe(nowEpochMs);
              successCount += 1;
              current = result.token;
            } else {
              // Rejection must never mutate the account state.
              expect(current.usedAtEpochMs).toBe(usedBefore);

              // Mirror the domain's check precedence: credential mismatch is
              // reported first (and never leaks whether the token was used),
              // then already-used, then expiry.
              if (!matchesIdentity) {
                expect(result.code).toBe("TOKEN_INVALID");
              } else if (usedBefore !== null) {
                // Once consumed, a matching retry is rejected as already used.
                expect(result.code).toBe("TOKEN_ALREADY_USED");
              } else {
                // Identity matched and token fresh, so the only reason left is expiry.
                expect(result.code).toBe("TOKEN_EXPIRED");
                expect(nowEpochMs).toBeGreaterThanOrEqual(current.expiresAtEpochMs);
              }
            }
          }

          // Core invariant: a one-time token drives at most one account state change.
          expect(successCount).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});
