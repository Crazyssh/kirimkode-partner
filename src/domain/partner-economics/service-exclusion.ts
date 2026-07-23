import { PartnerEconomicsError } from "./errors";

/**
 * Service mutual-exclusion policy (partner-economics roadmap Item 6).
 *
 * HeroSMS forbids re-selling a number for a second service once it has already
 * been used/sold for a mutually-exclusive first service — sometimes globally,
 * sometimes only inside a specific country. A single physical number therefore
 * cannot straddle both sides of an exclusion pair. See
 * `.agents/RESEARCH-HEROSMS-PARTNERS.md` §5 ("Service mutual exclusion") and the
 * roadmap list Item 6 ("beli wa -> tak boleh jual service tertentu di nomor
 * sama").
 *
 * This module is pure policy: given the services a number has already been sold
 * for, it decides whether a candidate service may still be offered on that same
 * number. It performs no I/O, reads no clock, and hardcodes no money — the
 * exclusion table is either supplied by the caller or defaults to the labelled
 * HeroSMS reference set below. All matching is case-insensitive and symmetric in
 * the pair (a<->b), and country-scoped pairs only apply inside their country.
 */

/**
 * An unordered pair of services that may not both be sold on the same number.
 * `countryCode` scopes the rule to one country; when omitted the pair is global.
 */
export interface ExclusionPair {
  readonly a: string;
  readonly b: string;
  /** ISO-3166 alpha-2 country the rule applies in; `undefined` = global. */
  readonly countryCode?: string;
}

/**
 * Reference exclusion set transcribed from the HeroSMS terms of service.
 * These are illustrative service codes for the documented examples — not an
 * authoritative or exhaustive table — and exist so callers have a sane default.
 * Real deployments should pass their own `exclusions` list.
 */
export const HEROSMS_REFERENCE_EXCLUSIONS: readonly ExclusionPair[] =
  Object.freeze([
    // WhatsApp <-> AstroPay, global.
    Object.freeze({ a: "wa", b: "gr" }),
    // Kazakhstan: Uber <-> YandexGo.
    Object.freeze({ a: "uber", b: "yandexgo", countryCode: "KZ" }),
    // Ukraine: NovaPoshta <-> Viber.
    Object.freeze({ a: "novaposhta", b: "viber", countryCode: "UA" }),
    // Poland: NovaPoshta <-> Viber.
    Object.freeze({ a: "novaposhta", b: "viber", countryCode: "PL" }),
    // Netherlands: WhatsApp <-> WhatsApp Business.
    Object.freeze({ a: "wa", b: "wa_business", countryCode: "NL" }),
  ]);

/** A candidate offer evaluated against the services a number has already sold. */
export interface ExclusionQuery {
  /** The service a partner wants to offer next on this number. */
  readonly candidateService: string;
  /** Services this number has already been used/sold for. */
  readonly soldServices: readonly string[];
  /** Country the number belongs to (scopes country-specific pairs). */
  readonly countryCode: string;
  /** Exclusion table to apply; defaults to {@link HEROSMS_REFERENCE_EXCLUSIONS}. */
  readonly exclusions?: readonly ExclusionPair[];
}

/** Result when a candidate service is blocked by an already-sold service. */
export interface ExclusionConflict {
  /** The (normalized) already-sold service that blocks the candidate. */
  readonly blockedBy: string;
}

function normalizeService(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeCountry(value: string): string {
  return value.trim().toUpperCase();
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PartnerEconomicsError(
      "INVALID_INPUT",
      `${name} must be a non-empty string`,
    );
  }
}

/** True when `pair` is in force for `country` (global pairs always apply). */
function pairAppliesToCountry(pair: ExclusionPair, country: string): boolean {
  if (pair.countryCode === undefined) return true;
  return normalizeCountry(pair.countryCode) === country;
}

/** True when `{candidate, sold}` is exactly the unordered pair `{a, b}`. */
function pairMatchesServices(
  pair: ExclusionPair,
  candidate: string,
  sold: string,
): boolean {
  const a = normalizeService(pair.a);
  const b = normalizeService(pair.b);
  return (candidate === a && sold === b) || (candidate === b && sold === a);
}

/**
 * Find the first already-sold service that mutually excludes `candidateService`
 * on the same number, or `null` when the candidate may still be sold.
 *
 * Service and country codes are normalized case-insensitively; a pair applies
 * when it is global or its country matches the query, and when the candidate and
 * a sold service form the pair in either direction. Sold services are scanned in
 * order, so the returned `blockedBy` is the earliest conflicting one. Empty or
 * whitespace-only sold entries are ignored. Throws when `candidateService` or
 * `countryCode` is empty.
 */
export function findExclusionConflict(
  query: ExclusionQuery,
): ExclusionConflict | null {
  assertNonEmpty(query.candidateService, "candidateService");
  assertNonEmpty(query.countryCode, "countryCode");

  const candidate = normalizeService(query.candidateService);
  const country = normalizeCountry(query.countryCode);
  const exclusions = query.exclusions ?? HEROSMS_REFERENCE_EXCLUSIONS;

  for (const rawSold of query.soldServices) {
    const sold = normalizeService(rawSold);
    if (sold.length === 0) continue;
    for (const pair of exclusions) {
      if (
        pairAppliesToCountry(pair, country) &&
        pairMatchesServices(pair, candidate, sold)
      ) {
        return Object.freeze({ blockedBy: sold });
      }
    }
  }

  return null;
}

/**
 * Whether `candidateService` may be offered on a number given its already-sold
 * services — i.e. no mutual-exclusion pair is violated. Validates that
 * `candidateService` and `countryCode` are non-empty (delegated to
 * {@link findExclusionConflict}).
 */
export function isServiceSellable(query: ExclusionQuery): boolean {
  return findExclusionConflict(query) === null;
}
