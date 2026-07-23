import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  normalizeEmail,
  validateEmail,
  validatePassword,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
} from "@domain/task-5-1/identity";
import {
  registerPartner,
  RegistrationTransactionPort,
  RegistrationUnitOfWorkPort,
} from "@domain/task-5-1/registration";

// Feature: partner-platform, Property 2: Normalisasi identitas dan kebijakan
// kredensial — For all alamat email dan password, email yang ekuivalen setelah
// trim/lowercase memiliki satu identitas unik, dan registrasi hanya diterima jika
// password memenuhi seluruh batas kebijakan.
//
// **Validates: Requirements 2.2**

// --- Equivalence-preserving email transformations -------------------------
// A canonical email is built from ASCII [a-z0-9] plus a single "@" separator.
// Each character can be rendered in an equivalent form that must collapse back
// to the canonical identity after NFKC normalization + trim + lowercase:
//   - "upper":          ASCII uppercase (case folds back on lowercase)
//   - "fullwidth":      halfwidth->fullwidth (U+FF01..U+FF5E NFKC-folds to ASCII)
//   - "fullwidthUpper": fullwidth uppercase (Unicode + case)
// Surrounding ASCII whitespace is added and must be stripped by trim().
type CharTransform = "plain" | "upper" | "fullwidth" | "fullwidthUpper";

function toFullwidth(ch: string): string {
  const cp = ch.codePointAt(0);
  if (cp !== undefined && cp >= 0x21 && cp <= 0x7e) {
    return String.fromCodePoint(cp + 0xfee0);
  }
  return ch;
}

function applyTransform(ch: string, mode: CharTransform): string {
  switch (mode) {
    case "upper":
      return ch.toUpperCase();
    case "fullwidth":
      return toFullwidth(ch);
    case "fullwidthUpper":
      return toFullwidth(ch.toUpperCase());
    default:
      return ch;
  }
}

const emailCharArbitrary = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
);
const emailPartArbitrary = fc
  .array(emailCharArbitrary, { minLength: 1, maxLength: 12 })
  .map((chars) => chars.join(""));

const whitespaceArbitrary = fc.string({
  unit: fc.constantFrom(" ", "\t", "\n", "\r"),
  maxLength: 4,
});

// A scenario yields one canonical email plus several forms that are equivalent
// only by case, compatibility Unicode, and surrounding whitespace.
const emailScenarioArbitrary = fc
  .tuple(emailPartArbitrary, emailPartArbitrary)
  .chain(([local, domain]) => {
    const canonical = `${local}@${domain}`;
    const canonicalChars = Array.from(canonical);
    const variantArbitrary = fc
      .record({
        lead: whitespaceArbitrary,
        trail: whitespaceArbitrary,
        transforms: fc.array(
          fc.constantFrom<CharTransform>(
            "plain",
            "upper",
            "fullwidth",
            "fullwidthUpper",
          ),
          { minLength: canonicalChars.length, maxLength: canonicalChars.length },
        ),
      })
      .map(({ lead, trail, transforms }) => {
        const body = canonicalChars
          .map((ch, index) => applyTransform(ch, transforms[index]))
          .join("");
        return `${lead}${body}${trail}`;
      });
    return fc.record({
      canonical: fc.constant(canonical),
      variants: fc.array(variantArbitrary, { minLength: 1, maxLength: 4 }),
    });
  });

// --- Password generation around every policy boundary ---------------------
// validatePassword counts Unicode code points, so passwords mix ASCII, an
// accented code point, and an astral emoji. Lengths cluster on the inclusive
// [12, 128] boundary (11/12/13 and 127/128/129) with random lengths mixed in.
const passwordCodePointArbitrary = fc.constantFrom("a", "B", "7", "ç", "🔐");
const passwordArbitrary = fc
  .oneof(
    fc.constantFrom(0, 1, 11, 12, 13, 64, 127, 128, 129, 130, 200),
    fc.integer({ min: 0, max: 260 }),
  )
  .chain((length) =>
    fc
      .array(passwordCodePointArbitrary, { minLength: length, maxLength: length })
      .map((codePoints) => ({
        password: codePoints.join(""),
        codePointLength: length,
      })),
  );

// A unit-of-work that commits only when the enclosed work resolves, letting the
// property observe whether registration was accepted for a given password.
function createCommittingUnitOfWork(): RegistrationUnitOfWorkPort {
  return {
    async execute<T>(
      work: (transaction: RegistrationTransactionPort) => Promise<T>,
    ): Promise<T> {
      const transaction: RegistrationTransactionPort = {
        createPartner: async (input) => input,
        createOwner: async (input) => input,
      };
      return work(transaction);
    },
  };
}

const registrationDependencies = {
  passwordHash: { hash: async (password: string) => `argon2id:${password.length}` },
  unitOfWork: createCommittingUnitOfWork(),
};

describe("Property 2: identity normalization and credential policy", () => {
  it("gives equivalent emails one identity and accepts registration only within password policy", async () => {
    await fc.assert(
      fc.asyncProperty(
        emailScenarioArbitrary,
        passwordArbitrary,
        async ({ canonical, variants }, { password, codePointLength }) => {
          // The canonical email is itself already normalized (idempotence).
          expect(normalizeEmail(canonical)).toBe(canonical);
          const canonicalValidation = validateEmail(canonical);
          expect(canonicalValidation).toEqual({ valid: true });

          // Every equivalent form collapses to exactly one canonical identity and
          // validates identically, so no ambiguous duplicate identity can exist.
          for (const variant of variants) {
            const normalized = normalizeEmail(variant);
            expect(normalized).toBe(canonical);
            expect(normalizeEmail(normalized)).toBe(normalized);
            expect(validateEmail(variant)).toEqual(canonicalValidation);
          }

          // Password policy is an inclusive code-point boundary [12, 128].
          const expectedPasswordValid =
            codePointLength >= PASSWORD_MIN_LENGTH &&
            codePointLength <= PASSWORD_MAX_LENGTH;
          const passwordValidation = validatePassword(password);
          expect(passwordValidation.valid).toBe(expectedPasswordValid);
          if (!passwordValidation.valid) {
            expect(passwordValidation.code).toBe(
              codePointLength < PASSWORD_MIN_LENGTH
                ? "PASSWORD_TOO_SHORT"
                : "PASSWORD_TOO_LONG",
            );
          }

          // Registration (email always valid here) is accepted exactly when the
          // password satisfies policy, and it persists the unique identity.
          const attempt = registerPartner(
            {
              partnerId: "partner-1",
              ownerMemberId: "member-1",
              legalName: "PT Partner",
              displayName: "Partner",
              ownerEmail: variants[0],
              ownerPassword: password,
              createdAtEpochMs: 1_800_000_000_000,
            },
            registrationDependencies,
          );

          if (expectedPasswordValid) {
            const result = await attempt;
            expect(result.owner.emailNormalized).toBe(canonical);
            expect(result.partner.status).toBe("pending");
          } else {
            await expect(attempt).rejects.toThrow(
              codePointLength < PASSWORD_MIN_LENGTH
                ? "PASSWORD_TOO_SHORT"
                : "PASSWORD_TOO_LONG",
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
