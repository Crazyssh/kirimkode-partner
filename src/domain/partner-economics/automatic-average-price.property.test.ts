import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  clampToGuardrail,
  computeAutomaticAveragePriceIdr,
} from "./automatic-average-price";

// AutoPrice arithmetic layer — HeroSMS roadmap item 3
// (.agents/RESEARCH-HEROSMS-PARTNERS.md §2 "Pricing engine", §7 item 3).
//
// Properties:
//  - A non-empty window always yields a price inside [min, max].
//  - An empty window always yields null (no data).
//  - With a whole-rupiah grid and a guardrail wide enough to never clamp, the
//    result equals the arithmetic mean rounded to the nearest integer.
//  - With a grid whose guardrail bounds are themselves multiples of the grid,
//    the result is always a multiple of roundToIdr.
//
// Pure domain test: no DB/network/clock (Testing Strategy). This module is not
// part of the 500-run nightly set, so numRuns uses the 100 minimum.

const NUM_RUNS = 100;

// Bounded so intermediate sums stay well inside the safe integer range.
const priceArb = fc.integer({ min: 1, max: 5_000_000 });
const pricesArb = fc.array(priceArb, { minLength: 1, maxLength: 40 });

const guardrailArb = fc
  .record({
    min: fc.integer({ min: 1, max: 2_000_000 }),
    span: fc.integer({ min: 0, max: 2_000_000 }),
  })
  .map(({ min, span }) => ({
    minBasePriceIdr: min,
    maxBasePriceIdr: min + span,
  }));

describe("Property: automatic average price invariants", () => {
  it("keeps every non-null result inside the guardrail", () => {
    fc.assert(
      fc.property(
        pricesArb,
        guardrailArb,
        fc.integer({ min: 1, max: 1_000 }),
        (prices, guardrail, roundToIdr) => {
          const result = computeAutomaticAveragePriceIdr({
            recentSuccessfulPricesIdr: prices,
            guardrail,
            roundToIdr,
          });
          expect(result).not.toBeNull();
          const value = result as number;
          expect(value).toBeGreaterThanOrEqual(guardrail.minBasePriceIdr);
          expect(value).toBeLessThanOrEqual(guardrail.maxBasePriceIdr);
          expect(Number.isSafeInteger(value)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("returns null for an empty window regardless of guardrail", () => {
    fc.assert(
      fc.property(guardrailArb, fc.integer({ min: 1, max: 1_000 }), (guardrail, roundToIdr) => {
        expect(
          computeAutomaticAveragePriceIdr({
            recentSuccessfulPricesIdr: [],
            guardrail,
            roundToIdr,
          }),
        ).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("equals the nearest-integer arithmetic mean when the guardrail never clamps", () => {
    // Prices are small; the guardrail spans far beyond any possible mean, so the
    // clamp is a no-op and the result is purely the rounded mean.
    const smallPrices = fc.array(fc.integer({ min: 1, max: 5_000 }), {
      minLength: 1,
      maxLength: 40,
    });
    const wide = { minBasePriceIdr: 1, maxBasePriceIdr: 100_000_000 };
    fc.assert(
      fc.property(smallPrices, (prices) => {
        const sum = prices.reduce((total, p) => total + p, 0);
        const expected = Math.round(sum / prices.length);
        expect(
          computeAutomaticAveragePriceIdr({
            recentSuccessfulPricesIdr: prices,
            guardrail: wide,
          }),
        ).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("returns a multiple of roundToIdr when the guardrail bounds are on the grid", () => {
    const gridGuardrailArb = fc
      .record({
        roundToIdr: fc.integer({ min: 1, max: 1_000 }),
        minUnits: fc.integer({ min: 1, max: 2_000 }),
        spanUnits: fc.integer({ min: 0, max: 2_000 }),
      })
      .map(({ roundToIdr, minUnits, spanUnits }) => ({
        roundToIdr,
        guardrail: {
          minBasePriceIdr: minUnits * roundToIdr,
          maxBasePriceIdr: (minUnits + spanUnits) * roundToIdr,
        },
      }));
    fc.assert(
      fc.property(pricesArb, gridGuardrailArb, (prices, { roundToIdr, guardrail }) => {
        const result = computeAutomaticAveragePriceIdr({
          recentSuccessfulPricesIdr: prices,
          guardrail,
          roundToIdr,
        });
        expect(result).not.toBeNull();
        expect((result as number) % roundToIdr).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("is idempotent under clampToGuardrail (result already lies on the guardrail)", () => {
    fc.assert(
      fc.property(
        pricesArb,
        guardrailArb,
        fc.integer({ min: 1, max: 1_000 }),
        (prices, guardrail, roundToIdr) => {
          const result = computeAutomaticAveragePriceIdr({
            recentSuccessfulPricesIdr: prices,
            guardrail,
            roundToIdr,
          });
          const value = result as number;
          expect(clampToGuardrail(value, guardrail)).toBe(value);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
