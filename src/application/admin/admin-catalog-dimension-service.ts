/**
 * Admin catalog-dimension management service (requirement 16.5, 19.1).
 *
 * Backs the admin catalog screen. It replaces the only way a dimension could
 * previously be put on sale — a hand-written `INSERT` against the live money-path
 * database — with an authorised, validated, audited command.
 *
 * Two operations, and no more:
 *   - {@link declareDimension} inserts a new service/country/operator triple with
 *     optional pricing overrides, enabled or withheld at creation;
 *   - {@link toggleDimension} flips `enabled`, withdrawing a dimension from sale
 *     or restoring it.
 *
 * There is deliberately NO edit and NO delete. The
 * `catalog_dimensions_pricing_immutable` trigger freezes the triple and all five
 * price overrides after insert and refuses DELETE, and that freeze is load
 * bearing: a buyer's quote carries the GLOBAL `platform_configs.version` as its
 * `quoteVersion`, and reserve rejects a quote whose version is stale. If a
 * per-dimension override could move without the global version moving, an
 * outstanding quote would keep validating while the price behind it had already
 * changed. Freezing the override makes a dimension's price a function of (global
 * config version, immutable override), so `quoteVersion` stays a correct expiry
 * signal. Changing a dimension's price therefore means publishing a new config
 * version — which is what the config form already does.
 *
 * Every command:
 *   - requires the {@link CONFIG_ADMIN_PERMISSION}. Declaring what the platform
 *     sells is a config-class action, so it reuses the existing permission
 *     rather than inventing a parallel one (least privilege, requirement 19.1);
 *   - requires a non-empty reason, as the config form does;
 *   - is validated by the pure {@link validateDimensionDeclaration} before
 *     anything is written, so an input the database would refuse is reported as
 *     a named field and a stable code instead of a constraint crash;
 *   - writes a `config.changed` audit event in the same transaction as the row.
 */
import {
  createAuditEvent,
  type AuditEventDescriptor,
} from "@domain/task-5-7";
import {
  describeDimensionOverrides,
  validateDimensionDeclaration,
  type DimensionDeclarationInput,
  type DimensionDeclarationViolation,
} from "@domain/task-5-2-device-inventory-pricing";
import {
  adminHasPermission,
  CONFIG_ADMIN_PERMISSION,
  type AuthenticatedAdmin,
} from "@domain/task-7-5";

import type {
  AdminCatalogDimensionGateway,
  AdminCatalogDimensionRow,
  Clock,
  IdGenerator,
} from "./catalog-dimension-ports";

const MAX_REASON_LENGTH = 500;

/**
 * The audit `targetType` for a dimension. Distinct from the config form's
 * `platform_config` so an operator can filter the audit browser for catalog
 * changes specifically, while both actions share the `config.changed` action —
 * they are the same class of change to what the platform sells.
 */
const DIMENSION_TARGET_TYPE = "catalog_dimension";

export interface DeclareDimensionInput extends DimensionDeclarationInput {
  readonly admin: AuthenticatedAdmin;
  readonly reason: string;
  /** Request identity for the audit trail (uuid). */
  readonly requestId: string;
}

export interface ToggleDimensionInput {
  readonly admin: AuthenticatedAdmin;
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly enabled: boolean;
  readonly reason: string;
  /** Request identity for the audit trail (uuid). */
  readonly requestId: string;
}

/** One dimension plus the derived override/inherited summary for the view. */
export interface AdminCatalogDimensionView extends AdminCatalogDimensionRow {
  /** Per pricing input: true when overridden, false when inherited. */
  readonly overridden: Readonly<Record<string, boolean>>;
}

export type DeclareDimensionOutcome =
  | { readonly ok: true; readonly dimension: string }
  | { readonly ok: false; readonly reason: "forbidden" }
  | { readonly ok: false; readonly reason: "validation"; readonly code: string }
  | {
      readonly ok: false;
      readonly reason: "invalid_dimension";
      readonly violations: readonly DimensionDeclarationViolation[];
    }
  | { readonly ok: false; readonly reason: "duplicate"; readonly dimension: string };

export type ToggleDimensionOutcome =
  | { readonly ok: true; readonly dimension: string; readonly enabled: boolean }
  | { readonly ok: false; readonly reason: "forbidden" }
  | { readonly ok: false; readonly reason: "validation"; readonly code: string }
  | {
      readonly ok: false;
      readonly reason: "invalid_dimension";
      readonly violations: readonly DimensionDeclarationViolation[];
    }
  | { readonly ok: false; readonly reason: "not_found"; readonly dimension: string };

export interface AdminCatalogDimensionServiceDeps {
  readonly gateway: AdminCatalogDimensionGateway;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

/** The operator-facing `service/country/operator` label, used as the audit target. */
function dimensionKey(dimension: {
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
}): string {
  return `${dimension.serviceCode}/${dimension.countryCode}/${dimension.operatorCode}`;
}

export class AdminCatalogDimensionService {
  private readonly deps: AdminCatalogDimensionServiceDeps;

  constructor(deps: AdminCatalogDimensionServiceDeps) {
    this.deps = deps;
  }

