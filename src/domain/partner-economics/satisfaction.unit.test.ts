import { describe, expect, it } from "vitest";

import { PartnerEconomicsError } from "./errors";
import {
  bandForPercent,
  computeSatisfaction,
  GREEN_THRESHOLD_PERCENT,
  RED_THRESHOLD_PERCENT,
  type SatisfactionResult,
} from "./satisfaction";

// Roadmap item 4 — Overall satisfaction metric (HeroSMS Partners study).
// satisfaction = (successfullyIssued / totalRequests) * 100%.
// Bands: >60% green, 30–60% yellow, <30% red.

describe("thresholds", () => {
  it("pins the HeroSMS colour thresholds", () => {
    expect(GREEN_THRESHOLD_PERCENT).toBe(60);
    expect(RED_THRESHOLD_PERCENT).toBe(30);
  });
});

describe("bandForPercent", () => {
  it("returns green strictly above 60%", () => {
    expect(bandForPercent(60.1)).toBe("green");
    expect(bandForPercent(75)).toBe("green");
    expect(bandForPercent(100)).toBe("green");
  });

  it("treats exactly 60% as yellow, not green", () => {
    expect(bandForPercent(60)).toBe("yellow");
  });

  it("treats exactly 30% as yellow, not red", () => {
    expect(bandForPercent(30)).toBe("yellow");
  });

  it("returns yellow across the inclusive 30–60 band", () => {
    expect(bandForPercent(30)).toBe("yellow");
    expect(bandForPercent(45)).toBe("yellow");
    expect(bandForPercent(60)).toBe("yellow");
  });

  it("returns red strictly below 30%", () => {
    expect(bandForPercent(29.9)).toBe("red");
    expect(bandForPercent(10)).toBe("red");
    expect(bandForPercent(0)).toBe("red");
  });

  it("rejects non-finite or negative percents", () => {
    expect(() => bandForPercent(Number.NaN)).toThrowError(PartnerEconomicsError);
    expect(() => bandForPercent(Number.POSITIVE_INFINITY)).toThrowError(
      PartnerEconomicsError,
    );
    expect(() => bandForPercent(-1)).toThrowError(PartnerEconomicsError);
    try {
      bandForPercent(-0.0001);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PartnerEconomicsError);
      expect((error as PartnerEconomicsError).code).toBe("INVALID_RATIO");
    }
  });
});

describe("computeSatisfaction — bands", () => {
  it("bands a clearly green window", () => {
    const result = computeSatisfaction({
      successfullyIssued: 61,
      totalRequests: 100,
    });
    expect(result).not.toBeNull();
    const r = result as SatisfactionResult;
    expect(r.percent).toBe(61);
    expect(r.ratio).toBeCloseTo(0.61, 10);
    expect(r.band).toBe("green");
  });

  it("bands exactly 60% as yellow (boundary is not green)", () => {
    const r = computeSatisfaction({
      successfullyIssued: 60,
      totalRequests: 100,
    }) as SatisfactionResult;
    expect(r.percent).toBe(60);
    expect(r.band).toBe("yellow");
  });

  it("bands exactly 30% as yellow (boundary is not red)", () => {
    const r = computeSatisfaction({
      successfullyIssued: 30,
      totalRequests: 100,
    }) as SatisfactionResult;
    expect(r.percent).toBe(30);
    expect(r.band).toBe("yellow");
  });

  it("bands just below 30% as red", () => {
    const r = computeSatisfaction({
      successfullyIssued: 29,
      totalRequests: 100,
    }) as SatisfactionResult;
    expect(r.percent).toBe(29);
    expect(r.band).toBe("red");
  });

  it("bands a perfect window as green with ratio 1", () => {
    const r = computeSatisfaction({
      successfullyIssued: 100,
      totalRequests: 100,
    }) as SatisfactionResult;
    expect(r.ratio).toBe(1);
    expect(r.percent).toBe(100);
    expect(r.band).toBe("green");
  });

  it("bands a zero-success window as red with ratio 0", () => {
    const r = computeSatisfaction({
      successfullyIssued: 0,
      totalRequests: 100,
    }) as SatisfactionResult;
    expect(r.ratio).toBe(0);
    expect(r.percent).toBe(0);
    expect(r.band).toBe("red");
  });
});

describe("computeSatisfaction — rounding to 1 decimal", () => {
  it("rounds 1/3 to 33.3% (yellow)", () => {
    const r = computeSatisfaction({
      successfullyIssued: 1,
      totalRequests: 3,
    }) as SatisfactionResult;
    expect(r.percent).toBe(33.3);
    expect(r.ratio).toBeCloseTo(1 / 3, 12);
    expect(r.band).toBe("yellow");
  });

  it("rounds 2/3 to 66.7% (green)", () => {
    const r = computeSatisfaction({
      successfullyIssued: 2,
      totalRequests: 3,
    }) as SatisfactionResult;
    expect(r.percent).toBe(66.7);
    expect(r.band).toBe("green");
  });

  it("represents 1/8 exactly as 12.5% (red)", () => {
    const r = computeSatisfaction({
      successfullyIssued: 1,
      totalRequests: 8,
    }) as SatisfactionResult;
    expect(r.percent).toBe(12.5);
    expect(r.band).toBe("red");
  });
});

describe("computeSatisfaction — undefined and invalid inputs", () => {
  it("returns null when there is no demand (totalRequests === 0)", () => {
    expect(
      computeSatisfaction({ successfullyIssued: 0, totalRequests: 0 }),
    ).toBeNull();
  });

  it("throws INVALID_RATIO when successes exceed requests", () => {
    try {
      computeSatisfaction({ successfullyIssued: 5, totalRequests: 4 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PartnerEconomicsError);
      expect((error as PartnerEconomicsError).code).toBe("INVALID_RATIO");
    }
  });

  it("throws on negative counters", () => {
    expect(() =>
      computeSatisfaction({ successfullyIssued: -1, totalRequests: 10 }),
    ).toThrowError(PartnerEconomicsError);
    expect(() =>
      computeSatisfaction({ successfullyIssued: 0, totalRequests: -1 }),
    ).toThrowError(PartnerEconomicsError);
  });

  it("throws on non-integer counters", () => {
    expect(() =>
      computeSatisfaction({ successfullyIssued: 1.5, totalRequests: 10 }),
    ).toThrowError(PartnerEconomicsError);
    expect(() =>
      computeSatisfaction({ successfullyIssued: 1, totalRequests: 10.5 }),
    ).toThrowError(PartnerEconomicsError);
    expect(() =>
      computeSatisfaction({
        successfullyIssued: Number.NaN,
        totalRequests: 10,
      }),
    ).toThrowError(PartnerEconomicsError);
  });
});

describe("computeSatisfaction — result shape", () => {
  it("returns a frozen result", () => {
    const r = computeSatisfaction({
      successfullyIssued: 7,
      totalRequests: 10,
    }) as SatisfactionResult;
    expect(Object.isFrozen(r)).toBe(true);
    expect(r.percent).toBe(70);
    expect(r.band).toBe("green");
  });
});
