/**
 * Application-owned ports for Offer commands, config-pricing, and the inventory
 * eligibility query (task 8.4).
 *
 * The offer-management service orchestrates the pure task 5.2 pricing/offer
 * domain (`validateOffer`, `calculateAuthoritativePricing`,
 * `assertBasePriceWithinGuardrail`) and the task 5.7 config invariants over
 * these ports; the inventory-query service orchestrates the deterministic
 * eligibility selector (`selectEligibleInventory`, `number.id ASC`).
 * Infrastructure supplies the Prisma adapters built on the task 7.1
 * tenant-scoped unit of work (offer commands are tenant-scoped) and a
 * platform-wide read (inventory is aggregated across every approved partner for
 * the buyer-facing Internal API). Raw Prisma never leaves the adapter.
 *
 * Server authority (requirements 8.4, 8.6): the client only ever supplies a
 * `basePriceIdr`; retail and payout are always computed server-side from the
 * immutable active {@link PlatformConfigSnapshot}. The guardrail Rp500–Rp5.000
 * is enforced server-side and an out-of-range base is rejected with
 * `PRICE_OUT_OF_GUARDRAIL` (requirement 8.2, 8.3).
 *
 * The MVP-global rule "at most one active offer per (partner, service, country,
 * operator) dimension" (requirement 8.1) is enforced by the database unique
 * `activeDimensionKey` slot (set while active, cleared while inactive). A
 * collision surfaces as {@link ActiveOfferConflictError} from the adapter, which
 * the service maps to a stable `duplicate_active_offer` outcome.
 */
import type {
  CatalogDimension,
  CatalogSnapshot,
  DimensionLookup,
  InventoryCandidate,
  InventoryFilter,
  OfferStatus,
  PartnerStatus,
  PricingConfig,
} from "@domain/task-5-2-device-inventory-pricing";
import type { AuditEventDescriptor } from "@domain/task-5-7";
import type { TenantContext } from "@infrastructure/database";

export type {
  CatalogDimension,
  CatalogSnapshot,
  DimensionLookup,
  InventoryCandidate,
  InventoryFilter,
  OfferStatus,
  PartnerStatus,
};

/**
 * The immutable, versioned active platform config projected onto the shape the
 * pure pricing/eligibility domain needs. Extends the domain {@link PricingConfig}
 * (guardrail, fee, markup, round unit, catalog dimensions, currency, version)
 * with the heartbeat-liveness window used by inventory eligibility. A newer
 * config never mutates an existing snapshot — reservations keep their own
 * `configVersion` — so this is only ever read, never rewritten in place
 * (requirement 8.5).
 */
export interface PlatformConfigSnapshot extends PricingConfig {
  /** Heartbeat staleness threshold in seconds (device liveness). */
  readonly heartbeatTimeoutSeconds: number;
}

/**
 * The served catalog: which service/country/operator dimensions the platform
 * currently offers, each with its optional pricing overrides.
 *
 * This is deliberately a SEPARATE read from {@link PlatformConfigSnapshot}. The
 * config row still single-sources every platform-wide value (pricing formula
 * inputs, `currency`, heartbeat + order windows, and the money-path
 * `earningHoldSeconds` / `minimumPayoutIdr`); the dimension list only says which
 * dimensions those values are applied to, and may override the pricing inputs
 * per dimension. Modelling dimensions as extra config rows would duplicate the
 * global values per dimension and let money-path numbers diverge.
 */
export interface CatalogDimensionReader {
  /**
   * The enabled dimensions plus whether ANY dimension has been declared. The
   * `declared` flag lets the domain distinguish "the platform serves nothing"
   * from "no catalog has been declared yet", the latter falling back to the
   * config's own dimension so a freshly-migrated database can still sell.
   */
  loadCatalog(): Promise<CatalogSnapshot>;
  /**
   * The dimension row for one triple regardless of its `enabled` flag, plus the
   * same `declared` signal. A disabled row is returned (rather than `null`) so
   * the caller can price an existing offer on a withdrawn dimension without
   * having to invent a pricing config.
   */
  loadDimension(filter: InventoryFilter): Promise<DimensionLookup>;
}

/**
 * Raised by the persistence adapter when the global unique active-dimension
 * slot is already taken (requirement 8.1). Declared here so the adapter can
 * throw a layer-neutral error the service catches without importing Prisma
 * error types.
 */
