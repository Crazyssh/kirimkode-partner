import { describe, expect, it } from "vitest";

import { consumeEvent, emptyWindowCounter, evaluateWindow } from "@domain/task-7-2";

import {
  PartnerEconomicsError,
  type PartnerEconomicsErrorCode,
} from "./errors";
import {
  FREE_PRICE_MAX_MULTIPLIER,
  FREE_PRICE_MIN_MULTIPLIER,
  isFreePriceWithinCeiling,
  PRICE_CHANGE_RATE_LIMIT,
  priceChangeRateKey,
  resolveFreePriceCeilingIdr,
} from "./price-change-limit";

// HeroSMS roadmap item 9: rate limit ubah harga (10x/10 menit) + Free Price x10.
// See .agents/RESEARCH-HEROSMS-PARTNERS.md.

/** Assert `fn` throws a PartnerEconomicsError carrying exactly `code`. */
function expectErrorCode(fn: () => unknown, code: PartnerEconomicsErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PartnerEconomicsError);
    expect((error as PartnerEconomicsError).code).toBe(code);
    return;
  }
  throw new Error(`expected function to throw PartnerEconomicsError(${code})`);
}

describe("PRICE_CHANGE_RATE_LIMIT", () => {
  it("encodes 10 changes per 10 minutes with no cooldown, frozen", () => {
    expect(PRICE_CHANGE_RATE_LIMIT.limit).toBe(10);
    expect(PRICE_CHANGE_RATE_LIMIT.windowMs).toBe(10 * 60 * 1_000);
    expect(PRICE_CHANGE_RATE_LIMIT.cooldownMs).toBeUndefined();
    expect(Object.isFrozen(PRICE_CHANGE_RATE_LIMIT)).toBe(true);
  });

  it("is a valid WindowRule: the real policy allows exactly 10 changes then denies the 11th", () => {
    const now = 1_700_000_000_000;
    let counter = emptyWindowCounter();

    for (let i = 0; i < PRICE_CHANGE_RATE_LIMIT.limit; i += 1) {
      const result = consumeEvent(counter, PRICE_CHANGE_RATE_LIMIT, now);
      expect(result.decision.allowed).toBe(true);
      counter = result.counter;
    }

    const eleventh = consumeEvent(counter, PRICE_CHANGE_RATE_LIMIT, now);
    expect(eleventh.decision.allowed).toBe(false);
    expect(eleventh.decision.retryAfterMs).toBe(PRICE_CHANGE_RATE_LIMIT.windowMs);

    // No cooldown: once the fixed window elapses, changes are permitted again.
    const afterWindow = evaluateWindow(
      counter,
      PRICE_CHANGE_RATE_LIMIT,
      now + PRICE_CHANGE_RATE_LIMIT.windowMs,
    );
    expect(afterWindow.allowed).toBe(true);
  });
});

describe("priceChangeRateKey", () => {
  it("builds a namespaced per-partner, per-dimension key", () => {
    expect(priceChangeRateKey("partner-1", "wa|ID|any")).toBe(
      "price-change:partner-1|wa|ID|any",
    );
  });

  it("scopes counters separately per partner and per dimension", () => {
    expect(priceChangeRateKey("p1", "d1")).not.toBe(priceChangeRateKey("p2", "d1"));
    expect(priceChangeRateKey("p1", "d1")).not.toBe(priceChangeRateKey("p1", "d2"));
  });

  it("rejects empty or whitespace-only parts with INVALID_INPUT", () => {
    expectErrorCode(() => priceChangeRateKey("", "d1"), "INVALID_INPUT");
    expectErrorCode(() => priceChangeRateKey("p1", ""), "INVALID_INPUT");
    expectErrorCode(() => priceChangeRateKey("   ", "d1"), "INVALID_INPUT");
    expectErrorCode(() => priceChangeRateKey("p1", "  "), "INVALID_INPUT");
  });
});

describe("Free Price multipliers", () => {
  it("exposes the 2x..10x premium band", () => {
    expect(FREE_PRICE_MIN_MULTIPLIER).toBe(2);
    expect(FREE_PRICE_MAX_MULTIPLIER).toBe(10);
  });
});

describe("resolveFreePriceCeilingIdr", () => {
  it("multiplies the normal maximum by the multiplier at the 2x boundary", () => {
    expect(resolveFreePriceCeilingIdr(5_000, FREE_PRICE_MIN_MULTIPLIER)).toBe(10_000);
  });

  it("multiplies the normal maximum by the multiplier at the 10x boundary", () => {
    expect(resolveFreePriceCeilingIdr(5_000, FREE_PRICE_MAX_MULTIPLIER)).toBe(50_000);
  });

  it("accepts an interior multiplier", () => {
    expect(resolveFreePriceCeilingIdr(1_234, 7)).toBe(8_638);
  });

  it("rejects a multiplier below the band (1) with INVALID_MULTIPLIER", () => {
    expectErrorCode(() => resolveFreePriceCeilingIdr(5_000, 1), "INVALID_MULTIPLIER");
  });

  it("rejects a multiplier above the band (11) with INVALID_MULTIPLIER", () => {
    expectErrorCode(() => resolveFreePriceCeilingIdr(5_000, 11), "INVALID_MULTIPLIER");
  });

  it("rejects a non-integer multiplier with INVALID_MULTIPLIER", () => {
    expectErrorCode(() => resolveFreePriceCeilingIdr(5_000, 2.5), "INVALID_MULTIPLIER");
  });

  it("rejects a non-positive or non-integer base price with INVALID_INPUT", () => {
    expectErrorCode(() => resolveFreePriceCeilingIdr(0, 2), "INVALID_INPUT");
    expectErrorCode(() => resolveFreePriceCeilingIdr(-1, 2), "INVALID_INPUT");
    expectErrorCode(() => resolveFreePriceCeilingIdr(1_000.5, 2), "INVALID_INPUT");
  });

  it("guards against safe-integer overflow of the ceiling with INVALID_INPUT", () => {
    expectErrorCode(
      () => resolveFreePriceCeilingIdr(Number.MAX_SAFE_INTEGER, 2),
      "INVALID_INPUT",
    );
  });
});

describe("isFreePriceWithinCeiling", () => {
  it("returns true for a price at or below the ceiling", () => {
    // ceiling = 5_000 * 10 = 50_000
    expect(isFreePriceWithinCeiling(50_000, 5_000, 10)).toBe(true);
    expect(isFreePriceWithinCeiling(25_000, 5_000, 10)).toBe(true);
    expect(isFreePriceWithinCeiling(1, 5_000, 10)).toBe(true);
  });

  it("returns false for a price above the ceiling", () => {
    expect(isFreePriceWithinCeiling(50_001, 5_000, 10)).toBe(false);
  });

  it("propagates ceiling validation errors", () => {
    expectErrorCode(() => isFreePriceWithinCeiling(1_000, 5_000, 1), "INVALID_MULTIPLIER");
    expectErrorCode(() => isFreePriceWithinCeiling(1_000, 0, 2), "INVALID_INPUT");
  });

  it("rejects a non-positive price with INVALID_INPUT", () => {
    expectErrorCode(() => isFreePriceWithinCeiling(0, 5_000, 10), "INVALID_INPUT");
    expectErrorCode(() => isFreePriceWithinCeiling(-5, 5_000, 10), "INVALID_INPUT");
  });
});
