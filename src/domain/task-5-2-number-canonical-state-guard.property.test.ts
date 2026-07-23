import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  Task52DomainError,
  assertNumberMoveOrDeleteAllowed,
  assertUniqueActiveNumber,
  disableIdleNumber,
  normalizeIndonesianNumber,
  type ExistingNumberIdentity,
  type NumberStatus,
} from "@domain/task-5-2-device-inventory-pricing";

// Feature: partner-platform, Property 9: Nomor kanonik unik dan state-guarded
//
// For all representasi valid nomor Indonesia, normalisasi berulang idempotent
// dan menghasilkan E.164 yang sama untuk representasi ekuivalen; maksimal satu
// nomor non-disabled memakai nilai kanonik tersebut, dan nomor `reserved|busy`
// tidak dapat dipindah atau dihapus.
//
// Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5
//
// Design references:
// - Normalisasi memakai E.164 dan unique `(canonicalNumber)` untuk status
//   non-disabled pada MVP (Components §9 Device dan Number).
// - Number tidak boleh dipindah/dihapus pada reserved/busy (Components §9).
// - Pure domain test tidak memakai DB/network (Testing Strategy).
// - Property 9 bukan bagian target 500-run (parser/pricing/state-machine/
//   ledger), sehingga numRuns minimum 100.

const NUM_RUNS = 100;

const ALL_NUMBER_STATUSES: readonly NumberStatus[] = [
  "offline",
  "available",
  "reserved",
  "busy",
  "disabled",
];

/**
 * Bangun bagian national number Indonesia yang selalu valid terhadap regex
 * kanonik domain `^\+628[1-9]\d{8,11}$`: diawali "8", satu digit 1-9, lalu
 * 8-11 digit bebas.
 */
const digitArbitrary = fc.integer({ min: 0, max: 9 }).map(String);
const nonZeroDigitArbitrary = fc.integer({ min: 1, max: 9 }).map(String);

const nationalArbitrary = fc
  .tuple(nonZeroDigitArbitrary, fc.array(digitArbitrary, { minLength: 8, maxLength: 11 }))
  .map(([second, rest]) => `8${second}${rest.join("")}`);

// Semua prefix ini ekuivalen dan harus dinormalisasi ke national yang sama.
const prefixArbitrary = fc.constantFrom("+62", "62", "0062", "0");

// Separator yang dihapus domain (`[\s().-]`); menyisipkannya tidak boleh
// mengubah hasil normalisasi.
const separatorArbitrary = fc.constantFrom(" ", "-", ".", "(", ")");
const insertionArbitrary = fc.record({ index: fc.nat(), sep: separatorArbitrary });
const insertionsArbitrary = fc.array(insertionArbitrary, { maxLength: 6 });

interface ReprInstruction {
  readonly prefix: string;
  readonly insertions: readonly { readonly index: number; readonly sep: string }[];
}

const reprInstructionArbitrary: fc.Arbitrary<ReprInstruction> = fc.record({
  prefix: prefixArbitrary,
  insertions: insertionsArbitrary,
});

function applyInsertions(
  raw: string,
  insertions: readonly { readonly index: number; readonly sep: string }[],
): string {
  let value = raw;
  for (const { index, sep } of insertions) {
    const at = Math.min(index, value.length);
    value = value.slice(0, at) + sep + value.slice(at);
  }
  return value;
}

function renderRepresentation(national: string, instruction: ReprInstruction): string {
  return applyInsertions(`${instruction.prefix}${national}`, instruction.insertions);
}

interface ExistingInstruction {
  readonly status: NumberStatus;
  readonly sameAsTarget: boolean;
  readonly otherNational: string;
  readonly repr: ReprInstruction;
}

const existingInstructionArbitrary: fc.Arbitrary<ExistingInstruction> = fc.record({
  status: fc.constantFrom(...ALL_NUMBER_STATUSES),
  sameAsTarget: fc.boolean(),
  otherNational: nationalArbitrary,
  repr: reprInstructionArbitrary,
});

const scenarioArbitrary = fc.record({
  national: nationalArbitrary,
  representations: fc.array(reprInstructionArbitrary, { minLength: 1, maxLength: 5 }),
  existing: fc.array(existingInstructionArbitrary, { maxLength: 8 }),
  excludedSelector: fc.option(fc.nat(), { nil: undefined }),
  guardStatus: fc.constantFrom(...ALL_NUMBER_STATUSES),
});

function expectDomainError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Task52DomainError);
    expect((error as Task52DomainError).code).toBe(code);
    return;
  }
  throw new Error(`Expected Task52DomainError(${code}) to be thrown`);
}

describe("Property 9: Nomor kanonik unik dan state-guarded", () => {
  it("normalizes equivalent representations idempotently and enforces uniqueness + state guards", () => {
    fc.assert(
      fc.property(scenarioArbitrary, (scenario) => {
        const targetCanonical = `+62${scenario.national}`;

        // (7.1, 7.2) Idempotency + equivalence: every equivalent representation
        // normalizes to the same E.164 canonical, and normalizing again is a
        // no-op.
        const renderedRepresentations = scenario.representations.map((instruction) =>
          renderRepresentation(scenario.national, instruction),
        );
        for (const representation of renderedRepresentations) {
          const canonical = normalizeIndonesianNumber(representation);
          expect(canonical).toBe(targetCanonical);
          expect(normalizeIndonesianNumber(canonical)).toBe(canonical);
        }

        // Build the existing inventory referencing valid canonical numbers only.
        const existing: ExistingNumberIdentity[] = scenario.existing.map((instruction, index) => ({
          id: `existing-${index}`,
          status: instruction.status,
          canonicalNumber: instruction.sameAsTarget
            ? renderRepresentation(scenario.national, instruction.repr)
            : renderRepresentation(instruction.otherNational, instruction.repr),
        }));

        const excludedNumberId =
          scenario.excludedSelector === undefined || existing.length === 0
            ? undefined
            : existing[scenario.excludedSelector % existing.length].id;

        // Independent oracle for the dedupe predicate documented by the domain:
        // a duplicate exists when a non-disabled, non-excluded entry shares the
        // canonical value.
        const expectedDuplicate = existing.some(
          (entry) =>
            entry.id !== excludedNumberId &&
            entry.status !== "disabled" &&
            normalizeIndonesianNumber(entry.canonicalNumber) === targetCanonical,
        );

        const input = renderedRepresentations[0];
        if (expectedDuplicate) {
          // (7.2) At most one non-disabled number may use the canonical value.
          expectDomainError(
            () => assertUniqueActiveNumber(input, existing, excludedNumberId),
            "DUPLICATE_ACTIVE_NUMBER",
          );
        } else {
          expect(assertUniqueActiveNumber(input, existing, excludedNumberId)).toBe(targetCanonical);
        }

        // (7.3, 7.4, 7.5) reserved|busy numbers cannot be moved or deleted;
        // every other status permits move/delete and idle-disable.
        const held = scenario.guardStatus === "reserved" || scenario.guardStatus === "busy";
        if (held) {
          expectDomainError(
            () => assertNumberMoveOrDeleteAllowed(scenario.guardStatus),
            "NUMBER_STATE_GUARD",
          );
          expectDomainError(() => disableIdleNumber(scenario.guardStatus), "NUMBER_STATE_GUARD");
        } else {
          expect(assertNumberMoveOrDeleteAllowed(scenario.guardStatus)).toBeUndefined();
          expect(disableIdleNumber(scenario.guardStatus)).toBe("disabled");
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
