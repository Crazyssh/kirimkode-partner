/**
 * Application-owned ports for the Agent API v1 request authenticator (task 11.1).
 *
 * The authenticator orchestrates the pure task 11.1 / task 5.3 credential +
 * replay domain over these seams; infrastructure supplies the adapters (the
 * task 8.1 `CryptoDeviceCredentialFactory` for constant-time secret hashing, a
 * Prisma-backed device-credential lookup that joins device + partner status,
 * the shared `ReplayNonce` gateway, and a process-local rate-limit store).
 * Keeping the seams here lets the guard be unit-tested with in-memory fakes and
 * keeps raw Prisma and node crypto out of the transport layer.
 */
import type { WindowCounter, WindowDecision, WindowRule } from "@domain/task-7-2";
import type { PartnerStatus } from "@domain/task-5-1/partner-status";

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Lifecycle status of a device credential (mirrors the persisted enum). */
export type DeviceCredentialStatus = "active" | "superseded" | "revoked";

/** Effective device status (mirrors the persisted enum). */
export type DeviceEffectiveStatus = "offline" | "online" | "disabled";

/**
 * The joined view the authenticator needs to authenticate a device request: the
 * credential's stored hash + status, the owning device id (which doubles as the
 * per-device salt, task 8.1) and its effective status, and the owning partner's
 * id + lifecycle status. A single lookup keyed on the credential public id lets
 * the guard verify the secret and enforce the Partner/Device fail-closed gates
 * without a second round-trip.
 */
export interface AgentDeviceAuthRecord {
  readonly publicId: string;
  /** SHA-256 hex of the peppered, per-device-salted secret (never the secret). */
  readonly secretHash: string;
  readonly deviceId: string;
  readonly partnerId: string;
  readonly credentialStatus: DeviceCredentialStatus;
  readonly deviceStatus: DeviceEffectiveStatus;
  readonly partnerStatus: PartnerStatus;
}

/**
 * Read port for device credentials, keyed on the credential public id. The
 * lookup is *not* tenant-scoped: the authenticator's job is to resolve which
 * tenant (partner) a caller belongs to, so it cannot yet hold a
 * `TenantContext`. A missing/rotated credential must not authenticate a request
 * (requirement 5.5). Raw Prisma never leaves the adapter.
 */
export interface AgentDeviceCredentialGateway {
  findByPublicId(publicId: string): Promise<AgentDeviceAuthRecord | null>;
}

/**
 * Constant-time device-secret verifier. Recomputes the stored hash from the
 * process-wide pepper, the per-device salt (device id), and the candidate
 * secret, and compares it to the stored hash in constant time (task 8.1;
 * design section 6). Satisfied structurally by `CryptoDeviceCredentialFactory`.
 */
export interface DeviceSecretVerifier {
  verifySecret(deviceId: string, secret: string, storedHash: string): boolean;
}

/**
 * Anti-replay nonce registry. Registration is a single atomic insert keyed by
 * `(principalId, nonce)`; the unique constraint makes a concurrent replay lose
 * the race. Returns `true` when the nonce was freshly registered and `false`
 * when it already existed (a replay). The adapter hashes the nonce before
 * persisting so the raw value never lands in a table. Shared with the Internal
 * API (task 9.1) — same `ReplayNonce` table, namespaced by principal.
 */
export interface ReplayNonceRegistry {
  registerNonce(
    principalId: string,
    nonce: string,
    expiresAtEpochMs: number,
  ): Promise<boolean>;
}

/**
 * Best-effort keyed counter store for rate limiting, shared with the auth and
 * Internal API modules. Rate limiting is abuse mitigation, not financial truth,
 * so a process-local implementation is acceptable for the MVP.
 */
export interface RateLimitStore {
  get(key: string): Promise<WindowCounter | undefined>;
  set(key: string, counter: WindowCounter, expiresAtEpochMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export type { WindowCounter, WindowDecision, WindowRule };
