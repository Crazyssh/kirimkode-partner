import {
  assertSafeInteger,
  assertValidTimestamp,
  PartnerEconomicsError,
} from "./errors";

/**
 * Tenure-based earning HOLD period (partner-economics roadmap Item 1).
 *
 * HeroSMS processes withdrawals within <=7 days during the first 30 days of
 * "active sales", then within 24h after those 30 days elapse (see
 * `.agents/RESEARCH-HEROSMS-PARTNERS.md` §4 "Finance & penarikan"). Our repo
 * models earning maturity as a HOLD period on the pending->available
 * transition (`decideEarningOnSuccess`, default 24h). This module maps the
 * HeroSMS tenure rule onto that hold: an immature partner (no successful sale
 * yet, or less than the maturity window since the first one) gets the longer
 * 7-day hold; a matured partner gets the standard 24h hold.
 *
 * Pure policy: all time is injected as `Date` parameters — no ambient clock,
 * no I/O. The returned number is suitable to pass as `holdPeriodMs` into
 * `decideEarningOnSuccess`.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Days of "active sales" after the first successful sale before maturity. */
export const ACTIVE_SALES_MATURITY_DAYS = 30;

/** Hold applied before maturity: 7 days (mirrors the <=7d withdrawal window). */
export const IMMATURE_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** Hold applied once matured: 24h (the repo default earning hold). */
export const MATURE_HOLD_MS = 24 * 60 * 60 * 1000;

export interface EarningHoldTenureInput {
  /** Instant of the partner's first successful sale, or null if none yet. */
  readonly firstSuccessfulSaleAt: Date | null;
  /** Reference instant to measure tenure against (injected clock). */
  readonly now: Date;
  /** Override maturity threshold in days (default {@link ACTIVE_SALES_MATURITY_DAYS}). */
  readonly maturityDays?: number;
  /** Override immature hold in ms (default {@link IMMATURE_HOLD_MS}). */
  readonly immatureHoldMs?: number;
  /** Override mature hold in ms (default {@link MATURE_HOLD_MS}). */
  readonly matureHoldMs?: number;
}

export interface TenureView {
  /** True once the maturity window has elapsed since the first sale. */
  readonly matured: boolean;
  /** Whole days of tenure since the first sale (0 when no sale yet). */
  readonly tenureDays: number;
}

interface TenureContext {
  readonly matured: boolean;
  readonly elapsedMs: number;
  readonly maturityMs: number;
  readonly immatureHoldMs: number;
  readonly matureHoldMs: number;
}

/**
 * Validate inputs and derive the maturity context shared by the public
 * functions. Validation order mirrors the spec: timestamps, then the future
 * guard, then the numeric configuration.
 */
function resolveTenureContext(input: EarningHoldTenureInput): TenureContext {
  assertValidTimestamp(input.now, "now");

  const { firstSuccessfulSaleAt } = input;
  if (firstSuccessfulSaleAt !== null) {
    assertValidTimestamp(firstSuccessfulSaleAt, "firstSuccessfulSaleAt");
    if (firstSuccessfulSaleAt.getTime() > input.now.getTime()) {
      throw new PartnerEconomicsError(
        "INVALID_TENURE",
        "firstSuccessfulSaleAt must not be in the future relative to now",
      );
    }
  }

  const maturityDays = input.maturityDays ?? ACTIVE_SALES_MATURITY_DAYS;
  const immatureHoldMs = input.immatureHoldMs ?? IMMATURE_HOLD_MS;
  const matureHoldMs = input.matureHoldMs ?? MATURE_HOLD_MS;
  assertSafeInteger(maturityDays, "maturityDays", 1);
  assertSafeInteger(immatureHoldMs, "immatureHoldMs", 1);
  assertSafeInteger(matureHoldMs, "matureHoldMs", 1);

  const maturityMs = maturityDays * MS_PER_DAY;
  assertSafeInteger(maturityMs, "maturityDays * MS_PER_DAY", 1);

  const elapsedMs =
    firstSuccessfulSaleAt === null
      ? 0
      : input.now.getTime() - firstSuccessfulSaleAt.getTime();
  const matured = firstSuccessfulSaleAt !== null && elapsedMs >= maturityMs;

  return Object.freeze({
    matured,
    elapsedMs,
    maturityMs,
    immatureHoldMs,
    matureHoldMs,
  });
}

/**
 * Resolve the earning HOLD period in milliseconds for a partner's tenure.
 *
 * Returns `immatureHoldMs` when the partner has never had a successful sale,
 * or when strictly less than the maturity window has elapsed since the first
 * one; otherwise returns `matureHoldMs`. At exactly the maturity boundary the
 * partner is considered matured. The result is intended for use as
 * `holdPeriodMs` in `decideEarningOnSuccess`.
 */
export function resolveEarningHoldMs(input: EarningHoldTenureInput): number {
  const ctx = resolveTenureContext(input);
  return ctx.matured ? ctx.matureHoldMs : ctx.immatureHoldMs;
}

/**
 * Describe the partner's maturity for display/telemetry: whether they have
 * matured and how many whole days of tenure they have accrued (0 when there is
 * no successful sale yet). Frozen, derived from the same rules as
 * {@link resolveEarningHoldMs}.
 */
export function describeTenure(input: EarningHoldTenureInput): TenureView {
  const ctx = resolveTenureContext(input);
  return Object.freeze({
    matured: ctx.matured,
    tenureDays: Math.floor(ctx.elapsedMs / MS_PER_DAY),
  });
}