  /**
   * Every declared dimension with its enabled state, which pricing inputs are
   * overridden, and how many offers reference it. Read-only, so it needs an
   * authenticated admin but no extra permission — the same split the config form
   * uses (anyone in the realm may look; only `config:admin` may change).
   */
  async listDimensions(): Promise<readonly AdminCatalogDimensionView[]> {
    const rows = await this.deps.gateway.list();
    return rows.map((row) => ({ ...row, overridden: describeDimensionOverrides(row) }));
  }

  /** Declare a new dimension: validate, insert, audit (requirement 16.5). */
  async declareDimension(input: DeclareDimensionInput): Promise<DeclareDimensionOutcome> {
    if (!adminHasPermission(input.admin.permissions, CONFIG_ADMIN_PERMISSION)) {
      return { ok: false, reason: "forbidden" };
    }
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
      return { ok: false, reason: "validation", code: "INVALID_REASON" };
    }

    // Reject anything the database would reject, before touching it.
    const validation = validateDimensionDeclaration(input);
    if (!validation.valid) {
      return { ok: false, reason: "invalid_dimension", violations: validation.violations };
    }
    const declaration = validation.declaration;
    const key = dimensionKey(declaration);
    const now = this.deps.clock.nowEpochMs();

    const result = await this.deps.gateway.declare({
      id: this.deps.idGenerator.uuid(),
      ...declaration,
      createdAtEpochMs: now,
      requestId: input.requestId,
      auditDescriptor: this.auditDescriptor({
        admin: input.admin,
        targetId: key,
        occurredAtEpochMs: now,
        // A refused duplicate is still an attributable attempt, so the
        // descriptor is built once and its `result` set from the outcome.
        result: "success",
        metadata: {
          operation: "declare",
          reason,
          enabled: declaration.enabled,
          minBasePriceIdr: declaration.minBasePriceIdr,
          maxBasePriceIdr: declaration.maxBasePriceIdr,
          fixedFeeIdr: declaration.fixedFeeIdr,
          markupBps: declaration.markupBps,
          roundToIdr: declaration.roundToIdr,
          note: declaration.note,
        },
      }),
    });

    if (!result.declared) {
      return { ok: false, reason: "duplicate", dimension: key };
    }
    return { ok: true, dimension: key };
  }

  /**
   * Withdraw a dimension from sale, or put it back (requirement 16.5).
   *
   * Disabling can only ever make a dimension LESS available: the quote and
   * reserve paths refuse a disabled dimension with the existing
   * `CATALOG_UNAVAILABLE`, and existing offers/orders on it keep their rows and
   * their prices. That is why this is the one mutation the trigger permits.
   */
  async toggleDimension(input: ToggleDimensionInput): Promise<ToggleDimensionOutcome> {
    if (!adminHasPermission(input.admin.permissions, CONFIG_ADMIN_PERMISSION)) {
      return { ok: false, reason: "forbidden" };
    }
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
      return { ok: false, reason: "validation", code: "INVALID_REASON" };
    }

    // The triple is validated with the same pure rules as a declaration, so a
    // malformed target can never reach the database as a no-op UPDATE.
    const validation = validateDimensionDeclaration({
      serviceCode: input.serviceCode,
      countryCode: input.countryCode,
      operatorCode: input.operatorCode,
      enabled: input.enabled,
    });
    if (!validation.valid) {
      return { ok: false, reason: "invalid_dimension", violations: validation.violations };
    }
    const key = dimensionKey(validation.declaration);
    const now = this.deps.clock.nowEpochMs();

    const result = await this.deps.gateway.toggle({
      serviceCode: validation.declaration.serviceCode,
      countryCode: validation.declaration.countryCode,
      operatorCode: validation.declaration.operatorCode,
      enabled: input.enabled,
      updatedAtEpochMs: now,
      requestId: input.requestId,
      auditDescriptor: this.auditDescriptor({
        admin: input.admin,
        targetId: key,
        occurredAtEpochMs: now,
        result: "success",
        metadata: { operation: "toggle", reason, enabled: input.enabled },
      }),
    });

    if (!result.toggled) {
      return { ok: false, reason: "not_found", dimension: key };
    }
    return { ok: true, dimension: key, enabled: input.enabled };
  }

  /**
   * The audit descriptor for a dimension command. Only non-secret policy scalars
   * reach the metadata — a dimension carries no credentials — and the actor is
   * the resolved admin id, which the repository stores as a hash.
   */
  private auditDescriptor(input: {
    readonly admin: AuthenticatedAdmin;
    readonly targetId: string;
    readonly occurredAtEpochMs: number;
    readonly result: "success" | "failure";
    readonly metadata: Readonly<Record<string, unknown>>;
  }): AuditEventDescriptor {
    return createAuditEvent({
      actorType: "partner_admin",
      actorRef: input.admin.adminId,
      action: "config.changed",
      targetType: DIMENSION_TARGET_TYPE,
      targetId: input.targetId,
      result: input.result,
      occurredAtEpochMs: input.occurredAtEpochMs,
      metadata: input.metadata,
    });
  }
}
