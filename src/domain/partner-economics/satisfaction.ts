/**
 * Overall satisfaction (a.k.a. demand-satisfaction) metric for a partner
 * service/country. Pure arithmetic — no I/O, no ambient clock; any time window
 * (e.g. "since 00:00 UTC+3") is decided upstream and only the two resulting
 * counters are handed in here.
 *
 * Roadmap: HeroSMS Partners study, item 4 "Overall satisfaction metric"
 * (`sukses ÷ request`) used as a per-service/country quality signal.
 * See `.agents/RESEARCH-HEROSMS-PARTNERS.md` §2 "Pricing engine" — Overall
 * satisfaction = `(nomor sukses diterbitkan ÷ jumlah request) × 100%`, coloured
 * `>60% hijau, 30–60% kuning, <30% merah`. HeroSMS uses it to detect services
 * that should lower their price; we expose it as a raw quality band.
 *
 * Error codes (from ./errors):
 *  - INVALID_INPUT: a counter is not a safe integer >= 0 (via assertSafeInteger).
 *  - INVALID_RATIO: the ratio itself is impossible — successfullyIssued exceeds
 *    totalRequests, or bandForPercent is handed a non-finite / negative percent.
 */
import { assertSafeInteger, PartnerEconomicsError } from "./errors";

/** Colour band mirroring HeroSMS: green (healthy) / yellow (watch) / red (poor). */
export type SatisfactionBand = "green" | "yellow" | "red";

/**
 * Strictly above this percent is green. At or below (down to the red threshold)
 * is yellow. HeroSMS wording: ">60% hijau" — so 60 exactly is NOT green.
 */
export const GREEN_THRESHOLD_PERCENT = 60;

/**
 * Strictly below this percent is red. At or above (up to the green threshold) is
 * yellow. HeroSMS wording: "<30% merah" — so 30 exactly is NOT red.
 *
 * Combined band rule (half-open at both edges):
 *   percent > 60            -> "green"
 *   30 <= percent <= 60     -> "yellow"
 *   percent < 30            -> "red"
 */
export const RED_THRESHOLD_PERCENT = 30;

export interface SatisfactionInput {
  /** Numbers successfully issued (delivered) within the window. */
  readonly successfullyIssued: number;
  /** Total demand: every request made within the window. */
  readonly totalRequests: number;
}

export interface SatisfactionResult {
  /**
   * `ratio × 100`, rounded to 1 decimal place for display. Always in [0, 100].
   * The reported {@link band} is derived from THIS rounded value, so the shown
   * colour never disagrees with the shown number.
   */
  readonly percent: number;
  /** Exact success fraction `successfullyIssued / totalRequests`, in [0, 1]. */
  readonly ratio: number;
  readonly band: SatisfactionBand;
}

/**
 * Map a satisfaction percent to its HeroSMS colour band. Exported so callers can
 * band a percent they already hold (e.g. an aggregated/reported value) without
 * recomputing a ratio.
 *
 * @throws PartnerEconomicsError INVALID_RATIO if `percent` is not a finite
 *   number >= 0 (a percent is never negative and never NaN/Infinity).
 */
export function bandForPercent(percent: number): SatisfactionBand {
  if (!Number.isFinite(percent) || percent < 0) {
    throw new PartnerEconomicsError(
      "INVALID_RATIO",
      "percent must be a finite number >= 0",
    );
  }
  if (percent > GREEN_THRESHOLD_PERCENT) return "green";
  if (percent < RED_THRESHOLD_PERCENT) return "red";
  return "yellow";
}

/**
 * Compute the overall satisfaction for a window.
 *
 * Returns `null` when `totalRequests === 0`: with no demand the metric is
 * undefined (there is nothing to divide by), which is a distinct, meaningful
 * outcome — not an error and not "0%".
 *
 * @throws PartnerEconomicsError INVALID_INPUT if either counter is not a safe
 *   integer >= 0 (via assertSafeInteger).
 * @throws PartnerEconomicsError INVALID_RATIO if successfullyIssued exceeds
 *   totalRequests (you cannot issue more than were requested).
 */
export function computeSatisfaction(
  input: SatisfactionInput,
): SatisfactionResult | null {
  assertSafeInteger(input.successfullyIssued, "successfullyIssued");
  assertSafeInteger(input.totalRequests, "totalRequests");
  if (input.successfullyIssued > input.totalRequests) {
    throw new PartnerEconomicsError(
      "INVALID_RATIO",
      "successfullyIssued must not exceed totalRequests",
    );
  }

  if (input.totalRequests === 0) return null;

  const ratio = input.successfullyIssued / input.totalRequests;
  // 1-decimal percent computed from the bounded ratio to avoid large-integer
  // overflow; Math.round keeps it deterministic (half rounds up).
  const percent = Math.round(ratio * 1000) / 10;
  const band = bandForPercent(percent);

  return Object.freeze({ percent, ratio, band });
}
