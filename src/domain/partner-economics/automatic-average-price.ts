/**
 * Automatic average price — the arithmetic layer of AutoPrice.
 *
 * HeroSMS roadmap item 3 ("AutoPrice / automatic average price"; see
 * `.agents/RESEARCH-HEROSMS-PARTNERS.md` §2 "Pricing engine" and §7 item 3).
 * HeroSMS defines the "Average" base price as the arithmetic mean of a
 * partner's successful sales for a given country/service over the last hour,
 * and its "Automatic average price" recomputes on a fixed cadence (every ten
 * minutes) and is always clamped into the partner's min/max guardrail.
 *
 * This module is pure policy/arithmetic: no persistence, no network, no ambient
 * clock. The application layer is responsible for gathering the last hour of
 * successful sale prices (the {@link AVERAGE_WINDOW_MS} window), scheduling the
 * recompute cadence ({@link AUTO_AVERAGE_REFRESH_MS}), and persisting the
 * published base price. The USD figures HeroSMS uses (e.g. the $0.005 minimum
 * slider) are deliberately NOT encoded here — IDR guardrail bounds are always
 * supplied by the caller as config, never invented.
 */
import { assertSafeInteger, PartnerEconomicsError } from "./errors";

/**
 * Reference cadence: HeroSMS recomputes the automatic average roughly every ten
 * minutes. Exposed only as a documented constant for the scheduler; this module
 * performs no timing itself.
 */
export const AUTO_AVERAGE_REFRESH_MS = 10 * 60 * 1000;

/**
 * Reference window: HeroSMS averages successful sales over the last hour.
 * Exposed only as a documented constant so the application layer can select the
 * eligible sale prices before calling {@link computeAutomaticAveragePriceIdr}.
 */
export const AVERAGE_WINDOW_MS = 60 * 60 * 1000;

/** Inclusive IDR bounds a published base price is always clamped into. */
export interface PriceGuardrail {
  readonly minBasePriceIdr: number;
  readonly maxBasePriceIdr: number;
}

/** Inputs for a single automatic-average recompute. */
export interface AverageInput {
  /**
   * Prices (integer IDR) of the partner's successful sales inside the
   * {@link AVERAGE_WINDOW_MS} window. The caller performs the time filtering;
   * this module only averages the values it is handed.
   */
  readonly recentSuccessfulPricesIdr: readonly number[];
  readonly guardrail: PriceGuardrail;
  /**
   * Grid the mean is rounded onto (e.g. round to the nearest Rp50). Defaults to
   * 1 (whole rupiah). Must be a positive safe integer.
   */
  readonly roundToIdr?: number;
}

/** Validate an IDR guardrail: both bounds positive safe integers, min <= max. */
function assertGuardrail(guardrail: PriceGuardrail): void {
  assertSafeInteger(guardrail.minBasePriceIdr, "minBasePriceIdr", 1);
  assertSafeInteger(guardrail.maxBasePriceIdr, "maxBasePriceIdr", 1);
  if (guardrail.minBasePriceIdr > guardrail.maxBasePriceIdr) {
    throw new PartnerEconomicsError(
      "INVALID_CONFIG",
      "guardrail minBasePriceIdr must not exceed maxBasePriceIdr",
    );
  }
}

/**
 * Round `value` to the nearest multiple of `unit`. Ties round up (toward +∞),
 * matching the never-round-down spirit of the repo's `ceilTo`. Nearest (rather
 * than ceil) is used here because the result stands in for an *average*, which
 * should track the true arithmetic mean as closely as the grid allows.
 */
function roundToNearestMultiple(value: number, unit: number): number {
  const result = Math.round(value / unit) * unit;
  if (!Number.isSafeInteger(result)) {
    throw new PartnerEconomicsError(
      "INVALID_CONFIG",
      "rounded average price exceeds safe integer range",
    );
  }
  return result;
}

/**
 * Clamp a base price into `[minBasePriceIdr, maxBasePriceIdr]`. This is the
 * final guardrail HeroSMS applies to the automatic average; a computed mean that
 * lands below the minimum (or above the maximum) is pulled to the nearest bound.
 */
export function clampToGuardrail(
  priceIdr: number,
  guardrail: PriceGuardrail,
): number {
  assertSafeInteger(priceIdr, "priceIdr");
  assertGuardrail(guardrail);
  if (priceIdr < guardrail.minBasePriceIdr) return guardrail.minBasePriceIdr;
  if (priceIdr > guardrail.maxBasePriceIdr) return guardrail.maxBasePriceIdr;
  return priceIdr;
}

/**
 * Compute the automatic average base price in IDR.
 *
 * Steps: validate config (guardrail + rounding grid); if there are no recent
 * successful sales, return `null` (no data — the caller should keep the current
 * price rather than publish a fabricated one); otherwise validate each price
 * (positive safe integer), take the arithmetic mean, round it to the nearest
 * {@link AverageInput.roundToIdr} multiple, and finally clamp into the
 * guardrail. Every intermediate sum is guarded against exceeding the safe
 * integer range.
 *
 * @returns the clamped average in integer IDR, or `null` when there is no data.
 */
export function computeAutomaticAveragePriceIdr(
  input: AverageInput,
): number | null {
  assertGuardrail(input.guardrail);
  const roundToIdr = input.roundToIdr ?? 1;
  assertSafeInteger(roundToIdr, "roundToIdr", 1);

  const prices = input.recentSuccessfulPricesIdr;
  if (prices.length === 0) return null;

  let sum = 0;
  for (const price of prices) {
    assertSafeInteger(price, "recentSuccessfulPricesIdr[]", 1);
    sum += price;
    if (!Number.isSafeInteger(sum)) {
      throw new PartnerEconomicsError(
        "INVALID_CONFIG",
        "sum of recent successful prices exceeds safe integer range",
      );
    }
  }

  const mean = sum / prices.length;
  const rounded = roundToNearestMultiple(mean, roundToIdr);
  return clampToGuardrail(rounded, input.guardrail);
}
