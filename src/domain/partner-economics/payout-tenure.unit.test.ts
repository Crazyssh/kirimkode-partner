import { describe, expect, it } from "vitest";

import { PartnerEconomicsError } from "./errors";
import {
  ACTIVE_SALES_MATURITY_DAYS,
  describeTenure,
  type EarningHoldTenureInput,
  IMMATURE_HOLD_MS,
  MATURE_HOLD_MS,
  resolveEarningHoldMs,
} from "./payout-tenure";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-24T00:00:00.000Z");

function saleDaysAgo(days: number, from: Date = NOW): Date {
  return new Date(from.getTime() - days * MS_PER_DAY);
}

/** Run `fn`, returning the thrown error, or fail if it does not throw. */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected function to throw, but it returned normally");
}

describe("payout-tenure constants", () => {
  it("encodes the HeroSMS tenure rule", () => {
    expect(ACTIVE_SALES_MATURITY_DAYS).toBe(30);
    expect(IMMATURE_HOLD_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(MATURE_HOLD_MS).toBe(24 * 60 * 60 * 1000);
    // Immature partners are held strictly longer than matured ones.
    expect(IMMATURE_HOLD_MS).toBeGreaterThan(MATURE_HOLD_MS);
  });
});

describe("resolveEarningHoldMs", () => {
  it("returns the immature hold when there is no successful sale yet", () => {
    expect(
      resolveEarningHoldMs({ firstSuccessfulSaleAt: null, now: NOW }),
    ).toBe(IMMATURE_HOLD_MS);
  });

  it("returns the immature hold on the day of the first sale (elapsed 0)", () => {
    expect(
      resolveEarningHoldMs({ firstSuccessfulSaleAt: NOW, now: NOW }),
    ).toBe(IMMATURE_HOLD_MS);
  });

  it("returns the immature hold one day before maturity", () => {
    expect(
      resolveEarningHoldMs({ firstSuccessfulSaleAt: saleDaysAgo(29), now: NOW }),
    ).toBe(IMMATURE_HOLD_MS);
  });

  it("returns the immature hold one millisecond before maturity", () => {
    const firstSale = new Date(
      NOW.getTime() - (ACTIVE_SALES_MATURITY_DAYS * MS_PER_DAY - 1),
    );
    expect(
      resolveEarningHoldMs({ firstSuccessfulSaleAt: firstSale, now: NOW }),
    ).toBe(IMMATURE_HOLD_MS);
  });

  it("returns the mature hold exactly at the maturity boundary", () => {
    expect(
      resolveEarningHoldMs({
        firstSuccessfulSaleAt: saleDaysAgo(ACTIVE_SALES_MATURITY_DAYS),
        now: NOW,
      }),
    ).toBe(MATURE_HOLD_MS);
  });

  it("returns the mature hold well past maturity", () => {
    expect(
      resolveEarningHoldMs({ firstSuccessfulSaleAt: saleDaysAgo(120), now: NOW }),
    ).toBe(MATURE_HOLD_MS);
  });

  it("honours custom maturity window and hold overrides", () => {
    const input: EarningHoldTenureInput = {
      firstSuccessfulSaleAt: saleDaysAgo(5),
      now: NOW,
      maturityDays: 7,
      immatureHoldMs: 3 * MS_PER_DAY,
      matureHoldMs: 6 * 60 * 60 * 1000,
    };
    // 5 days < 7-day custom window -> immature.
    expect(resolveEarningHoldMs(input)).toBe(3 * MS_PER_DAY);
    // 8 days >= 7-day window -> mature.
    expect(
      resolveEarningHoldMs({ ...input, firstSuccessfulSaleAt: saleDaysAgo(8) }),
    ).toBe(6 * 60 * 60 * 1000);
  });

  it("throws INVALID_TENURE when the first sale is in the future", () => {
    const future = new Date(NOW.getTime() + 1);
    const err = captureError(() =>
      resolveEarningHoldMs({ firstSuccessfulSaleAt: future, now: NOW }),
    );
    expect(err).toBeInstanceOf(PartnerEconomicsError);
    expect((err as PartnerEconomicsError).code).toBe("INVALID_TENURE");
  });

  it("throws for an invalid now timestamp", () => {
    expect(() =>
      resolveEarningHoldMs({
        firstSuccessfulSaleAt: NOW,
        now: new Date(Number.NaN),
      }),
    ).toThrowError(PartnerEconomicsError);
  });

  it("throws for an invalid firstSuccessfulSaleAt timestamp", () => {
    expect(() =>
      resolveEarningHoldMs({
        firstSuccessfulSaleAt: new Date(Number.NaN),
        now: NOW,
      }),
    ).toThrowError(PartnerEconomicsError);
  });

  it("rejects non-positive or non-integer configuration", () => {
    const base: EarningHoldTenureInput = {
      firstSuccessfulSaleAt: saleDaysAgo(10),
      now: NOW,
    };
    expect(() => resolveEarningHoldMs({ ...base, maturityDays: 0 })).toThrowError(
      PartnerEconomicsError,
    );
    expect(() =>
      resolveEarningHoldMs({ ...base, maturityDays: 1.5 }),
    ).toThrowError(PartnerEconomicsError);
    expect(() =>
      resolveEarningHoldMs({ ...base, immatureHoldMs: 0 }),
    ).toThrowError(PartnerEconomicsError);
    expect(() =>
      resolveEarningHoldMs({ ...base, matureHoldMs: -1 }),
    ).toThrowError(PartnerEconomicsError);
  });
});

describe("describeTenure", () => {
  it("reports no maturity and zero tenure when there is no sale", () => {
    const view = describeTenure({ firstSuccessfulSaleAt: null, now: NOW });
    expect(view).toEqual({ matured: false, tenureDays: 0 });
    expect(Object.isFrozen(view)).toBe(true);
  });

  it("counts whole days of tenure and flags immaturity before the window", () => {
    const view = describeTenure({
      firstSuccessfulSaleAt: saleDaysAgo(29),
      now: NOW,
    });
    expect(view).toEqual({ matured: false, tenureDays: 29 });
  });

  it("flags maturity exactly at the boundary", () => {
    const view = describeTenure({
      firstSuccessfulSaleAt: saleDaysAgo(ACTIVE_SALES_MATURITY_DAYS),
      now: NOW,
    });
    expect(view).toEqual({
      matured: true,
      tenureDays: ACTIVE_SALES_MATURITY_DAYS,
    });
  });

  it("floors partial days of tenure", () => {
    const firstSale = new Date(NOW.getTime() - (5 * MS_PER_DAY + 12345));
    const view = describeTenure({ firstSuccessfulSaleAt: firstSale, now: NOW });
    expect(view.tenureDays).toBe(5);
  });

  it("agrees with resolveEarningHoldMs on maturity", () => {
    const input: EarningHoldTenureInput = {
      firstSuccessfulSaleAt: saleDaysAgo(45),
      now: NOW,
    };
    const view = describeTenure(input);
    expect(view.matured).toBe(true);
    expect(resolveEarningHoldMs(input)).toBe(MATURE_HOLD_MS);
  });
});
