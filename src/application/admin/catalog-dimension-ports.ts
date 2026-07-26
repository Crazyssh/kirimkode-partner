/**
 * Ports and view types for admin catalog-dimension management (requirement
 * 16.5).
 *
 * A catalog dimension says which service/country/operator triple the platform
 * sells; the global `platform_configs` row still single-sources the pricing
 * formula, `currency`, and every money-path value. Until now dimensions could
 * only be declared by running raw `INSERT` SQL against the live database, so the
 * act of putting a new product on sale left no attributable trace. These ports
 * give that action the same shape as every other admin command — permission
 * check, pure validation, audit event, safe error envelope — while keeping the
 * {@link AdminCatalogDimensionService} free of Prisma.
 *
 * Only TWO operations exist, and that is a deliberate match for what the schema
 * permits. The `catalog_dimensions_pricing_immutable` trigger freezes the
 * dimension triple and all five price overrides after insert and refuses DELETE
 * outright, leaving `enabled` as the single mutable column. So the admin surface
 * offers exactly declare + toggle: there is no edit and no delete to expose.
 */
import type { AuditEventDescriptor } from "@domain/task-5-7";

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Generates opaque identifiers (UUIDs) for new rows and audit events. */
export interface IdGenerator {
  uuid(): string;
}

/**
 * One dimension as the admin list view shows it: the row, whether each pricing
 * input is overridden or inherited from the global config, and how many offers
 * currently reference the triple.
 *
 * `offerCount` exists so an operator about to withdraw a dimension can see it
 * still has live supply attached. It is counted from `partner_offers` in the
 * same query, which is cheap — the offers table is already indexed on the
 * dimension triple for the active-offer slot.
 */
export interface AdminCatalogDimensionRow {
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly enabled: boolean;
  readonly minBasePriceIdr: number | null;
  readonly maxBasePriceIdr: number | null;
  readonly fixedFeeIdr: number | null;
  readonly markupBps: number | null;
  readonly roundToIdr: number | null;
  readonly note: string | null;
  readonly createdAtEpochMs: number;
  /** Offers on this triple, in any status. */
  readonly offerCount: number;
  /** Offers on this triple that are currently ACTIVE. */
  readonly activeOfferCount: number;
}

/** Everything the adapter needs to insert one dimension plus its audit event. */
export interface DeclareDimensionRecord {
  readonly id: string;
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly enabled: boolean;
  readonly minBasePriceIdr: number | null;
  readonly maxBasePriceIdr: number | null;
  readonly fixedFeeIdr: number | null;
  readonly markupBps: number | null;
  readonly roundToIdr: number | null;
  readonly note: string | null;
  readonly createdAtEpochMs: number;
  /** Request identity for the audit trail (uuid). */
  readonly requestId: string;
  readonly auditDescriptor: AuditEventDescriptor;
}

/** Everything the adapter needs to flip one dimension's `enabled` flag. */
export interface ToggleDimensionRecord {
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly enabled: boolean;
  readonly updatedAtEpochMs: number;
  /** Request identity for the audit trail (uuid). */
  readonly requestId: string;
  readonly auditDescriptor: AuditEventDescriptor;
}

/**
 * The outcome of an attempted insert. `duplicate` is a first-class result, not
 * an exception: the unique index on the triple is the authority on whether a
 * dimension already exists, and racing operators must get a clean report rather
 * than a constraint crash.
 */
export type DeclareDimensionResult = { readonly declared: true } | { readonly declared: false };

/** `not_found` covers a triple with no row — nothing to toggle. */
export type ToggleDimensionResult = { readonly toggled: true } | { readonly toggled: false };

/**
 * Catalog-dimension persistence.
 *
 * `declare` INSERTs a row and writes its audit event in ONE transaction, and
 * reports a pre-existing triple instead of throwing. `toggle` UPDATEs only the
 * `enabled` column — never the triple and never an override — so the
 * immutability trigger is respected rather than worked around. There is no
 * `update` and no `delete` method: the trigger refuses both, and the pricing
 * immutability it protects is what makes a quote's `quoteVersion` a correct
 * expiry signal.
 */
export interface AdminCatalogDimensionGateway {
  list(): Promise<readonly AdminCatalogDimensionRow[]>;
  declare(record: DeclareDimensionRecord): Promise<DeclareDimensionResult>;
  toggle(record: ToggleDimensionRecord): Promise<ToggleDimensionResult>;
}
