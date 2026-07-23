/**
 * Anti-resale retention + penalty/freeze ladder (pure domain policy).
 *
 * Implements HeroSMS Partners roadmap **Item 5 — anti-resale: 2-month number
 * retention + fine/freeze ladder** (see `.agents/RESEARCH-HEROSMS-PARTNERS.md`,
 * sections "Anti-resale" and "Denda resale"). HeroSMS forbids reselling, reusing
 * for personal purposes, or interacting in any way with a number for **2 months**
 * after it has been sold; each violation escalates a fine/freeze ladder and the
 * fourth violation permanently disconnects every account. Frozen funds are
 * released 6 months after the last penalty.
 *
 * This module is pure arithmetic/decision only: no I/O, no ambient clock — every
 * timestamp is injected as a `Date` parameter. USD amounts from HeroSMS are kept
 * strictly as labelled reference constants; IDR thresholds are never invented
 * here and must be supplied by the application layer as config when needed.
 */
import {
  assertSafeInteger,
  assertValidTimestamp,
  PartnerEconomicsError,
} from "./errors";

/** Retention window during which a sold number must not be resold/reused: 60 days. */
export const NUMBER_RETENTION_DAYS = 60;

/** Retention window expressed in milliseconds (60 days). */
export const NUMBER_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Delay after the LAST penalty before frozen funds are released: HeroSMS states
 * "6 months". Calendar months vary, so this MVP models 6 months as a fixed
 * 182-day duration (≈ 26 weeks, the standard half-year approximation). The
 * application layer may override this with a calendar-accurate value via the
 * `releaseMs` parameter of {@link frozenReleaseAt}.
 */
export const FROZEN_RELEASE_MS = 182 * 24 * 60 * 60 * 1000;

export type ResalePenaltyKind = "fine" | "permanent_disconnect";

/**
 * REFERENCE ONLY — the HeroSMS resale fine/freeze ladder in USD for offenses
 * 1..3 (offense #1: $30 fine + $60 frozen; #2: $60 + $120; #3: $100 + $200).
 * These are documentation-grade upstream figures, NOT IDR amounts to charge.
 */
export const HEROSMS_REFERENCE_PENALTY_LADDER_USD: readonly {
  readonly offense: number;
  readonly fineUsd: number;
  readonly frozenUsd: number;
}[] = Object.freeze([
  Object.freeze({ offense: 1, fineUsd: 30, frozenUsd: 60 }),
  Object.freeze({ offense: 2, fineUsd: 60, frozenUsd: 120 }),
  Object.freeze({ offense: 3, fineUsd: 100, frozenUsd: 200 }),
]);

export type ResalePenalty =
  | {
      readonly kind: "fine";
      readonly offense: number;
      readonly fineUsd: number;
      readonly frozenUsd: number;
    }
  | { readonly kind: "permanent_disconnect"; readonly offense: number };

/**
 * Resolve the resale penalty for the Nth violation. Offenses 1..3 map to the
 * corresponding rung of {@link HEROSMS_REFERENCE_PENALTY_LADDER_USD}; the 4th and
 * any subsequent offense escalate to a permanent disconnect of all accounts.
 *
 * @param offenseCount 1-based violation counter; must be a safe integer >= 1.
 * @throws PartnerEconomicsError `INVALID_OFFENSE` when `offenseCount` is not a
 *   safe integer >= 1.
 */
export function resolveResalePenalty(offenseCount: number): ResalePenalty {
  if (!Number.isSafeInteger(offenseCount) || offenseCount < 1) {
    throw new PartnerEconomicsError(
      "INVALID_OFFENSE",
      "offenseCount must be a safe integer >= 1",
    );
  }

  if (offenseCount >= 4) {
    return Object.freeze({
      kind: "permanent_disconnect",
      offense: offenseCount,
    });
  }

  const rung = HEROSMS_REFERENCE_PENALTY_LADDER_USD[offenseCount - 1];
  return Object.freeze({
    kind: "fine",
    offense: offenseCount,
    fineUsd: rung.fineUsd,
    frozenUsd: rung.frozenUsd,
  });
}

export interface RetentionQuery {
  /** Instant the number was last legitimately used/sold. */
  readonly lastUsedAt: Date;
  /** Current instant (injected — never read from the clock). */
  readonly now: Date;
  /** Optional override of the retention window in ms; defaults to {@link NUMBER_RETENTION_MS}. */
  readonly retentionMs?: number;
}

/**
 * Whether the retention window has fully elapsed, i.e. the number may be resold
 * or reused again. True exactly when `now - lastUsedAt >= retentionMs`, so the
 * boundary instant (elapsed === retentionMs) satisfies retention.
 *
 * @throws PartnerEconomicsError `INVALID_INPUT` when either timestamp is invalid,
 *   `retentionMs` is not a safe integer >= 0, or `lastUsedAt` is after `now`.
 */
export function isRetentionSatisfied(query: RetentionQuery): boolean {
  assertValidTimestamp(query.lastUsedAt, "lastUsedAt");
  assertValidTimestamp(query.now, "now");
  const retentionMs = query.retentionMs ?? NUMBER_RETENTION_MS;
  assertSafeInteger(retentionMs, "retentionMs", 0);

  const elapsedMs = query.now.getTime() - query.lastUsedAt.getTime();
  if (elapsedMs < 0) {
    throw new PartnerEconomicsError(
      "INVALID_INPUT",
      "lastUsedAt must not be after now",
    );
  }
  return elapsedMs >= retentionMs;
}

/**
 * The instant frozen funds become releasable: `lastPenaltyAt + releaseMs`
 * (defaulting to {@link FROZEN_RELEASE_MS}, i.e. 6 months after the LAST penalty).
 * Returns a fresh, frozen `Date` — the input is never mutated.
 *
 * @throws PartnerEconomicsError `INVALID_INPUT` when `lastPenaltyAt` is invalid or
 *   `releaseMs` is not a safe integer >= 0.
 */
export function frozenReleaseAt(
  lastPenaltyAt: Date,
  releaseMs: number = FROZEN_RELEASE_MS,
): Date {
  assertValidTimestamp(lastPenaltyAt, "lastPenaltyAt");
  assertSafeInteger(releaseMs, "releaseMs", 0);
  return Object.freeze(new Date(lastPenaltyAt.getTime() + releaseMs));
}
