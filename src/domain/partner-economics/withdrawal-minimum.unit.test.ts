import { describe, expect, it } from "vitest";

import { PartnerEconomicsError } from "./errors";
import {
  classifyPayoutTier,
  HEROSMS_REFERENCE_MINIMUM_USD,
  meetsWithdrawalMinimum,
  type PartnerPayoutTier,
  resolveMinimumWithdrawalIdr,
  type WithdrawalMinimumConfig,
} from "./withdrawal-minimum";

// Roadmap Item 2 — minimum withdrawal per partner tier (mobile $3 vs API/hardware
// $100 as HeroSMS USD reference). See .agents/RESEARCH-HEROSMS-PARTNERS.md.

// A well-formed config with distinct, easy-to-read IDR floors.
const CONFIG: WithdrawalMinimumConfig = Object.freeze({
  mobileMinimumIdr: 50_000,
  standardMinimumIdr: 1_500_000,
});

describe("HEROSMS_REFERENCE_MINIMUM_USD", () => {
  it("documents the HeroSMS USD reference floors and is frozen", () => {
    expect(HEROSMS_REFERENCE_MINIMUM_USD.mobile).toBe(3);
    expect(HEROSMS_REFERENCE_MINIMUM_USD.standard).toBe(100);
    expect(Object.isFrozen(HEROSMS_REFERENCE_MINIMUM_USD)).toBe(true);
  });
});

describe("classifyPayoutTier", () => {
  it("returns 'mobile' when every device is mobile-class (android/simulator)", () => {
    expect(classifyPayoutTier(["android"])).toBe("mobile");
    expect(classifyPayoutTier(["simulator"])).toBe("mobile");
    expect(classifyPayoutTier(["android", "simulator", "android"])).toBe(
      "mobile",
    );
  });

  it("returns 'standard' when any hardware/protocol device is present", () => {
    expect(classifyPayoutTier(["modem"])).toBe("standard");
    expect(classifyPayoutTier(["goip"])).toBe("standard");
    expect(classifyPayoutTier(["api"])).toBe("standard");
    // Mixed fleet: one hardware device pulls the whole fleet to standard.
    expect(classifyPayoutTier(["android", "modem"])).toBe("standard");
    expect(classifyPayoutTier(["simulator", "android", "api"])).toBe("standard");
  });

  it("returns 'standard' for an empty fleet (absent fleet must not unlock the low floor)", () => {
    expect(classifyPayoutTier([])).toBe("standard");
  });
});

describe("resolveMinimumWithdrawalIdr", () => {
  it("returns the tier-specific IDR floor from config", () => {
    expect(resolveMinimumWithdrawalIdr("mobile", CONFIG)).toBe(50_000);
    expect(resolveMinimumWithdrawalIdr("standard", CONFIG)).toBe(1_500_000);
  });

  it("does not derive IDR from the USD reference values", () => {
    // Guards against accidentally hardcoding 3 / 100 as IDR.
    expect(resolveMinimumWithdrawalIdr("mobile", CONFIG)).not.toBe(
      HEROSMS_REFERENCE_MINIMUM_USD.mobile,
    );
    expect(resolveMinimumWithdrawalIdr("standard", CONFIG)).not.toBe(
      HEROSMS_REFERENCE_MINIMUM_USD.standard,
    );
  });

  it.each<[string, WithdrawalMinimumConfig]>([
    ["zero mobile floor", { mobileMinimumIdr: 0, standardMinimumIdr: 1_000 }],
    ["negative mobile floor", { mobileMinimumIdr: -1, standardMinimumIdr: 1_000 }],
    [
      "non-integer mobile floor",
      { mobileMinimumIdr: 50_000.5, standardMinimumIdr: 1_000 },
    ],
    [
      "NaN standard floor",
      { mobileMinimumIdr: 50_000, standardMinimumIdr: Number.NaN },
    ],
    [
      "unsafe standard floor",
      {
        mobileMinimumIdr: 50_000,
        standardMinimumIdr: Number.MAX_SAFE_INTEGER + 1,
      },
    ],
  ])("throws INVALID_CONFIG for %s", (_label, badConfig) => {
    try {
      resolveMinimumWithdrawalIdr("mobile", badConfig);
      throw new Error("expected resolveMinimumWithdrawalIdr to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PartnerEconomicsError);
      expect((error as PartnerEconomicsError).code).toBe("INVALID_CONFIG");
    }
  });

  it("validates BOTH floors even when only one tier is requested", () => {
    // Requesting the mobile floor still rejects a broken standard floor.
    const brokenStandard: WithdrawalMinimumConfig = {
      mobileMinimumIdr: 50_000,
      standardMinimumIdr: 0,
    };
    expect(() => resolveMinimumWithdrawalIdr("mobile", brokenStandard)).toThrow(
      PartnerEconomicsError,
    );
  });
});

describe("meetsWithdrawalMinimum", () => {
  it("allows an amount equal to or above the tier floor", () => {
    expect(meetsWithdrawalMinimum(50_000, "mobile", CONFIG)).toBe(true); // exact
    expect(meetsWithdrawalMinimum(50_001, "mobile", CONFIG)).toBe(true);
    expect(meetsWithdrawalMinimum(1_500_000, "standard", CONFIG)).toBe(true);
    expect(meetsWithdrawalMinimum(9_999_999, "standard", CONFIG)).toBe(true);
  });

  it("rejects an amount below the tier floor", () => {
    expect(meetsWithdrawalMinimum(49_999, "mobile", CONFIG)).toBe(false);
    expect(meetsWithdrawalMinimum(0, "mobile", CONFIG)).toBe(false);
    expect(meetsWithdrawalMinimum(1_499_999, "standard", CONFIG)).toBe(false);
    // Same amount clears the mobile floor but not the standard floor.
    expect(meetsWithdrawalMinimum(100_000, "mobile", CONFIG)).toBe(true);
    expect(meetsWithdrawalMinimum(100_000, "standard", CONFIG)).toBe(false);
  });

  it("throws for a non-integer or negative amount (money must be an IDR integer)", () => {
    expect(() => meetsWithdrawalMinimum(1_000.5, "mobile", CONFIG)).toThrow(
      PartnerEconomicsError,
    );
    expect(() => meetsWithdrawalMinimum(-1, "mobile", CONFIG)).toThrow(
      PartnerEconomicsError,
    );
  });

  it("propagates INVALID_CONFIG when the config is malformed", () => {
    const badConfig: WithdrawalMinimumConfig = {
      mobileMinimumIdr: 0,
      standardMinimumIdr: 1_000,
    };
    const tier: PartnerPayoutTier = "mobile";
    try {
      meetsWithdrawalMinimum(10_000, tier, badConfig);
      throw new Error("expected meetsWithdrawalMinimum to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PartnerEconomicsError);
      expect((error as PartnerEconomicsError).code).toBe("INVALID_CONFIG");
    }
  });
});
