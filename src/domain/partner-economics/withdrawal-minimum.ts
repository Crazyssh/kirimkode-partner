/**
 * Minimum withdrawal per partner tier (post-MVP roadmap Item 2).
 *
 * HeroSMS charges a different withdrawal floor depending on how a partner earns:
 * mobile partners (phones acting as modems) may withdraw from a low floor, while
 * API / hardware partners must accumulate a much higher balance before a payout
 * is allowed. See `.agents/RESEARCH-HEROSMS-PARTNERS.md`:
 *   - "Mobile partners: minimum $3" / "Other partners (API/hardware): minimum $100"
 *     (research §Finance, lines 58-59).
 *   - Roadmap candidate Item 2: "Minimum withdrawal berbeda per tipe partner
 *     (mobile $3 vs API/hardware $100)" (research §Roadmap, line 86).
 *
 * The USD figures above are HeroSMS REFERENCE VALUES only — our platform settles
 * in IDR. This module never invents an IDR amount from those USD numbers; the
 * concrete IDR floors are supplied by the caller via {@link WithdrawalMinimumConfig}.
 * Pure policy: no I/O, no ambient clock, no persistence.
 */
import { PartnerEconomicsError, assertSafeInteger } from "./errors";

/**
 * Payout tier that selects which withdrawal floor applies.
 * - `mobile`   — phone-class fleet (HeroSMS-Mobile equivalent), lower floor.
 * - `standard` — API / hardware fleet (modem, GoIP, protocol/API), higher floor.
 */
export type PartnerPayoutTier = "mobile" | "standard";

/**
 * HeroSMS reference minimums in USD. Labelled reference only — DO NOT treat these
 * as IDR amounts. They document where our tiering comes from; the real IDR floors
 * are injected through {@link WithdrawalMinimumConfig}.
 */
export const HEROSMS_REFERENCE_MINIMUM_USD: Readonly<
  Record<PartnerPayoutTier, number>
> = Object.freeze({
  mobile: 3,
  standard: 100,
});

/** Device types a partner can register (mirrors the repo `DeviceType`). */
export type DeviceType = "simulator" | "android" | "modem" | "goip" | "api";

/**
 * Device types that count as "mobile-class" for tiering: a phone/emulator acting
 * as a modem. Anything else (modem, goip, api) is hardware/protocol and forces
 * the `standard` tier.
 */
const MOBILE_CLASS_DEVICE_TYPES: ReadonlySet<DeviceType> = new Set<DeviceType>([
  "android",
  "simulator",
]);

/**
 * Classify a partner's fleet into a payout tier from its device types.
 *
 * A partner is `mobile` ONLY when every device is mobile-class (android or
 * simulator) AND at least one device exists. As soon as any hardware/protocol
 * device (modem, goip, api) is present — or the fleet is empty — the partner is
 * `standard`. Empty maps to `standard` deliberately: an unknown/absent fleet must
 * not unlock the lower mobile floor.
 */
export function classifyPayoutTier(
  deviceTypes: readonly DeviceType[],
): PartnerPayoutTier {
  if (deviceTypes.length === 0) {
    return "standard";
  }
  const allMobileClass = deviceTypes.every((type) =>
    MOBILE_CLASS_DEVICE_TYPES.has(type),
  );
  return allMobileClass ? "mobile" : "standard";
}

/** Concrete IDR withdrawal floors, injected by the application layer. */
export interface WithdrawalMinimumConfig {
  readonly mobileMinimumIdr: number;
  readonly standardMinimumIdr: number;
}

/** A configured IDR floor must be a strictly-positive safe integer. */
function assertConfiguredMinimumIdr(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PartnerEconomicsError(
      "INVALID_CONFIG",
      `${name} must be a safe integer > 0`,
    );
  }
}

/**
 * Resolve the IDR withdrawal floor for a tier. Both configured minimums are
 * validated (strictly-positive safe integers) regardless of the requested tier,
 * so a malformed config always fails fast with `INVALID_CONFIG`.
 */
export function resolveMinimumWithdrawalIdr(
  tier: PartnerPayoutTier,
  config: WithdrawalMinimumConfig,
): number {
  assertConfiguredMinimumIdr(config.mobileMinimumIdr, "mobileMinimumIdr");
  assertConfiguredMinimumIdr(config.standardMinimumIdr, "standardMinimumIdr");
  return tier === "mobile" ? config.mobileMinimumIdr : config.standardMinimumIdr;
}

/**
 * Whether a proposed withdrawal amount clears the floor for its tier. The amount
 * must be a non-negative safe integer (money in IDR); the config is validated by
 * {@link resolveMinimumWithdrawalIdr}. Meeting the floor exactly is allowed.
 */
export function meetsWithdrawalMinimum(
  amountIdr: number,
  tier: PartnerPayoutTier,
  config: WithdrawalMinimumConfig,
): boolean {
  assertSafeInteger(amountIdr, "amountIdr");
  const minimumIdr = resolveMinimumWithdrawalIdr(tier, config);
  return amountIdr >= minimumIdr;
}
