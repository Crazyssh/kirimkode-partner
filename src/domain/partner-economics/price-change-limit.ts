import type { WindowRule } from "@domain/task-7-2";

import { assertSafeInteger, PartnerEconomicsError } from "./errors";

/**
 * Price-change rate limiting and Free Price ceiling policy.
 *
 * Implements HeroSMS Partners roadmap item 9 — "Rate limit ubah harga
 * (10×/10 menit) & Free Price ×10 untuk service langka"
 * (see `.agents/RESEARCH-HEROSMS-PARTNERS.md`, item 9 and the field notes:
 *   - "Batas ubah harga: maksimum 10 kali per 10 menit, lalu dibatasi."
 *   - "FreePrice: harga premium ... earnings maksimum bisa 2–10× di atas harga
 *      maksimum normal.").
 *
 * This module is pure policy: it only exports the window RULE and a namespaced
 * counter KEY; it deliberately does NOT re-implement any window arithmetic —
 * the fixed-window evaluation lives in `@domain/task-7-2`
 * (`evaluateWindow`/`consumeEvent`), which consumes {@link PRICE_CHANGE_RATE_LIMIT}
 * exactly like every other {@link WindowRule}. No I/O, no ambient clock; all
 * time is injected downstream by the rate-limit policy.
 */

/**
 * HeroSMS rule: a partner may change a price at most 10 times per 10 minutes.
 * No cooldown is modelled — the fixed window simply resets, matching the
 * "lalu dibatasi" (then throttled) behaviour of the source platform.
 */
export const PRICE_CHANGE_RATE_LIMIT: WindowRule = Object.freeze({
  limit: 10,
  windowMs: 10 * 60 * 1_000,
});

/**
 * Namespaced counter key for the price-change limiter. One counter per
 * (partner, price dimension) so limits are scoped per service/offer being
 * repriced rather than shared across a partner's whole catalog.
 *
 * @throws PartnerEconomicsError INVALID_INPUT when either part is empty.
 */
export function priceChangeRateKey(
  partnerId: string,
  dimensionKey: string,
): string {
  assertNonEmptyString(partnerId, "partnerId");
  assertNonEmptyString(dimensionKey, "dimensionKey");
  return `price-change:${partnerId}|${dimensionKey}`;
}

/** Free Price is a premium at least 2× the normal maximum base price. */
export const FREE_PRICE_MIN_MULTIPLIER = 2;
/** Free Price caps at 10× the normal maximum base price (HeroSMS "×10"). */
export const FREE_PRICE_MAX_MULTIPLIER = 10;

/**
 * Resolve the Free Price ceiling in IDR for a scarce/high-demand service:
 * `maxBasePriceIdr * multiplier`, where the multiplier is an integer within
 * [{@link FREE_PRICE_MIN_MULTIPLIER}, {@link FREE_PRICE_MAX_MULTIPLIER}].
 *
 * The IDR ceiling is derived purely from the injected `maxBasePriceIdr`; no
 * currency amount is invented here (USD figures in the research doc are only
 * reference points for the 2–10× premium band, not IDR values).
 *
 * @throws PartnerEconomicsError INVALID_INPUT when `maxBasePriceIdr` is not a
 *   positive safe integer, or when the product overflows the safe-integer range.
 * @throws PartnerEconomicsError INVALID_MULTIPLIER when `multiplier` is outside
 *   the integer band [2, 10].
 */
export function resolveFreePriceCeilingIdr(
  maxBasePriceIdr: number,
  multiplier: number,
): number {
  assertSafeInteger(maxBasePriceIdr, "maxBasePriceIdr", 1);
  if (
    !Number.isSafeInteger(multiplier) ||
    multiplier < FREE_PRICE_MIN_MULTIPLIER ||
    multiplier > FREE_PRICE_MAX_MULTIPLIER
  ) {
    throw new PartnerEconomicsError(
      "INVALID_MULTIPLIER",
      `multiplier must be an integer between ${FREE_PRICE_MIN_MULTIPLIER} and ${FREE_PRICE_MAX_MULTIPLIER}`,
    );
  }

  const ceilingIdr = maxBasePriceIdr * multiplier;
  if (!Number.isSafeInteger(ceilingIdr)) {
    throw new PartnerEconomicsError(
      "INVALID_INPUT",
      "free price ceiling exceeds safe integer range",
    );
  }
  return ceilingIdr;
}

/**
 * Whether a proposed Free Price sits at or below the resolved ceiling for the
 * given normal maximum and multiplier. The ceiling inputs are validated
 * strictly (they define policy); an out-of-range `priceIdr` is rejected too,
 * so callers receive a verdict only for a well-formed positive IDR amount.
 *
 * @throws PartnerEconomicsError INVALID_INPUT / INVALID_MULTIPLIER on invalid
 *   `priceIdr`, `maxBasePriceIdr`, or `multiplier` (see
 *   {@link resolveFreePriceCeilingIdr}).
 */
export function isFreePriceWithinCeiling(
  priceIdr: number,
  maxBasePriceIdr: number,
  multiplier: number,
): boolean {
  const ceilingIdr = resolveFreePriceCeilingIdr(maxBasePriceIdr, multiplier);
  assertSafeInteger(priceIdr, "priceIdr", 1);
  return priceIdr <= ceilingIdr;
}

/** A non-empty (non-whitespace) string identifier used to build a counter key. */
function assertNonEmptyString(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PartnerEconomicsError(
      "INVALID_INPUT",
      `${name} must be a non-empty string`,
    );
  }
}
