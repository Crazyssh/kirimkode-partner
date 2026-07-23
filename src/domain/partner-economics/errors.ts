/**
 * Shared error type for the partner-economics domain (post-MVP roadmap layer
 * derived from the HeroSMS Partners study; see
 * `.agents/RESEARCH-HEROSMS-PARTNERS.md`).
 *
 * These modules are pure policy/arithmetic — no persistence, no network, no
 * ambient clock. They encode decisions the application layer will later wire
 * into services and schema. The `code`-carrying error mirrors the convention
 * used across `src/domain`.
 */
export type PartnerEconomicsErrorCode =
  | "INVALID_INPUT"
  | "INVALID_TENURE"
  | "INVALID_RATIO"
  | "INVALID_MULTIPLIER"
  | "INVALID_CONFIG"
  | "INVALID_OFFENSE";

export class PartnerEconomicsError extends Error {
  constructor(
    public readonly code: PartnerEconomicsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PartnerEconomicsError";
  }
}

/** A safe non-negative integer (money in IDR, counts, durations in ms). */
export function assertSafeInteger(
  value: number,
  name: string,
  minimum = 0,
): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new PartnerEconomicsError(
      "INVALID_INPUT",
      `${name} must be a safe integer >= ${minimum}`,
    );
  }
}

/** A valid, finite Date (all time is injected — never read from the clock). */
export function assertValidTimestamp(value: Date, name: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new PartnerEconomicsError(
      "INVALID_INPUT",
      `${name} must be a valid Date`,
    );
  }
}
