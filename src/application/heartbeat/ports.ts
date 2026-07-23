/**
 * Application-owned ports for the shared device heartbeat command (task 8.2).
 *
 * The heartbeat command orchestrates the pure task 5.2 domain
 * (`recordServerHeartbeat`, `isDeviceLive`, `reconcileNumberAvailability`,
 * `sanitizeHeartbeatMetadata`) over these ports; infrastructure supplies the
 * Prisma adapter built on the task 7.1 tenant-scoped repositories + unit of
 * work. Persisting the heartbeat sample, advancing `lastSeenAt`/effective
 * status, and reconciling the device's idle numbers all run inside a single
 * tenant-scoped transaction so the update is atomic. Raw Prisma never leaves
 * the adapter. This is the reusable command later invoked by the Agent API
 * heartbeat endpoint (task 11.2).
 */
import type {
  DeviceCapabilities,
  DeviceStatus,
  DeviceType,
  NumberStatus,
} from "@domain/task-5-2-device-inventory-pricing";
import type { TenantContext } from "@infrastructure/database";

export type { DeviceCapabilities, DeviceStatus, DeviceType, NumberStatus };

/**
 * A tenant-scoped view of the device as needed by the heartbeat command. The
 * `status` is the persisted effective status and `lastSeenAtEpochMs` the last
 * server-authoritative liveness stamp; both feed the monotonic domain update.
 */
export interface HeartbeatDeviceRow {
  readonly id: string;
  readonly partnerId: string;
  readonly type: DeviceType;
  readonly status: DeviceStatus;
  readonly lastSeenAtEpochMs: number | null;
  readonly capabilities: DeviceCapabilities;
  readonly agentVersion: string | null;
}

/** The heartbeat sample row to persist (append-only observability record). */
export interface HeartbeatSampleRecord {
  readonly id: string;
  readonly deviceId: string;
  readonly receivedAtEpochMs: number;
  readonly signal: number | null;
  readonly operator: string | null;
  readonly health: Readonly<Record<string, unknown>> | null;
  readonly agentVersion: string | null;
}

/** The mutation applied to the device row by a valid heartbeat. */
export interface HeartbeatDeviceUpdate {
  readonly status: DeviceStatus;
  readonly lastSeenAtEpochMs: number;
  readonly agentVersion: string | null;
  /** Validated, non-authoritative metadata sample stored on the device. */
  readonly metadataJson: Readonly<Record<string, unknown>> | null;
  /** Only set when the heartbeat carried a capabilities update. */
  readonly capabilities: DeviceCapabilities | null;
}

/** A safe, tenant-scoped view of a device after a heartbeat is applied. */
export interface HeartbeatDeviceView {
  readonly id: string;
  readonly partnerId: string;
  readonly type: DeviceType;
  readonly status: DeviceStatus;
  readonly lastSeenAtEpochMs: number;
  readonly agentVersion: string | null;
  readonly capabilities: DeviceCapabilities;
}

/**
 * An idle number owned by the device that may be recovered by a heartbeat. Only
 * `offline`/`available` numbers are surfaced — `reserved`/`busy` numbers are
 * never reassigned by a heartbeat, and `disabled` numbers stay disabled.
 */
export interface IdleNumberRow {
  readonly id: string;
  readonly status: NumberStatus;
  readonly enabled: boolean;
  readonly countryCode: string;
  readonly operatorCode: string;
  /** True when the number still points at an active order. */
  readonly hasActiveOrder: boolean;
}

/** A catalog dimension covered by an active offer for the tenant. */
export interface ActiveOfferDimension {
  readonly countryCode: string;
  readonly operatorCode: string;
}

/** A number status change to persist together with its state-history entry. */
export interface NumberStatusChange {
  readonly numberId: string;
  readonly fromStatus: NumberStatus;
  readonly toStatus: NumberStatus;
  /** SHA-256-hashed actor reference (the device id) for the history row. */
  readonly historyId: string;
  readonly actorRef: string;
  readonly reason: string;
  readonly occurredAtEpochMs: number;
}

/**
 * Operations available inside a tenant-scoped heartbeat transaction. Reads and
 * writes are folded with the tenant's `partnerId`; a cross-tenant id is
 * indistinguishable from a missing row (`null`).
 */
export interface RecordHeartbeatTransaction {
  findDeviceForHeartbeat(deviceId: string): Promise<HeartbeatDeviceRow | null>;
  insertHeartbeatSample(sample: HeartbeatSampleRecord): Promise<void>;
  applyHeartbeatToDevice(
    deviceId: string,
    update: HeartbeatDeviceUpdate,
  ): Promise<HeartbeatDeviceView>;
  /** Idle (`offline`/`available`) numbers owned by the device, tenant-scoped. */
  listIdleNumbers(deviceId: string): Promise<readonly IdleNumberRow[]>;
  /** Catalog dimensions the tenant currently has an active offer for. */
  listActiveOfferDimensions(): Promise<readonly ActiveOfferDimension[]>;
  /** Apply a number status change and append its state-history row. */
  applyNumberStatus(change: NumberStatusChange): Promise<void>;
}

/**
 * Runs heartbeat work inside a single tenant-scoped transaction bound to a
 * validated {@link TenantContext} (task 7.1 unit of work).
 */
export interface HeartbeatGateway {
  runInTenant<T>(
    tenant: TenantContext,
    work: (tx: RecordHeartbeatTransaction) => Promise<T>,
  ): Promise<T>;
}

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Generates opaque identifiers (UUIDs) for heartbeat samples/history rows. */
export interface IdGenerator {
  uuid(): string;
}
