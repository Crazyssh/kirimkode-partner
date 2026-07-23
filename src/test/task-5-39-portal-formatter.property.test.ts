import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  formatIdr,
  formatJakartaTimestamp,
} from "@domain/task-5-7/formatter";

/**
 * Feature: partner-platform, Property 32: Format portal deterministik. For all
 * nominal integer IDR dan timestamp valid, formatter menghasilkan mata uang
 * tanpa pecahan dan waktu `Asia/Jakarta` secara deterministik tanpa mengubah
 * nilai sumber UTC.
 *
 * **Validates: Requirements 15.4**
 *
 * Strategy: generate a safe-integer IDR amount (including zero, negatives, small
 * and large magnitudes) together with a valid UTC instant expressed as a `Date`
 * whose year stays four digits after the fixed Asia/Jakarta (+7h) shift. From
 * these independently-known inputs we assert four invariants against
 * independent oracles (never re-using the implementation's internals):
 *   1. No fractions — the currency string matches `-?Rp` followed by
 *      dot-grouped digit triples with no decimal component, and parsing the
 *      digits back recovers the exact source integer (Req 15.4).
 *   2. Asia/Jakarta — the timestamp equals the UTC instant shifted by a fixed
 *      +7h WIB offset, rendered `YYYY-MM-DD HH:mm:ss WIB`, computed by an
 *      oracle that does not import the formatter's offset constant (Req 15.4).
 *   3. UTC source immutable — reading the source `Date` for formatting never
 *      mutates it (`getTime()` is unchanged), and passing the equivalent epoch
 *      number yields the identical string (Req 15.4).
 *   4. Deterministic — both formatters return byte-identical output on repeated
 *      calls with the same input.
 */

// A safe UTC instant whose Jakarta-shifted year remains four digits, so the
// canonical `YYYY-MM-DD` rendering is well-defined for the assertion regex.
const jakartaSourceArbitrary: fc.Arbitrary<Date> = fc.date({
  min: new Date("1000-01-01T00:00:00.000Z"),
  max: new Date("9990-12-31T00:00:00.000Z"),
  noInvalidDate: true,
});

// Integer IDR amounts across zero, sign, and magnitude.
const idrAmountArbitrary: fc.Arbitrary<number> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: -10_000_000_000, max: 10_000_000_000 }) },
  { weight: 1, arbitrary: fc.constantFrom(0, 1, -1, 999, 1_000, -1_000, 1_234_567, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER) },
);

const IDR_SHAPE = /^-?Rp\d{1,3}(\.\d{3})*$/;
const TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} WIB$/;

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/** Independent Asia/Jakarta oracle — does not import the formatter constant. */
function expectedJakartaTimestamp(epochMs: number): string {
  const shifted = new Date(epochMs + JAKARTA_OFFSET_MS);
  const date = `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
  return `${date} ${time} WIB`;
}

describe("Property 32: Portal formatter is deterministic (IDR + Asia/Jakarta)", () => {
  it("formats integer IDR without fractions and UTC instants as Asia/Jakarta without mutating the source", () => {
    fc.assert(
      fc.property(idrAmountArbitrary, jakartaSourceArbitrary, (amount, source) => {
        // --- Currency: no fractions, value-preserving, deterministic ---------
        const money = formatIdr(amount);
        // Invariant 1a: canonical dot-grouped shape with no decimal component.
        expect(money).toMatch(IDR_SHAPE);
        // Invariant 1b: sign is present iff the amount is negative.
        expect(money.startsWith("-")).toBe(amount < 0);
        // Invariant 1c: stripping "Rp" and grouping dots recovers the integer,
        // proving no fractional part was introduced or lost.
        const negative = money.startsWith("-");
        const magnitudeText = (negative ? money.slice(1) : money).slice(2).replace(/\./g, "");
        const reparsed = Number(magnitudeText) * (negative ? -1 : 1);
        expect(reparsed).toBe(amount);
        // Invariant 4a: deterministic.
        expect(formatIdr(amount)).toBe(money);

        // --- Timestamp: Asia/Jakarta, immutable source, deterministic --------
        const epochMs = source.getTime();
        const before = epochMs;
        const stamp = formatJakartaTimestamp(source);
        // Invariant 3a: reading the Date never mutated it.
        expect(source.getTime()).toBe(before);
        // Invariant 2a: canonical WIB shape.
        expect(stamp).toMatch(TIMESTAMP_SHAPE);
        // Invariant 2b: equals the independent +7h oracle.
        expect(stamp).toBe(expectedJakartaTimestamp(epochMs));
        // Invariant 3b: number and Date inputs are equivalent.
        expect(formatJakartaTimestamp(epochMs)).toBe(stamp);
        // Invariant 4b: deterministic.
        expect(formatJakartaTimestamp(source)).toBe(stamp);
      }),
      { numRuns: 300 },
    );
  });
});
