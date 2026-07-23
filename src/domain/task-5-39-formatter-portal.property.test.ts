import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  formatIdr,
  formatJakartaTimestamp,
  toJakartaParts,
  JAKARTA_TZ_LABEL,
  Task57DomainError,
} from "@domain/task-5-7";

// Feature: partner-platform, Property 32: Format portal deterministik
//
// For all nominal integer IDR dan timestamp valid, formatter menghasilkan mata
// uang tanpa pecahan dan waktu `Asia/Jakarta` secara deterministik tanpa
// mengubah nilai sumber UTC.
//
// Konkretnya, untuk setiap safe-integer IDR dan setiap epoch UTC yang valid
// (0 .. tahun 9999):
//   - formatIdr menghasilkan string `Rp` bertanda benar, digit dikelompokkan
//     per tiga dengan pemisah ribuan `.`, TANPA separator desimal `,` dan tanpa
//     pecahan (digit yang tersisa persis sama dengan |amount|);
//   - formatJakartaTimestamp menghasilkan `YYYY-MM-DD HH:mm:ss WIB` yang identik
//     dengan wall-clock Asia/Jakarta (dibuktikan oleh oracle Intl independen);
//   - kedua formatter deterministik (pemanggilan ulang menghasilkan output yang
//     sama byte-per-byte);
//   - sumber UTC tidak pernah dimutasi (Date input mempertahankan getTime()).
//
// **Validates: Requirements 15.4**
//
// Design references:
// - "Nilai uang diformat IDR tanpa desimal dan timestamp `Asia/Jakarta`,
//   sementara storage UTC" (Design §11, Req 15.4).
// - "Semua waktu disimpan UTC dan ditampilkan `Asia/Jakarta`" (Keputusan Final).
// - Pure domain test tidak memakai DB/network (Testing Strategy).
// - Property 32 bukan bagian dari set 500-run (parser/pricing/state machine/
//   ledger); memakai numRuns >= minimum 100 per Testing Strategy.

const NUM_RUNS = 300;

// Independent thousands-grouping oracle. Built with an explicit right-to-left
// loop rather than the implementation's lookahead regex so the two disagree if
// grouping/sign handling regresses.
function groupIdrOracle(amountIdr: number): string {
  const negative = amountIdr < 0;
  const digits = Math.abs(amountIdr).toString();
  let grouped = "";
  let count = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    grouped = digits[i] + grouped;
    count += 1;
    if (count % 3 === 0 && i > 0) {
      grouped = "." + grouped;
    }
  }
  return `${negative ? "-" : ""}Rp${grouped}`;
}

// Independent Asia/Jakarta oracle backed by the ICU timezone database. Node 20+
// ships full ICU, so this genuinely resolves the "Asia/Jakarta" zone (UTC+7, no
// DST) independently of the implementation's fixed-offset arithmetic.
const jakartaFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Jakarta",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function oracleJakartaParts(epochMs: number): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = jakartaFmt.formatToParts(new Date(epochMs));
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  // hour12:false renders midnight as "24" on some ICU builds; normalise to 0.
  let hour = Number.parseInt(get("hour"), 10);
  if (hour === 24) hour = 0;
  return {
    year: Number.parseInt(get("year"), 10),
    month: Number.parseInt(get("month"), 10),
    day: Number.parseInt(get("day"), 10),
    hour,
    minute: Number.parseInt(get("minute"), 10),
    second: Number.parseInt(get("second"), 10),
  };
}

// Safe-integer IDR amounts: positive, negative, zero, and the safe boundaries.
const amountArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 8, arbitrary: fc.integer({ min: -50_000_000, max: 50_000_000 }) },
  { weight: 1, arbitrary: fc.constant(0) },
  { weight: 1, arbitrary: fc.constantFrom(1, -1, 999, 1000, -1000, 1_000_000) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
    ),
  },
);

