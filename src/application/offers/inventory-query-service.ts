/**
 * Inventory eligibility query + quote (task 8.4).
 *
 * Answers the buyer-facing `GET /inventory` question "is there a number I can
 * reserve for this catalog, and at what retail price?" without creating any
 * order. The eligibility conjunction and the deterministic `number.id ASC`
 * ordering are the pure task 5.2 domain's job (`selectEligibleInventory`), so
 * the selection rule lives in exactly one place and is identical to the rule
 * the reservation path (task 9.3) will use:
 *
 *   partner approved ∧ device online (not disabled) ∧ heartbeat fresh ∧
 *   capability `sms` ∧ number available + enabled + no active order ∧
 *   offer active ∧ every catalog dimension matches.
 *
 * The quote is authoritative and server-computed (requirement 8.6): the retail
 * price comes from `calculateAuthoritativePricing` over the selected candidate's
 * base price and the immutable active platform config, with the requested
 * dimension's pricing overrides applied. The quote carries the GLOBAL config
 * `version` as `quoteVersion` and an `expiresAt` so the reservation path can
 * reject a stale or superseded quote. No weighted routing: the first candidate
 * by `number.id ASC` defines the price (deterministic MVP).
 *
 * The requested dimension is matched by membership of the served catalog, so any
 * enabled dimension can be quoted; a dimension that is absent or disabled keeps
 * the existing `catalog_mismatch` outcome.
 */
import {
  calculateAuthoritativePricing,
  resolveDimensionPricing,
  resolveServedDimension,
  selectEligibleInventory,
  type InventoryFilter,
} from "@domain/task-5-2-device-inventory-pricing";

import type { Clock, InventoryQueryGateway } from "./ports";

/**
 * Quote validity window in milliseconds. The MVP uses a short fixed window so a
 * price/availability quote is always fresh; the reservation path re-validates
 * `quoteVersion` against the active config regardless.
 */
export const QUOTE_TTL_MS = 60_000;

/** The buyer-facing availability + price quote for a catalog filter. */
export interface InventoryQuote {
  readonly available: boolean;
  /** Retail price for the selected candidate; `null` when unavailable. */
  readonly retailPriceIdr: number | null;
  readonly currency: string;
  /** The active config version the quote was priced against. */
  readonly quoteVersion: number;
  /** Epoch-ms after which the quote must not be honoured for a reservation. */
  readonly expiresAtEpochMs: number;
}

export interface QueryInventoryInput {
  readonly filter: InventoryFilter;
}

export type InventoryQueryOutcome =
  | { readonly ok: true; readonly quote: InventoryQuote }
  | { readonly ok: false; readonly reason: "config_unavailable" }
  | { readonly ok: false; readonly reason: "catalog_mismatch" };

export interface InventoryQueryServiceDeps {
  readonly gateway: InventoryQueryGateway;
  readonly clock: Clock;
  /** Quote validity window; defaults to {@link QUOTE_TTL_MS}. */
  readonly quoteTtlMs?: number;
}

export class InventoryQueryService {
  private readonly deps: InventoryQueryServiceDeps;

  constructor(deps: InventoryQueryServiceDeps) {
    this.deps = deps;
  }

  /**
   * Compute an availability + price quote for a catalog filter. Returns a
   * `stockout` quote (`available:false`, `retailPriceIdr:null`) rather than an
   * error when nothing is eligible, so the buyer sees a deterministic empty
   * result without any partial state (requirement 9.4).
   */
  async queryInventory(input: QueryInventoryInput): Promise<InventoryQueryOutcome> {
    const config = await this.deps.gateway.loadActiveConfig();
    if (config === null) return { ok: false, reason: "config_unavailable" };

    // The platform serves a SET of catalog dimensions; a filter for a dimension
    // that is not served (absent or disabled) can never match any supply, so we
    // reject it rather than silently returning empty. The outcome is unchanged
    // from the single-dimension behaviour — only the membership test is new.
    const lookup = await this.deps.gateway.loadDimension(input.filter);
    const dimension = resolveServedDimension(lookup, config, input.filter);
    if (dimension === null) {
      return { ok: false, reason: "catalog_mismatch" };
    }
    // Price for THIS dimension: the global config with the dimension's
    // overrides applied. `currency` and the quote `version` stay global.
    const pricingConfig = resolveDimensionPricing(dimension, config);

    const now = this.deps.clock.nowEpochMs();
    const nowDate = new Date(now);
    const candidates = await this.deps.gateway.loadCandidates(input.filter);
    const selected = selectEligibleInventory(
      candidates,
      input.filter,
      nowDate,
      config.heartbeatTimeoutSeconds,
    );

    const expiresAtEpochMs = now + (this.deps.quoteTtlMs ?? QUOTE_TTL_MS);
    if (selected === null) {
      return {
        ok: true,
        quote: {
          available: false,
          retailPriceIdr: null,
          currency: config.currency,
          quoteVersion: config.version,
          expiresAtEpochMs,
        },
      };
    }

    const pricing = calculateAuthoritativePricing(
      { basePriceIdr: selected.offer.basePriceIdr },
      pricingConfig,
    );
    return {
      ok: true,
      quote: {
        available: true,
        retailPriceIdr: pricing.retailPriceIdr,
        currency: config.currency,
        quoteVersion: config.version,
        expiresAtEpochMs,
      },
    };
  }
}
