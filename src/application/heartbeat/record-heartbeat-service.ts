/**
 * Shared device heartbeat command (task 8.2).
 *
 * A valid heartbeat (requirement 6.1) persists a heartbeat sample with the
 * server-authoritative receive time, advances the device's `lastSeenAt`
 * monotonically (`max(existing, receivedAtServer)`), stores the validated,
 * non-authoritative metadata sample (requirement 6.4), and moves the device
 * `offline -> online` (a `disabled` device stays disabled and is rejected
 * fail-closed). Client-supplied time is only metadata; server time decides
 * liveness (design section 7).
 *
 * On recovery, the command propagates status only to the device's *idle*
 * numbers (requirement 6.3): an `offline` idle number returns to `available`
 * only when it is enabled, has an active offer, and has no active order.
 * `reserved`/`busy` numbers are never reassigned and `disabled` numbers stay
 * disabled — the pure `reconcileNumberAvailability` domain enforces this. Every
 * number status change is recorded in `NumberStateHistory` for audit
 * (requirement 7.6) in the same transaction.
 *
 * All logic runs through pure task 5.2 domain functions
 * (`recordServerHeartbeat`, `isDeviceLive`, `reconcileNumberAvailability`,
 * `sanitizeHeartbeatMetadata`) so this command is transport-neutral and reused
 * by the Agent API heartbeat endpoint (task 11.2).
 */
import {
  MVP_HEARTBEAT_TIMEOUT_SECONDS,
  parseDeviceCapabilities,
  recordServerHeartbeat,
  reconcileNumberAvailability,
  sanitizeHeartbeatMetadata,
  Task52DomainError,
  type DeviceCapabilities,
  type DeviceState,
  type HeartbeatMetadata,
  type NumberStatus,
} from "@domain/task-5-2-device-inventory-pricing";
import type { TenantContext } from "@infrastructure/database";

import type {
  ActiveOfferDimension,
  Clock,
  HeartbeatDeviceView,
  HeartbeatGateway,
  IdGenerator,
  IdleNumberRow,
  RecordHeartbeatTransaction,
} from "./ports";

/** Reason recorded on a number's state-history when a heartbeat recovers it. */
const RECOVERY_REASON = "heartbeat_recovery";

export interface RecordHeartbeatInput {
  /** Trusted tenant scope, derived from the authenticated device credential. */
  readonly tenant: TenantContext;
  readonly deviceId: string;
  /** Server-authoritative receive time; decides liveness and `lastSeenAt`. */
  readonly receivedAtServer: Date;
  /** Raw heartbeat metadata; validated and never trusted as authorization. */
  readonly metadata?: unknown;
  /** Optional capabilities update carried by the heartbeat. */
  readonly capabilities?: unknown;
}

export type RecordHeartbeatOutcome =
  | {
      readonly ok: true;
      readonly device: HeartbeatDeviceView;
      /** Ids of idle numbers recovered `offline -> available` by this beat. */
      readonly recoveredNumberIds: readonly string[];
    }
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "device_disabled" }
  | { readonly ok: false; readonly reason: "validation"; readonly code: string };

export interface RecordHeartbeatServiceDeps {
  readonly gateway: HeartbeatGateway;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  /** Liveness threshold in seconds; defaults to the MVP 90s window. */
  readonly heartbeatTimeoutSeconds?: number;
}

export class RecordHeartbeatService {
  private readonly deps: RecordHeartbeatServiceDeps;
  private readonly heartbeatTimeoutSeconds: number;

  constructor(deps: RecordHeartbeatServiceDeps) {
    this.deps = deps;
    this.heartbeatTimeoutSeconds =
      deps.heartbeatTimeoutSeconds ?? MVP_HEARTBEAT_TIMEOUT_SECONDS;
  }