// Valid UTC instants as epoch milliseconds in [1970-01-01, 9999-12-31] so the
// 4-digit year output stays well defined. Represented as a Date to exercise the
// "UTC source immutable" clause against a mutable Date input.
const MAX_EPOCH_MS = 253_402_214_400_000; // 9999-12-31T00:00:00Z
const epochMsArb: fc.Arbitrary<number> = fc.integer({
  min: 0,
  max: MAX_EPOCH_MS,
});

describe("Property 32: Format portal deterministik", () => {
  it("formats IDR without fractions and UTC instants as deterministic Asia/Jakarta time without mutating the source", () => {
    fc.assert(
      fc.property(amountArb, epochMsArb, (amount, epochMs) => {
        // --- Currency: no fraction digits, correct grouping/sign, deterministic.
        const money = formatIdr(amount);
        expect(money).toBe(groupIdrOracle(amount));
        expect(formatIdr(amount)).toBe(money); // deterministic
        // No decimal separator and no fractional part: the id-ID decimal marker
        // is ",", which must never appear; "." is only a thousands separator.
        expect(money).not.toContain(",");
        // Stripping every non-digit recovers exactly |amount| — nothing is lost
        // and no fractional ".00" tail is introduced.
        expect(money.replace(/\D/g, "")).toBe(Math.abs(amount).toString());
        expect(/^-?Rp\d{1,3}(\.\d{3})*$/.test(money)).toBe(true);

        // --- Timestamp: capture the source clock to prove immutability.
        const source = new Date(epochMs);
        const before = source.getTime();

        const stamp = formatJakartaTimestamp(source);
        // Deterministic across repeated calls and equivalent number/Date inputs.
        expect(formatJakartaTimestamp(source)).toBe(stamp);
        expect(formatJakartaTimestamp(epochMs)).toBe(stamp);

        // Shape: YYYY-MM-DD HH:mm:ss WIB.
        expect(
          /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} WIB$/.test(stamp),
        ).toBe(true);
        expect(stamp.endsWith(` ${JAKARTA_TZ_LABEL}`)).toBe(true);

        // Asia/Jakarta wall-clock equals the independent ICU oracle.
        const oracle = oracleJakartaParts(epochMs);
        const expectedStamp = `${oracle.year.toString().padStart(4, "0")}-${oracle.month
          .toString()
          .padStart(2, "0")}-${oracle.day.toString().padStart(2, "0")} ${oracle.hour
          .toString()
          .padStart(2, "0")}:${oracle.minute
          .toString()
          .padStart(2, "0")}:${oracle.second.toString().padStart(2, "0")} WIB`;
        expect(stamp).toBe(expectedStamp);

        // toJakartaParts agrees with the oracle and with the rendered string.
        const parts = toJakartaParts(source);
        expect(parts).toEqual(oracle);

        // UTC source immutable: the input Date is only read, never advanced.
        expect(source.getTime()).toBe(before);
        expect(source.getTime()).toBe(epochMs);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("anchors the MVP default rendering (Rp1.000 and a known UTC instant)", () => {
    // Concrete sanity anchors for Req 15.4: base Rp1.000 and the 15% markup
    // retail Rp1.400 render without decimals; a fixed UTC instant renders in WIB
    // (UTC+7): 2024-01-01T00:00:00Z -> 2024-01-01 07:00:00 WIB.
    expect(formatIdr(1000)).toBe("Rp1.000");
    expect(formatIdr(1400)).toBe("Rp1.400");
    expect(formatIdr(-1400)).toBe("-Rp1.400");
    expect(formatIdr(0)).toBe("Rp0");
    expect(formatJakartaTimestamp(Date.UTC(2024, 0, 1, 0, 0, 0))).toBe(
      "2024-01-01 07:00:00 WIB",
    );
  });

  it("rejects non-integer IDR amounts so money never carries a fraction", () => {
    // Guard clause anchor: fractional/unsafe amounts are refused rather than
    // silently rounded, preserving the integer-Rupiah invariant (Req 15.4).
    expect(() => formatIdr(10.5)).toThrow(Task57DomainError);
    expect(() => formatIdr(Number.NaN)).toThrow(Task57DomainError);
    expect(() => formatIdr(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      Task57DomainError,
    );
  });
});
