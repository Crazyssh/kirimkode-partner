/**
 * Admin PlatformConfig management service (task 15.4, requirements 16.5, 19.1).
 *
 * Backs the admin config form. It reads the current active config (all editable
 * fields) and publishes a validated update as a brand-new immutable version —
 * an existing version is never mutated, so orders keep the exact config they
 * snapshotted (requirement 8.5). Every publish:
 *   - requires the {@link CONFIG_ADMIN_PERMISSION} (least privilege, req 19.1);
 *   - requires a non-empty reason;
 *   - is validated by the pure config invariants ({@link validatePlatformConfig},
 *     Property 25) before anything is written, so guardrail ordering, timeout
 *     relationships, heartbeat cadence, and non-negative retention always hold
 *     (requirement 16.5);
 *   - appends the new version and writes a complete `config.changed` audit
 *     event atomically.
 *
 * Non-editable columns (catalog dimensions, currency, non-MVP cadence, and the
 * simulator allowlist) are carried forward unchanged from the current version.
 */
import {
  createAuditEvent,
  validatePlatformConfig,
  type ConfigViolation,
  type PlatformConfigInput,
} from "@domain/task-5-7";
import {
  adminHasPermission,
  CONFIG_ADMIN_PERMISSION,
  type AuthenticatedAdmin,
} from "@domain/task-7-5";

import type {
  ActivePlatformConfigRow,
  AdminConfigGateway,
  Clock,
  EditablePlatformConfigFields,
  IdGenerator,
} from "./config-ports";

const MAX_REASON_LENGTH = 500;
const SECOND_MS = 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export interface AdminConfigUpdateInput {
  readonly admin: AuthenticatedAdmin;
  readonly edited: EditablePlatformConfigFields;
  readonly reason: string;
  /** Request identity for the audit trail (uuid). */
  readonly requestId: string;
}

export type AdminConfigUpdateOutcome =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly reason: "forbidden" }
  | { readonly ok: false; readonly reason: "no_active_config" }
  | { readonly ok: false; readonly reason: "validation"; readonly code: string }
  | { readonly ok: false; readonly reason: "invalid_config"; readonly violations: readonly ConfigViolation[] };

export interface AdminConfigServiceDeps {
  readonly gateway: AdminConfigGateway;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export class AdminConfigService {
  private readonly deps: AdminConfigServiceDeps;

  constructor(deps: AdminConfigServiceDeps) {
    this.deps = deps;
  }

  /** Load the current active config for the form. Null when none is seeded. */
  loadActiveConfig(): Promise<ActivePlatformConfigRow | null> {
    return this.deps.gateway.loadActive();
  }

  /** Validate and publish a new immutable config version (requirement 16.5). */
  async updateConfig(input: AdminConfigUpdateInput): Promise<AdminConfigUpdateOutcome> {
    if (!adminHasPermission(input.admin.permissions, CONFIG_ADMIN_PERMISSION)) {
      return { ok: false, reason: "forbidden" };
    }
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
      return { ok: false, reason: "validation", code: "INVALID_REASON" };
    }

    const active = await this.deps.gateway.loadActive();
    if (active === null) {
      return { ok: false, reason: "no_active_config" };
    }

    // Run the pure activation invariants against the millisecond projection.
    const validation = validatePlatformConfig(toDomainInput(input.edited));
    if (!validation.valid) {
      return { ok: false, reason: "invalid_config", violations: validation.violations };
    }

    const now = this.deps.clock.nowEpochMs();
    const nextVersion = active.version + 1;
    const carried = {
      serviceCode: active.serviceCode,
      countryCode: active.countryCode,
      operatorCode: active.operatorCode,
      currency: active.currency,
      heartbeatSweepSeconds: active.heartbeatSweepSeconds,
      reservationRecoverySeconds: active.reservationRecoverySeconds,
      simulatorAllowlist: active.simulatorAllowlist,
    };

    const auditDescriptor = createAuditEvent({
      actorType: "partner_admin",
      actorRef: input.admin.adminId,
      action: "config.changed",
      targetType: "platform_config",
      targetId: `${carried.serviceCode}/${carried.countryCode}/${carried.operatorCode}`,
      result: "success",
      occurredAtEpochMs: now,
      metadata: {
        previousVersion: active.version,
        nextVersion,
        reason,
        // Only non-secret policy scalars; no credentials/secrets exist here.
        minBasePriceIdr: input.edited.minBasePriceIdr,
        maxBasePriceIdr: input.edited.maxBasePriceIdr,
        fixedFeeIdr: input.edited.fixedFeeIdr,
        markupBps: input.edited.markupBps,
        roundToIdr: input.edited.roundToIdr,
        orderTimeoutSeconds: input.edited.orderTimeoutSeconds,
        cancelMinimumSeconds: input.edited.cancelMinimumSeconds,
        heartbeatIntervalSeconds: input.edited.heartbeatIntervalSeconds,
        heartbeatTimeoutSeconds: input.edited.heartbeatTimeoutSeconds,
        earningHoldSeconds: input.edited.earningHoldSeconds,
        minimumPayoutIdr: input.edited.minimumPayoutIdr,
      },
    });

    const published = await this.deps.gateway.publishNewVersion({
      id: this.deps.idGenerator.uuid(),
      edited: input.edited,
      carried,
      activeFromEpochMs: now,
      createdByAdminId: input.admin.adminId,
      requestId: input.requestId,
      auditDescriptor,
    });

    return { ok: true, version: published.version };
  }
}

/** Project the editable DB-unit fields onto the pure millisecond config input. */
function toDomainInput(edited: EditablePlatformConfigFields): PlatformConfigInput {
  return {
    minBasePriceIdr: edited.minBasePriceIdr,
    maxBasePriceIdr: edited.maxBasePriceIdr,
    fixedFeeIdr: edited.fixedFeeIdr,
    markupBps: edited.markupBps,
    roundToIdr: edited.roundToIdr,
    orderTimeoutMs: edited.orderTimeoutSeconds * SECOND_MS,
    cancelMinimumMs: edited.cancelMinimumSeconds * SECOND_MS,
    heartbeatIntervalMs: edited.heartbeatIntervalSeconds * SECOND_MS,
    heartbeatTimeoutMs: edited.heartbeatTimeoutSeconds * SECOND_MS,
    earningHoldMs: edited.earningHoldSeconds * SECOND_MS,
    minimumPayoutIdr: edited.minimumPayoutIdr,
    retention: {
      smsRawMs: edited.smsRawRetentionDays * DAY_MS,
      otpAfterTerminalMs: edited.otpRetentionHours * HOUR_MS,
      heartbeatMetadataMs: edited.heartbeatMetadataRetentionDays * DAY_MS,
      securityLogMs: edited.securityEventRetentionDays * DAY_MS,
      auditMs: edited.auditRetentionDays * DAY_MS,
      ledgerPayoutMs: edited.financialRetentionDays * DAY_MS,
    },
  };
}
