import { describe, expect, it } from "vitest";

import {
  AUTO_AVERAGE_REFRESH_MS,
  AVERAGE_WINDOW_MS,
  clampToGuardrail,
  computeAutomaticAveragePriceIdr,
  type PriceGuardrail,
} from "./automatic-average-price";
import { PartnerEconomicsError } from "./errors";

// AutoPrice arithmetic layer — HeroSMS roadmap item 3
// (.agents/RESEARCH-HEROSMS-PARTNERS.md §2 "Pricing engine", §7 item 3).

const WIDE: PriceGuardrail = Object.freeze({
  minBasePriceIdr: 1,
  maxBasePriceIdr: 10_000_000,
});
const NARROW: PriceGuardrail = Object.freeze({
  minBasePriceIdr: 500,
  maxBasePriceIdr: 5_000,
});

describe("reference constants", () => {
  it("match the HeroSMS cadence (10 min) and window (1 hour)", () => {
    expect(AUTO_AVERAGE_REFRESH_MS).toBe(600_000);
    expect(AVERAGE_WINDOW_MS).toBe(3_600_000);
  });
});

describe("computeAutomaticAveragePriceIdr — arithmetic mean", () => {
  it("returns the single price when only one sale exists", () => {
    expect(
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [1_000],
        guardrail: WIDE,
      }),
    ).toBe(1_000);
  });

  it("averages two values", () => {
    expect(
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [1_000, 2_000],
        guardrail: WIDE,
      }),
    ).toBe(1_500);
  });

  it("averages three values", () => {
    expect(
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [1_000, 2_000, 3_000],
        guardrail: WIDE,
      }),
    ).toBe(2_000);
  });

  it("computes a genuine arithmetic mean (not a min/max/first)", () => {
    // mean of [100,200,300,900] = 375
    expect(
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [100, 200, 300, 900],
        guardrail: WIDE,
      }),
    ).toBe(375);
  });
});

describe("computeAutomaticAveragePriceIdr — empty window", () => {
  it("returns null when there is no recent data", () => {
    expect(
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [],
        guardrail: NARROW,
      }),
    ).toBeNull();
  });

  it("still validates config before reporting no data (invalid guardrail throws even when empty)", () => {
    expect(() =>
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [],
        guardrail: { minBasePriceIdr: 5_000, maxBasePriceIdr: 500 },
      }),
    ).toThrow(PartnerEconomicsError);
  });
});

describe("computeAutomaticAveragePriceIdr — rounding to grid", () => {
  it("rounds the mean to the nearest roundToIdr multiple (down)", () => {
    // mean of [100,101,102] = 101 -> nearest multiple of 50 is 100
    expect(
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [100, 101, 102],
        guardrail: WIDE,
        roundToIdr: 50,
      }),
    ).toBe(100);
  });

  it("rounds the mean to the nearest roundToIdr multiple (up)", () => {
    // mean of [130,140] = 135 -> nearest multiple of 50 is 150
    expect(
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [130, 140],
        guardrail: WIDE,
        roundToIdr: 50,
      }),
    ).toBe(150);
  });

  it("rounds halfway values up (ties toward +infinity)", () => {
    // mean of [25] = 25 -> exactly halfway to the next multiple of 50 -> 50
    expect(
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [25],
        guardrail: WIDE,
        roundToIdr: 50,
      }),
    ).toBe(50);
  });

  it("defaults roundToIdr to 1 (whole rupiah, nearest)", () => {
    // mean of [100,101] = 100.5 -> rounds up to 101
    expect(
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [100, 101],
        guardrail: WIDE,
      }),
    ).toBe(101);
  });
});

describe("computeAutomaticAveragePriceIdr — guardrail clamp", () => {
  it("clamps a low mean up to the minimum", () => {
    expect(
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [100],
        guardrail: NARROW,
      }),
    ).toBe(500);
  });

  it("clamps a high mean down to the maximum", () => {
    expect(
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [10_000],
        guardrail: NARROW,
      }),
    ).toBe(5_000);
  });

  it("leaves an in-range mean untouched", () => {
    expect(
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [2_000, 3_000],
        guardrail: NARROW,
      }),
    ).toBe(2_500);
  });
});

describe("computeAutomaticAveragePriceIdr — invalid input", () => {
  it("rejects a zero price", () => {
    expect(() =>
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [1_000, 0],
        guardrail: WIDE,
      }),
    ).toThrow(PartnerEconomicsError);
  });

  it("rejects a negative price", () => {
    expect(() =>
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [-1],
        guardrail: WIDE,
      }),
    ).toThrow(PartnerEconomicsError);
  });

  it("rejects a non-integer price", () => {
    expect(() =>
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [1_000.5],
        guardrail: WIDE,
      }),
    ).toThrow(PartnerEconomicsError);
  });

  it("rejects a guardrail whose minimum exceeds its maximum", () => {
    expect(() =>
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [1_000],
        guardrail: { minBasePriceIdr: 5_000, maxBasePriceIdr: 500 },
      }),
    ).toThrow(PartnerEconomicsError);
  });

  it("rejects a non-positive guardrail bound", () => {
    expect(() =>
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [1_000],
        guardrail: { minBasePriceIdr: 0, maxBasePriceIdr: 5_000 },
      }),
    ).toThrow(PartnerEconomicsError);
  });

  it("rejects a roundToIdr below 1", () => {
    expect(() =>
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [1_000],
        guardrail: WIDE,
        roundToIdr: 0,
      }),
    ).toThrow(PartnerEconomicsError);
  });

  it("rejects a negative roundToIdr", () => {
    expect(() =>
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [1_000],
        guardrail: WIDE,
        roundToIdr: -50,
      }),
    ).toThrow(PartnerEconomicsError);
  });

  it("guards against summation overflowing the safe integer range", () => {
    expect(() =>
      computeAutomaticAveragePriceIdr({
        recentSuccessfulPricesIdr: [Number.MAX_SAFE_INTEGER, 1],
        guardrail: { minBasePriceIdr: 1, maxBasePriceIdr: Number.MAX_SAFE_INTEGER },
      }),
    ).toThrow(PartnerEconomicsError);
  });
});

describe("clampToGuardrail", () => {
  it("pulls a below-range price up to the minimum", () => {
    expect(clampToGuardrail(300, NARROW)).toBe(500);
  });

  it("pulls an above-range price down to the maximum", () => {
    expect(clampToGuardrail(6_000, NARROW)).toBe(5_000);
  });

  it("returns an in-range price unchanged", () => {
    expect(clampToGuardrail(1_000, NARROW)).toBe(1_000);
  });

  it("returns the bound exactly at each edge", () => {
    expect(clampToGuardrail(500, NARROW)).toBe(500);
    expect(clampToGuardrail(5_000, NARROW)).toBe(5_000);
  });

  it("rejects an invalid guardrail", () => {
    expect(() =>
      clampToGuardrail(1_000, { minBasePriceIdr: 5_000, maxBasePriceIdr: 500 }),
    ).toThrow(PartnerEconomicsError);
  });

  it("rejects a non-integer price", () => {
    expect(() => clampToGuardrail(1_000.5, NARROW)).toThrow(PartnerEconomicsError);
  });
});
