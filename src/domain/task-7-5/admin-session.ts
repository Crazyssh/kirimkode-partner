/**
 * Pure session lifecycle policy for the Partner Admin realm (task 7.5).
 *
 * A Partner Admin session is the exact analogue of the tenant human session
 * (task 7.2): an opaque random 256-bit token whose SHA-256 hash alone is
 * persisted, with a sliding idle window and a hard absolute ceiling. It is kept
 * as a *separate* policy on purpose — an admin session is bound to an `adminId`
 * and carries no `partnerId`, so the two realms can never be confused. All
 * inputs are plain epoch-millisecond values so the rules are exhaustively
 * unit-testable without a clock, database, or crypto (design.md section 1:
 * "Partner Admin memakai akun/role global terpisah dan route `/admin`").
 */
import type { SessionTtlPolicy } from "@domain/task-7-2";

export type { SessionTtlPolicy };

export interface NewAdminSessionInput {
  readonly id: string;
  readonly adminId: string;
  readonly tokenHash: string;
  readonly securityVersion: number;
  readonly createdAtEpochMs: number;
  readonly ttl: SessionTtlPolicy;
}

/**
 * The persisted shape of an admin session. Epoch-millisecond fields keep the
 * domain free of `Date`/timezone concerns; the persistence adapter converts
 * to/from `Timestamptz`.
 */
export interface AdminSessionRecord {
  readonly id: string;
  readonly adminId: string;
  readonly tokenHash: string;
  readonly securityVersion: number;
  readonly createdAtEpochMs: number;
  /** Absolute expiry: createdAt + absoluteTtl. */
  readonly expiresAtEpochMs: number;
  /** Sliding idle expiry: min(lastUse + idleTtl, absolute expiry). */
  readonly idleExpiresAtEpochMs: number;
  readonly lastUsedAtEpochMs: number | null;
  readonly revokedAtEpochMs: number | null;
}

export type AdminSessionInactiveReason =
  | "revoked"
  | "absolute_expired"
  | "idle_expired"
  | "security_version_changed";

export type AdminSessionEvaluation =
  | {
      readonly active: true;
      /** New idle expiry to persist on this authenticated use. */
      readonly slideIdleExpiryToEpochMs: number;
    }
  | { readonly active: false; readonly reason: AdminSessionInactiveReason };

const SHA_256_HEX_PATTERN = /^[a-f\d]{64}$/iu;

function isValidEpoch(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertTtl(ttl: SessionTtlPolicy): void {
  if (
    !Number.isSafeInteger(ttl.idleTtlMs) ||
    ttl.idleTtlMs <= 0 ||
    !Number.isSafeInteger(ttl.absoluteTtlMs) ||
    ttl.absoluteTtlMs <= 0 ||
    ttl.idleTtlMs > ttl.absoluteTtlMs
  ) {
    throw new Error("INVALID_ADMIN_SESSION_TTL");
  }
}

/**
 * Build a fresh admin session record. The absolute expiry is fixed at creation;
 * the initial idle expiry is `min(created + idleTtl, absolute)` so the idle
 * window can never outlast the absolute ceiling.
 */
export function createAdminSessionRecord(
  input: NewAdminSessionInput,
): AdminSessionRecord {
  assertTtl(input.ttl);
  if (
    !input.id ||
    !input.adminId ||
    !SHA_256_HEX_PATTERN.test(input.tokenHash) ||
    !Number.isSafeInteger(input.securityVersion) ||
    input.securityVersion < 1 ||
    !isValidEpoch(input.createdAtEpochMs)
  ) {
    throw new Error("INVALID_ADMIN_SESSION_DESCRIPTOR");
  }

  const expiresAtEpochMs = input.createdAtEpochMs + input.ttl.absoluteTtlMs;
  const idleExpiresAtEpochMs = Math.min(
    input.createdAtEpochMs + input.ttl.idleTtlMs,
    expiresAtEpochMs,
  );

  return Object.freeze({
    id: input.id,
    adminId: input.adminId,
    tokenHash: input.tokenHash.toLowerCase(),
    securityVersion: input.securityVersion,
    createdAtEpochMs: input.createdAtEpochMs,
    expiresAtEpochMs,
    idleExpiresAtEpochMs,
    lastUsedAtEpochMs: null,
    revokedAtEpochMs: null,
  });
}

export interface EvaluateAdminSessionInput {
  readonly session: AdminSessionRecord;
  readonly nowEpochMs: number;
  /** The admin's current security version; a bump invalidates old sessions. */
  readonly currentSecurityVersion: number;
  readonly idleTtlMs: number;
}

/**
 * Decide whether a persisted admin session may authenticate a request `now`.
 *
 * Order of checks mirrors the tenant session policy: an explicit revocation
 * always wins, then the hard absolute ceiling, then the sliding idle window,
 * then a security-version bump (password change / forced logout). When active,
 * the caller is told the new idle expiry to persist, capped at the absolute
 * expiry so a session is never extended past its ceiling.
 */
export function evaluateAdminSession(
  input: EvaluateAdminSessionInput,
): AdminSessionEvaluation {
  const { session, nowEpochMs, currentSecurityVersion, idleTtlMs } = input;
  if (!isValidEpoch(nowEpochMs)) {
    throw new Error("INVALID_ADMIN_SESSION_TIME");
  }

  if (session.revokedAtEpochMs !== null) {
    return { active: false, reason: "revoked" };
  }
  if (nowEpochMs >= session.expiresAtEpochMs) {
    return { active: false, reason: "absolute_expired" };
  }
  if (nowEpochMs >= session.idleExpiresAtEpochMs) {
    return { active: false, reason: "idle_expired" };
  }
  if (session.securityVersion !== currentSecurityVersion) {
    return { active: false, reason: "security_version_changed" };
  }

  const slideIdleExpiryToEpochMs = Math.min(
    nowEpochMs + idleTtlMs,
    session.expiresAtEpochMs,
  );
  return { active: true, slideIdleExpiryToEpochMs };
}