export class ActiveOfferConflictError extends Error {
  constructor() {
    super("An active offer already exists for this catalog dimension");
    this.name = "ActiveOfferConflictError";
  }
}

/**
 * Raised by the persistence adapter when an offer cannot be deleted because a
 * `PartnerOrder` still references it (foreign-key restrict). Deleting supply an
 * order snapshot depends on would corrupt the ledger, so the service surfaces
 * this as a stable `offer_in_use` outcome.
 */
export class OfferInUseError extends Error {
  constructor() {
    super("Offer is referenced by an existing order and cannot be deleted");
    this.name = "OfferInUseError";
  }
}

/** A safe, tenant-scoped persistence view of a `PartnerOffer` (no internals). */
export interface OfferRecord {
  readonly id: string;
  readonly partnerId: string;
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly basePriceIdr: number;
  readonly status: OfferStatus;
  /** The config version the offer was last validated against (snapshot). */
  readonly configVersion: number;
}

/** The row to insert when creating an offer. */
export interface NewOfferRecord {
  readonly id: string;
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly basePriceIdr: number;
  readonly status: OfferStatus;
  readonly configVersion: number;
  /**
   * The globally-unique active-dimension slot. Set to
   * `${partnerId}:${service}:${country}:${operator}` while the offer is active;
   * `null` frees the slot while inactive.
   */
  readonly activeDimensionKey: string | null;
  readonly createdAtEpochMs: number;
}

/** A base-price / status / config-version mutation applied to an offer. */
export interface OfferMutation {
  readonly basePriceIdr: number;
  readonly status: OfferStatus;
  readonly configVersion: number;
  readonly activeDimensionKey: string | null;
}

/** An audit event to persist alongside an offer mutation (requirement 19.1). */
export interface AuditWriteInput {
  readonly id: string;
  readonly partnerId: string;
  readonly requestId: string;
  readonly descriptor: AuditEventDescriptor;
}

/**
 * Operations available inside a tenant-scoped offer-management transaction.
 * Every read/write is folded with the tenant's `partnerId` (task 7.1), so a
 * cross-tenant id is indistinguishable from a missing row (`null`).
 */
export interface OfferManagementTransaction extends CatalogDimensionReader {
  /** The caller's own partner status; gates offer creation (requirement 8.1). */
  loadPartnerStatus(): Promise<PartnerStatus | null>;
  /** The immutable active platform config (guardrail + pricing rules). */
  loadActiveConfig(): Promise<PlatformConfigSnapshot | null>;
  findOfferById(id: string): Promise<OfferRecord | null>;
  /** Insert an offer; throws {@link ActiveOfferConflictError} on collision. */
  insertOffer(record: NewOfferRecord): Promise<OfferRecord>;
  /** Apply a mutation; throws {@link ActiveOfferConflictError} on collision. */
  updateOffer(id: string, mutation: OfferMutation): Promise<OfferRecord>;
  /** Hard-delete an offer; throws {@link OfferInUseError} if orders reference it. */
  deleteOfferById(id: string): Promise<void>;
  recordAudit(input: AuditWriteInput): Promise<void>;
}

/**
 * Runs offer-management work inside a single tenant-scoped transaction bound to
 * a validated {@link TenantContext} (task 7.1 unit of work).
 */
export interface OfferManagementGateway {
  runInTenant<T>(
    tenant: TenantContext,
    work: (tx: OfferManagementTransaction) => Promise<T>,
  ): Promise<T>;
}

/**
 * Platform-wide inventory read for the buyer-facing Internal API. Unlike the
 * offer commands this is intentionally NOT tenant-scoped: the buyer sees supply
 * aggregated across every approved partner. The adapter still keeps raw Prisma
 * internal and only returns pure-domain candidates + the active config.
 */
export interface InventoryQueryGateway extends CatalogDimensionReader {
  /** The immutable active platform config (pricing + liveness window). */
  loadActiveConfig(): Promise<PlatformConfigSnapshot | null>;
  /**
   * Candidate inventory rows matching the catalog filter, already projected
   * onto the pure-domain {@link InventoryCandidate} shape. The eligibility
   * conjunction and deterministic `number.id ASC` ordering are applied by the
   * domain, not the query, so the selection rule lives in exactly one place.
   */
  loadCandidates(filter: InventoryFilter): Promise<readonly InventoryCandidate[]>;
}

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Generates opaque identifiers (UUIDs) for new offers / audit rows. */
export interface IdGenerator {
  uuid(): string;
}
