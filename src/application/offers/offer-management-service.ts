/**
 * PartnerOffer lifecycle commands (task 8.4).
 *
 * Create / update-base-price / activate / deactivate / delete an offer for any
 * SERVED catalog dimension. Every command is a sensitive inventory operation
 * gated by the pure permission matrix (task 5.1, `manage_inventory`), re-checks
 * the permission itself (defense-in-depth), operates only within the caller's
 * tenant scope (task 7.1 — a cross-tenant target is indistinguishable from a
 * missing one), and writes an audit event in the same transaction as the
 * mutation (requirement 19.1).
 *
 * All offer/pricing invariants come from the pure task 5.2 domain and the task
 * 5.7 config:
 *   - `validateOffer` requires the partner to be `approved` (requirement 8.1),
 *     matches the offer to an ENABLED catalog dimension (membership, not
 *     equality with the config's own dimension), enforces the guardrail
 *     server-side, and computes the authoritative retail/payout from the base
 *     price (requirements 8.2, 8.3, 8.4, 8.6).
 *   - The client only ever supplies `basePriceIdr`; retail and payout are never
 *     accepted from the client and are always recomputed here (requirement 8.6).
 *   - The immutable active {@link PlatformConfigSnapshot} version is snapshotted
 *     onto the offer's `configVersion`; a base-price change re-validates against
 *     the current active config and only affects new reservations (req 8.5).
 *   - The MVP "one active offer per (partner, catalog) dimension" rule
 *     (requirement 8.1) is enforced by the database `activeDimensionKey` unique
 *     slot; a collision surfaces as {@link ActiveOfferConflictError}.
 *
 * Weighted routing stays out of scope. A dimension is only ever accepted when it
 * is present and enabled in the served catalog, so the client can select among
 * the platform's own dimensions but can never invent one; every mutation on an
 * existing offer is validated against that offer's OWN dimension, so an offer on
 * a second dimension stays repriceable and activatable.
 */
import {
  calculateAuthoritativePricing,
  resolveDimensionPricing,
  resolveServedCatalog,
  Task52DomainError,
  validateOffer,
  type CatalogDimension,
  type InventoryFilter,
  type OfferStatus,
  type PartnerStatus,
  type PricingConfig,
  type PricingResult,
} from "@domain/task-5-2-device-inventory-pricing";
import { createAuditEvent, type AuditEventDescriptor } from "@domain/task-5-7";

import { checkPermission, type SessionContext } from "../authorization/session-context";
import {
  ActiveOfferConflictError,
  OfferInUseError,
  type Clock,
  type IdGenerator,
  type OfferManagementGateway,
  type OfferManagementTransaction,
  type OfferRecord,
  type PlatformConfigSnapshot,
} from "./ports";

export interface CreateOfferInput {
  readonly caller: SessionContext;
  /** Base price in whole IDR; retail/payout are computed server-side. */
  readonly basePriceIdr: number;
  /** Whether the offer starts `active` (default) or `inactive`. */
  readonly activate?: boolean;
  /**
   * Which served catalog dimension the offer is for. Omitted means the active
   * config's own dimension, which is what a single-dimension caller (the portal
   * form) has always meant. A dimension that is not enabled is rejected with the
   * existing `INVALID_OFFER_CATALOG` validation outcome.
   */
  readonly dimension?: InventoryFilter;
  /** Request identity for the audit trail (uuid). */
  readonly requestId: string;
}

export interface OfferIdInput {
  readonly caller: SessionContext;
  readonly offerId: string;
  readonly requestId: string;
}

export interface UpdateOfferBasePriceInput extends OfferIdInput {
  readonly basePriceIdr: number;
}

/** A safe, computed view of an offer returned to the transport layer. */
export interface OfferView extends OfferRecord {
  /** Authoritative server-computed retail/payout/margin for the base price. */
  readonly pricing: PricingResult;
  readonly currency: string;
}

