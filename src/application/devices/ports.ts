/**
 * Application-owned ports for Device and agent-credential lifecycle (task 8.1).
 *
 * The device-management service orchestrates the pure simulator/capability
 * policy (task 5.7 — `decideDeviceCreation`, `declareCapabilities`) and audit
 * descriptors (task 5.7) over these ports; infrastructure supplies the adapters
 * (the task 7.1 Prisma tenant-scoped repositories + unit of work, and a crypto
 * agent-credential factory). Every mutating command runs inside a single
 * tenant-scoped transaction so the device/credential change and its audit event
 * commit atomically (requirements 5.1–5.6, 19.1). Raw Prisma never leaves the
 * adapter and the raw agent secret is only ever returned to the caller once.
 */
import type {
  AuditEventDescriptor,
  DeviceCapabilities,
  DeviceType,
} from "@domain/task-5-7";
import type { PartnerStatus } from "@domain/task-5-1/partner-status";
import type { TenantContext } from "@infrastructure/database";

export type { DeviceCapabilities, DeviceType };

/** Effective device status persisted on the device row. */
export type DeviceEffectiveStatus = "offline" | "online" | "disabled";

/** A safe, tenant-scoped view of a device (never any credential material). */
export interface DeviceView {
  readonly id: string;
  readonly partnerId: string;
  readonly type: DeviceType;
  readonly label: string;
  readonly effectiveStatus: DeviceEffectiveStatus;
  readonly disabledAtEpochMs: number | null;
  readonly lastSeenAtEpochMs: number | null;
  readonly agentVersion: string | null;
  readonly capabilities: DeviceCapabilities;
}

/** The row to insert when creating a device. */
export interface NewDeviceRecord {
  readonly id: string;
  readonly type: DeviceType;
  readonly label: string;
  readonly capabilities: DeviceCapabilities;
  readonly createdAtEpochMs: number;
}

/** Fields a status command may change on an existing device. */
export interface DeviceStatusChange {
  readonly effectiveStatus: DeviceEffectiveStatus;
  readonly disabledAtEpochMs: number | null;
}

/**
 * The row to insert for a device credential. Only the SHA-256 hash and the
 * public id are persisted — the raw 256-bit secret is never stored (task 8.1,
 * requirement 5.2).
 */
export interface NewCredentialRecord {
  readonly id: string;
  readonly deviceId: string;
  readonly publicId: string;
  readonly secretHash: string;
  readonly createdAtEpochMs: number;
}

/** A partner read used to gate device creation (requirement 5.1, 17.1). */
export interface PartnerGateView {
  readonly status: PartnerStatus;
  /** `partner.simulatorAllowed`, set by an admin for private-beta partners. */
  readonly simulatorAllowed: boolean;
}

/** An audit event to persist alongside a device/credential mutation. */
export interface AuditWriteInput {
  readonly id: string;
  readonly partnerId: string;
  readonly requestId: string;
  readonly descriptor: AuditEventDescriptor;
}

/**
 * Operations available inside a tenant-scoped device-management transaction.
 * Reads/writes are folded with the tenant's `partnerId`; a cross-tenant id is
 * indistinguishable from a missing row (returns `null`).
 */
export interface DeviceManagementTransaction {
  /** Read the caller's own partner gate (status + simulator allowlist flag). */
  loadPartnerGate(): Promise<PartnerGateView | null>;
  findDeviceById(id: string): Promise<DeviceView | null>;
  createDevice(record: NewDeviceRecord): Promise<DeviceView>;
  updateDeviceStatus(id: string, change: DeviceStatusChange): Promise<DeviceView>;
  createCredential(record: NewCredentialRecord): Promise<void>;
  /**
   * Immediately revoke every currently-active credential of a device. The MVP
   * grace period is zero, so a rotation/revocation invalidates the old hash at
   * once (design section 6). Returns the number of credentials revoked.
   */
  revokeActiveCredentials(deviceId: string, revokedAtEpochMs: number): Promise<number>;
  recordAudit(input: AuditWriteInput): Promise<void>;
}

/**
 * Runs device-management work inside a single tenant-scoped transaction bound
 * to a validated {@link TenantContext} (task 7.1 unit of work).
 */
export interface DeviceManagementGateway {
  runInTenant<T>(
    tenant: TenantContext,
    work: (tx: DeviceManagementTransaction) => Promise<T>,
  ): Promise<T>;
}

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Generates opaque identifiers (UUIDs) for new devices/credentials/audits. */
export interface IdGenerator {
  uuid(): string;
}

/** A freshly issued agent credential; the raw secret is shown exactly once. */
export interface IssuedAgentCredential {
  readonly publicId: string;
  /** The 256-bit agent secret, base64url-encoded. Never persisted. */
  readonly secret: string;
  /** SHA-256 hex of the peppered, per-device-salted secret (stored). */
  readonly secretHash: string;
}

/**
 * Issues one-time agent secrets and derives their stored hash. The hash is a
 * SHA-256 over the global credential pepper, a per-device 128-bit salt (the
 * device id), and the secret, so a leak of the credential table exposes no
 * usable secret (design section 6; requirement 5.2).
 */
export interface DeviceCredentialFactory {
  issue(deviceId: string): IssuedAgentCredential;
  hashSecret(deviceId: string, secret: string): string;
}
