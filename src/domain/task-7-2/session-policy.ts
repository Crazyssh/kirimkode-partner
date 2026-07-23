/**
 * Pure session lifecycle policy for human (portal/admin) sessions.
 *
 * A session is an opaque random 256-bit token; only its SHA-256 hash is
 * persisted. This module owns the *time and version* rules around a session and
 * nothing else: computing a new session's expiries, deciding whether a stored
 * session is still active, and sliding the idle window forward on use. All
 * inputs are plain values (epoch milliseconds) so the rules are exhaustively
 * unit-testable without a clock, database, or crypto (design.md section 1:
 * "idle TTL 12 jam dan absolute TTL 7 hari", "Session memuat ... security
 * version").
 */

/** Idle and absolute time-to-live for a session, in milliseconds. */
export interface SessionTtlPolicy {
  /** Sliding idle window; refreshed on each authenticated use. */
  readonly idleTtlMs: number;
  /** Hard ceiling from creation; never extended by activity. */
  readonly absoluteTtlMs: number;
}

export interface NewSessionInput {
  readonly id: string;
  readonly memberId: string;
  readonly partnerId: string;
  readonly tokenHash: string;
  readonly securityVersion: number;
  readonly createdAtEpochMs: number;
  readonly ttl: SessionTtlPolicy;
}

/**
 * The persisted shape of a session. Epoch-millisecond fields keep the domain
 * free of `Date`/timezone concerns; the persistence adapter converts to/from
 * `Timestamptz`.
 */
export interface SessionRecord {
  readonly id: string;
  readonly memberId: string;
  readonly partnerId: string;
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

export type SessionInactiveReason =
  | "revoked"
  | "absolute_expired"
  | "idle_expired"
  | "security_version_changed";

export type SessionEvaluation =
  | {
      readonly active: true;
      /** Present when the idle window should be slid forward on this use. */
      readonly slideIdleExpiryToEpochMs: number;
    }
  | { readonly active: false; readonly reason: SessionInactiveReason };

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
    throw new Error("INVALID_SESSION_TTL");
  }
}

/**
 * Build a fresh session record. The absolute expiry is fixed at creation; the
 * initial idle expiry is `min(created + idleTtl, absolute)` so the idle window
 * can never outlast the absolute ceiling.
 */
export function createSessionRecord(input: NewSessionInput): SessionRecord {
  assertTtl(input.ttl);
  if (
    !input.id ||
    !input.memberId ||
    !input.partnerId ||
    !SHA_256_HEX_PATTERN.test(input.tokenHash) ||
    !Number.isSafeInteger(input.securityVersion) ||
    input.securityVersion < 1 ||
    !isValidEpoch(input.createdAtEpochMs)
  ) {
    throw new Error("INVALID_SESSION_DESCRIPTOR");
  }

  const expiresAtEpochMs = input.createdAtEpochMs + input.ttl.absoluteTtlMs;
  const idleExpiresAtEpochMs = Math.min(
    input.createdAtEpochMs + input.ttl.idleTtlMs,
    expiresAtEpochMs,
  );

  return Object.freeze({
    id: input.id,
    memberId: input.memberId,
    partnerId: input.partnerId,
    tokenHash: input.tokenHash.toLowerCase(),
    securityVersion: input.securityVersion,
    createdAtEpochMs: input.createdAtEpochMs,
    expiresAtEpochMs,
    idleExpiresAtEpochMs,
    lastUsedAtEpochMs: null,
    revokedAtEpochMs: null,
  });
}

export interface EvaluateSessionInput {
  readonly session: SessionRecord;
  readonly nowEpochMs: number;
  /** The member's current security version; a bump invalidates old sessions. */
  readonly currentSecurityVersion: number;
  readonly idleTtlMs: number;
}

/**
 * Decide whether a persisted session may authenticate a request `now`.
 *
 * Order of checks is deliberate: an explicit revocation always wins, then the
 * hard absolute ceiling, then the sliding idle window, then a security-version
 * bump (password change / forced logout). When active, the caller is told the
 * new idle expiry to persist, capped at the absolute expiry so a session is
 * never extended past its ceiling.
 */
export function evaluateSession(input: EvaluateSessionInput): SessionEvaluation {
  const { session, nowEpochMs, currentSecurityVersion, idleTtlMs } = input;
  if (!isValidEpoch(nowEpochMs)) {
    throw new Error("INVALID_SESSION_TIME");
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