  async recordHeartbeat(input: RecordHeartbeatInput): Promise<RecordHeartbeatOutcome> {
    if (!(input.receivedAtServer instanceof Date) || !Number.isFinite(input.receivedAtServer.getTime())) {
      return { ok: false, reason: "validation", code: "INVALID_HEARTBEAT" };
    }

    // Validate metadata/capabilities up front so a bad payload never opens a
    // transaction. The pure domain is the single source of validation.
    let metadata: HeartbeatMetadata;
    let capabilities: DeviceCapabilities | null;
    try {
      metadata = sanitizeHeartbeatMetadata(input.metadata);
      capabilities =
        input.capabilities === undefined ? null : parseDeviceCapabilities(input.capabilities);
    } catch (error) {
      return { ok: false, reason: "validation", code: domainErrorCode(error) };
    }

    return this.deps.gateway.runInTenant(input.tenant, async (tx) => {
      const device = await tx.findDeviceForHeartbeat(input.deviceId);
      if (device === null) return { ok: false, reason: "not_found" } as const;

      // Fail-closed: a disabled device cannot heartbeat itself back online
      // (requirement 5.6). The Agent API rejects it earlier; this is
      // defense-in-depth so no device/number state is mutated.
      if (device.status === "disabled") {
        return { ok: false, reason: "device_disabled" } as const;
      }

      const previous: DeviceState = {
        type: device.type,
        status: device.status,
        lastSeenAt: device.lastSeenAtEpochMs === null ? null : new Date(device.lastSeenAtEpochMs),
        capabilities: device.capabilities,
      };

      // Monotonic, server-time-authoritative update: offline -> online with
      // lastSeenAt = max(existing, receivedAtServer).
      const updated = recordServerHeartbeat(previous, input.receivedAtServer, {
        metadata: input.metadata,
        ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
      });
      const lastSeenAtEpochMs =
        updated.lastSeenAt === null
          ? input.receivedAtServer.getTime()
          : updated.lastSeenAt.getTime();

      await tx.insertHeartbeatSample({
        id: this.deps.idGenerator.uuid(),
        deviceId: device.id,
        receivedAtEpochMs: input.receivedAtServer.getTime(),
        signal: metadata.signal ?? null,
        operator: metadata.operator ?? null,
        health: metadata.health ?? null,
        agentVersion: metadata.agentVersion ?? null,
      });

      const deviceView = await tx.applyHeartbeatToDevice(device.id, {
        status: updated.status,
        lastSeenAtEpochMs,
        agentVersion: metadata.agentVersion ?? device.agentVersion,
        metadataJson: toMetadataJson(metadata),
        capabilities,
      });

      const recoveredNumberIds = await this.reconcileIdleNumbers(tx, {
        device: updated,
        deviceId: device.id,
        nowServer: input.receivedAtServer,
        lastSeenAtEpochMs,
      });

      return { ok: true, device: deviceView, recoveredNumberIds } as const;
    });
  }

  /**
   * Recompute the effective availability of the device's idle numbers now that
   * the device is live, promoting eligible `offline` numbers back to
   * `available`. `reserved`/`busy`/`disabled` numbers are excluded by the
   * query and, defensively, by the pure reconcile function.
   */
  private async reconcileIdleNumbers(
    tx: RecordHeartbeatTransaction,
    args: {
      readonly device: DeviceState;
      readonly deviceId: string;
      readonly nowServer: Date;
      readonly lastSeenAtEpochMs: number;
    },
  ): Promise<readonly string[]> {
    const idleNumbers = await tx.listIdleNumbers(args.deviceId);
    if (idleNumbers.length === 0) return [];

    const offerDimensions = await tx.listActiveOfferDimensions();
    const recovered: string[] = [];

    for (const number of idleNumbers) {
      const target: NumberStatus = reconcileNumberAvailability({
        status: number.status,
        enabled: number.enabled,
        hasActiveOrder: number.hasActiveOrder,
        hasActiveOffer: hasMatchingOffer(number, offerDimensions),
        device: { status: args.device.status, lastSeenAt: args.device.lastSeenAt },
        nowServer: args.nowServer,
        heartbeatTimeoutSeconds: this.heartbeatTimeoutSeconds,
      });

      if (target === number.status) continue;

      await tx.applyNumberStatus({
        numberId: number.id,
        fromStatus: number.status,
        toStatus: target,
        historyId: this.deps.idGenerator.uuid(),
        actorRef: args.deviceId,
        reason: RECOVERY_REASON,
        occurredAtEpochMs: args.lastSeenAtEpochMs,
      });

      if (target === "available") recovered.push(number.id);
    }

    return recovered;
  }
}

/** True when an active offer covers the number's catalog dimensions. */
function hasMatchingOffer(
  number: IdleNumberRow,
  offerDimensions: readonly ActiveOfferDimension[],
): boolean {
  return offerDimensions.some(
    (dimension) =>
      dimension.countryCode === number.countryCode &&
      dimension.operatorCode === number.operatorCode,
  );
}

/** Convert the validated metadata sample into a plain JSON record for storage. */
function toMetadataJson(
  metadata: HeartbeatMetadata,
): Readonly<Record<string, unknown>> | null {
  const entries = Object.entries(metadata).filter(([, value]) => value !== undefined);
  return entries.length === 0 ? null : Object.fromEntries(entries);
}

/** Map a task 5.2 domain validation failure onto a stable code. */
function domainErrorCode(error: unknown): string {
  return error instanceof Task52DomainError ? error.code : "INVALID_HEARTBEAT";
}