export type OfferCommandOutcome =
  | { readonly ok: true; readonly offer: OfferView }
  | { readonly ok: false; readonly reason: "forbidden" }
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "partner_not_approved" }
  | { readonly ok: false; readonly reason: "config_unavailable" }
  | { readonly ok: false; readonly reason: "duplicate_active_offer" }
  | { readonly ok: false; readonly reason: "offer_in_use" }
  | { readonly ok: false; readonly reason: "price_out_of_guardrail" }
  | { readonly ok: false; readonly reason: "validation"; readonly code: string };

export interface OfferManagementServiceDeps {
  readonly gateway: OfferManagementGateway;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export class OfferManagementService {
  private readonly deps: OfferManagementServiceDeps;

  constructor(deps: OfferManagementServiceDeps) {
    this.deps = deps;
  }

  /**
   * Create an offer for the configured catalog. Only an `approved` partner may
   * create an offer (requirement 8.1). The base price is validated against the
   * server-side guardrail and the authoritative retail/payout is computed from
   * the immutable active config, whose version is snapshotted onto the offer.
   */
  async createOffer(input: CreateOfferInput): Promise<OfferCommandOutcome> {
    const denied = this.requireManageInventory(input.caller);
    if (denied) return denied;

    const activate = input.activate ?? true;

    return this.deps.gateway.runInTenant(input.caller.tenant, async (tx) => {
      const context = await this.loadContext(tx);
      if (context === null) return { ok: false, reason: "config_unavailable" } as const;
      const { partnerStatus, config, dimensions } = context;

      // Default to the config's own dimension so an existing single-dimension
      // caller behaves exactly as before.
      const target: InventoryFilter = input.dimension ?? dimensionOf(config);
      const status: OfferStatus = activate ? "active" : "inactive";
      const validated = this.validate(
        partnerStatus,
        config,
        dimensions,
        target,
        input.basePriceIdr,
        status,
      );
      if (!validated.ok) return validated.outcome;

      const now = this.deps.clock.nowEpochMs();
      const offerId = this.deps.idGenerator.uuid();
      let record: OfferRecord;
      try {
        record = await tx.insertOffer({
          id: offerId,
          serviceCode: target.serviceCode,
          countryCode: target.countryCode,
          operatorCode: target.operatorCode,
          basePriceIdr: input.basePriceIdr,
          status,
          configVersion: config.version,
          activeDimensionKey: activeDimensionKey(
            input.caller.tenant.partnerId,
            target,
            status,
          ),
          createdAtEpochMs: now,
        });
      } catch (error) {
        if (error instanceof ActiveOfferConflictError) {
          return { ok: false, reason: "duplicate_active_offer" } as const;
        }
        throw error;
      }

      await this.writeAudit(tx, input.caller, input.requestId, {
        offerId,
        change: "created",
        status,
        basePriceIdr: input.basePriceIdr,
        configVersion: config.version,
        now,
      });

      return {
        ok: true,
        offer: this.toView(record, config, validated.pricingConfig),
      } as const;
    });
  }

  /**
   * Change an offer's base price. Re-validates the new base against the current
   * active guardrail and re-snapshots the offer's `configVersion`. In-flight
   * orders keep their own snapshot, so this only affects new reservations
   * (requirement 8.5).
   */
  async updateOfferBasePrice(input: UpdateOfferBasePriceInput): Promise<OfferCommandOutcome> {
    const denied = this.requireManageInventory(input.caller);
    if (denied) return denied;

    return this.deps.gateway.runInTenant(input.caller.tenant, async (tx) => {
      const existing = await tx.findOfferById(input.offerId);
      if (existing === null) return { ok: false, reason: "not_found" } as const;

      const context = await this.loadContext(tx);
      if (context === null) return { ok: false, reason: "config_unavailable" } as const;
      const { partnerStatus, config, dimensions } = context;

      // Re-validate against the offer's OWN dimension, not the config's: an
      // offer on a second served dimension must stay repriceable, and the
      // `activeDimensionKey` slot has to keep matching the offer's own triple
      // (the database CHECK constraint requires exactly that).
      const validated = this.validate(
        partnerStatus,
        config,
        dimensions,
        dimensionOf(existing),
        input.basePriceIdr,
        existing.status,
      );
      if (!validated.ok) return validated.outcome;

      const now = this.deps.clock.nowEpochMs();
      const record = await this.applyMutation(tx, existing.id, {
        basePriceIdr: input.basePriceIdr,
        status: existing.status,
        configVersion: config.version,
        activeDimensionKey: activeDimensionKey(
          input.caller.tenant.partnerId,
          dimensionOf(existing),
          existing.status,
        ),
      });
      if (!record.ok) return record.outcome;

      await this.writeAudit(tx, input.caller, input.requestId, {
        offerId: existing.id,
        change: "base_price_changed",
        status: existing.status,
        basePriceIdr: input.basePriceIdr,
        previousBasePriceIdr: existing.basePriceIdr,
        configVersion: config.version,
        now,
      });

      return {
        ok: true,
        offer: this.toView(record.record, config, validated.pricingConfig),
      } as const;
    });
  }

  /**
   * Activate an offer so its supply is discoverable. Re-validates the guardrail
   * server-side and claims the global active-dimension slot (requirement 8.1).
   */
  async activateOffer(input: OfferIdInput): Promise<OfferCommandOutcome> {
    return this.changeStatus(input, "active", "activated");
  }

  /**
   * Deactivate an offer, excluding its supply from new inventory and freeing the
   * global active-dimension slot.
   */
  async deactivateOffer(input: OfferIdInput): Promise<OfferCommandOutcome> {
    return this.changeStatus(input, "inactive", "deactivated");
  }

  /**
   * Delete an offer. Blocked (`offer_in_use`) when a `PartnerOrder` still
   * references it, so order snapshots and the ledger stay intact.
   */
  async deleteOffer(input: OfferIdInput): Promise<OfferCommandOutcome> {
    const denied = this.requireManageInventory(input.caller);
    if (denied) return denied;

    return this.deps.gateway.runInTenant(input.caller.tenant, async (tx) => {
      const existing = await tx.findOfferById(input.offerId);
      if (existing === null) return { ok: false, reason: "not_found" } as const;

      const [config, lookup] = await Promise.all([
        tx.loadActiveConfig(),
        tx.loadDimension(dimensionOf(existing)),
      ]);

      try {
        await tx.deleteOfferById(existing.id);
      } catch (error) {
        if (error instanceof OfferInUseError) {
          return { ok: false, reason: "offer_in_use" } as const;
        }
        throw error;
      }

      const now = this.deps.clock.nowEpochMs();
      await this.writeAudit(tx, input.caller, input.requestId, {
        offerId: existing.id,
        change: "deleted",
        status: existing.status,
        basePriceIdr: existing.basePriceIdr,
        configVersion: existing.configVersion,
        now,
      });

      // Report the deleted offer using its own snapshot config version when the
      // active config is unavailable, so the response never fabricates pricing.
      // Its own dimension's overrides are applied when it still has a row, even
      // if that dimension has since been disabled — the view must show the price
      // the offer actually carried, not a re-based global one.
      const offer: OfferView = config
        ? this.toView(
            existing,
            config,
            lookup.dimension === null
              ? config
              : resolveDimensionPricing(lookup.dimension, config),
          )
        : {
            ...existing,
            currency: "IDR",
            pricing: { retailPriceIdr: 0, payoutIdr: existing.basePriceIdr, platformMarginIdr: 0 },
          };
      return { ok: true, offer } as const;
    });
  }

  private async changeStatus(
    input: OfferIdInput,
    status: OfferStatus,
    change: string,
  ): Promise<OfferCommandOutcome> {
    const denied = this.requireManageInventory(input.caller);
    if (denied) return denied;

    return this.deps.gateway.runInTenant(input.caller.tenant, async (tx) => {
      const existing = await tx.findOfferById(input.offerId);
      if (existing === null) return { ok: false, reason: "not_found" } as const;

      const context = await this.loadContext(tx);
      if (context === null) return { ok: false, reason: "config_unavailable" } as const;
      const { partnerStatus, config, dimensions } = context;

      // Activation re-checks partner approval + guardrail against the offer's
      // OWN dimension; a dimension that has since been withdrawn cannot be
      // re-activated (existing `INVALID_OFFER_CATALOG` outcome). Deactivation
      // only needs a well-formed guardrail, so it does not re-check membership —
      // withdrawing supply must always remain possible.
      let pricingConfig = this.pricingFor(config, dimensions, dimensionOf(existing));
      if (status === "active") {
        const validated = this.validate(
          partnerStatus,
          config,
          dimensions,
          dimensionOf(existing),
          existing.basePriceIdr,
          status,
        );
        if (!validated.ok) return validated.outcome;
        pricingConfig = validated.pricingConfig;
      }

      const now = this.deps.clock.nowEpochMs();
      const record = await this.applyMutation(tx, existing.id, {
        basePriceIdr: existing.basePriceIdr,
        status,
        configVersion: config.version,
        activeDimensionKey: activeDimensionKey(
          input.caller.tenant.partnerId,
          dimensionOf(existing),
          status,
        ),
      });
      if (!record.ok) return record.outcome;

      await this.writeAudit(tx, input.caller, input.requestId, {
        offerId: existing.id,
        change,
        status,
        basePriceIdr: existing.basePriceIdr,
        configVersion: config.version,
        now,
      });

      return { ok: true, offer: this.toView(record.record, config, pricingConfig) } as const;
    });
  }

  private async applyMutation(
    tx: OfferManagementTransaction,
    id: string,
    mutation: OfferMutationArgs,
  ): Promise<{ ok: true; record: OfferRecord } | { ok: false; outcome: OfferCommandOutcome }> {
    try {
      const record = await tx.updateOffer(id, mutation);
      return { ok: true, record };
    } catch (error) {
      if (error instanceof ActiveOfferConflictError) {
        return { ok: false, outcome: { ok: false, reason: "duplicate_active_offer" } };
      }
      throw error;
    }
  }

  /**
   * Load the partner status, active config, and served catalog every command
   * needs. The config remains the single source for the global values; the
   * dimension list only says which dimensions are served and how they override
   * the pricing inputs.
   */
  private async loadContext(tx: OfferManagementTransaction): Promise<{
    partnerStatus: PartnerStatus;
    config: PlatformConfigSnapshot;
    dimensions: readonly CatalogDimension[];
  } | null> {
    const [partnerStatus, config, catalog] = await Promise.all([
      tx.loadPartnerStatus(),
      tx.loadActiveConfig(),
      tx.loadCatalog(),
    ]);
    if (partnerStatus === null || config === null) return null;
    // An undeclared catalog serves the config's own dimension, so a database
    // migrated before its config was seeded behaves exactly as it did before.
    return { partnerStatus, config, dimensions: resolveServedCatalog(catalog, config) };
  }

  /**
   * Run the pure `validateOffer` for one dimension and translate its failure to
   * an outcome. On success it also returns the pricing config in force for that
   * dimension, so the caller's view reports the same numbers validation used.
   */
  private validate(
    partnerStatus: PartnerStatus,
    config: PlatformConfigSnapshot,
    dimensions: readonly CatalogDimension[],
    dimension: InventoryFilter,
    basePriceIdr: number,
    status: OfferStatus,
  ):
    | { ok: true; pricingConfig: PricingConfig }
    | { ok: false; outcome: OfferCommandOutcome } {
    try {
      validateOffer(
        partnerStatus,
        {
          serviceCode: dimension.serviceCode,
          countryCode: dimension.countryCode,
          operatorCode: dimension.operatorCode,
          basePriceIdr,
          status,
        },
        config,
        dimensions,
      );
      return { ok: true, pricingConfig: this.pricingFor(config, dimensions, dimension) };
    } catch (error) {
      return { ok: false, outcome: mapValidationError(error) };
    }
  }

  /**
   * The pricing config in force for a dimension: the global config with that
   * dimension's overrides applied, falling back to the bare global config when
   * the dimension is not in the served set (a deactivation path, or a legacy
   * offer whose dimension has been withdrawn).
   */
  private pricingFor(
    config: PlatformConfigSnapshot,
    dimensions: readonly CatalogDimension[],
    dimension: InventoryFilter,
  ): PricingConfig {
    const served = dimensions.find(
      (candidate) =>
        candidate.serviceCode === dimension.serviceCode &&
        candidate.countryCode === dimension.countryCode &&
        candidate.operatorCode === dimension.operatorCode,
    );
    return served === undefined ? config : resolveDimensionPricing(served, config);
  }

  /**
   * Project an offer row onto its view. `currency` always comes from the global
   * config; the retail/payout numbers come from the offer's own dimension
   * pricing so an overridden dimension reports its real price.
   */
  private toView(
    record: OfferRecord,
    config: PlatformConfigSnapshot,
    pricingConfig: PricingConfig = config,
  ): OfferView {
    return {
      ...record,
      currency: config.currency,
      pricing: calculateAuthoritativePricing({ basePriceIdr: record.basePriceIdr }, pricingConfig),
    };
  }

  private requireManageInventory(
    caller: SessionContext,
  ): { readonly ok: false; readonly reason: "forbidden" } | null {
    const permission = checkPermission(caller, "manage_inventory");
    return permission.allowed ? null : { ok: false, reason: "forbidden" };
  }

  private async writeAudit(
    tx: OfferManagementTransaction,
    caller: SessionContext,
    requestId: string,
    args: {
      readonly offerId: string;
      readonly change: string;
      readonly status: OfferStatus;
      readonly basePriceIdr: number;
      readonly previousBasePriceIdr?: number;
      readonly configVersion: number;
      readonly now: number;
    },
  ): Promise<void> {
    const descriptor: AuditEventDescriptor = createAuditEvent({
      actorType: "partner_member",
      actorRef: caller.principal.memberId,
      action: "offer.changed",
      targetType: "partner_offer",
      targetId: args.offerId,
      result: "success",
      occurredAtEpochMs: args.now,
      metadata: {
        change: args.change,
        status: args.status,
        basePriceIdr: args.basePriceIdr,
        ...(args.previousBasePriceIdr === undefined
          ? {}
          : { previousBasePriceIdr: args.previousBasePriceIdr }),
        configVersion: args.configVersion,
      },
    });
    await tx.recordAudit({
      id: this.deps.idGenerator.uuid(),
      partnerId: caller.tenant.partnerId,
      requestId,
      descriptor,
    });
  }
}

interface OfferMutationArgs {
  readonly basePriceIdr: number;
  readonly status: OfferStatus;
  readonly configVersion: number;
  readonly activeDimensionKey: string | null;
}

/** The catalog dimension triple carried by a config row or an offer row. */
function dimensionOf(source: InventoryFilter): InventoryFilter {
  return {
    serviceCode: source.serviceCode,
    countryCode: source.countryCode,
    operatorCode: source.operatorCode,
  };
}

/**
 * Build the global active-dimension slot value. It mirrors the database check
 * constraint (`${partnerId}:${service}:${country}:${operator}` while active,
 * `null` otherwise), so the application and the schema agree on the uniqueness
 * key without the adapter re-deriving it. The dimension is the OFFER's own
 * triple, which is what the constraint compares against — deriving it from the
 * active config instead would make any offer outside that dimension unwritable.
 */
function activeDimensionKey(
  partnerId: string,
  dimension: InventoryFilter,
  status: OfferStatus,
): string | null {
  return status === "active"
    ? `${partnerId}:${dimension.serviceCode}:${dimension.countryCode}:${dimension.operatorCode}`
    : null;
}

/** Map a task 5.2 domain failure onto a stable offer-command outcome. */
function mapValidationError(error: unknown): OfferCommandOutcome {
  if (error instanceof Task52DomainError) {
    if (error.code === "PARTNER_NOT_APPROVED") {
      return { ok: false, reason: "partner_not_approved" };
    }
    if (error.code === "PRICE_OUT_OF_GUARDRAIL") {
      return { ok: false, reason: "price_out_of_guardrail" };
    }
    return { ok: false, reason: "validation", code: error.code };
  }
  return { ok: false, reason: "validation", code: "INVALID_OFFER" };
}
