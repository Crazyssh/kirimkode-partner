/**
 * Application-owned ports for human authentication.
 *
 * The auth services orchestrate the pure domain policies (session, login, rate
 * limit) against these ports; infrastructure supplies the adapters (Argon2id,
 * crypto tokens, Prisma-backed identity/session gateways, a rate-limit store).
 * Keeping the seams here lets the services be unit-tested with in-memory fakes
 * and keeps raw Prisma/crypto out of the transport layer.
 */
import type {
  AuthenticatedPrincipal,
  PartnerMemberLoginStatus,
  SessionRecord,
} from "@domain/task-7-2";
import type { RegistrationUnitOfWorkPort } from "@domain/task-5-1/registration";
import type { OneTimeTokenType } from "@domain/task-5-1/one-time-token";

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Generates opaque identifiers (UUIDs) for new aggregates and sessions. */
export interface IdGenerator {
  uuid(): string;
}

/**
 * Password hashing port. `hash` produces an Argon2id encoded string; `verify`
 * is constant-time and returns `false` (never throws) for malformed hashes so
 * it can be safely run against a decoy hash during anti-enumeration.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(encodedHash: string, password: string): Promise<boolean>;
  /**
   * A valid encoded hash of a throwaway secret. Login verifies against this
   * when no account matches so a missing email and a wrong password cost the
   * same time, denying timing-based user enumeration.
   */
  readonly decoyHash: string;
}

/** Issues opaque session tokens and derives their stored SHA-256 hash. */
export interface SessionTokenIssuer {
  /** Create a fresh 256-bit token and its hash for persistence. */
  issue(): { readonly token: string; readonly tokenHash: string };
  /** Derive the stored hash for a token presented by a client. */
  hashToken(token: string): string;
}

/** The credential-bearing view of a member used to evaluate a login. */
export interface MemberAuthRecord {
  readonly memberId: string;
  readonly partnerId: string;
  readonly role: "owner" | "member";
  readonly passwordHash: string;
  readonly securityVersion: number;
  readonly status: PartnerMemberLoginStatus;
}

/**
 * Non-tenant-scoped identity gateway. These operations run *before* a tenant
 * context exists (registration creates it; login resolves it), so they cannot
 * use the tenant-scoped repositories. The adapter still encapsulates Prisma.
 */
export interface AuthIdentityGateway extends RegistrationUnitOfWorkPort {
  /** Look up a member by its already-normalized email, or `null`. */
  findMemberByEmail(emailNormalized: string): Promise<MemberAuthRecord | null>;
}

/** The joined session + member view needed to authenticate a request. */
export interface SessionAuthContext {
  readonly session: SessionRecord;
  /** The member's *current* security version (for invalidation on bump). */
  readonly currentSecurityVersion: number;
  readonly role: "owner" | "member";
  readonly status: PartnerMemberLoginStatus;
}

/** Persistence port for sessions, keyed by the opaque token hash. */
export interface SessionGateway {
  create(session: SessionRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<SessionAuthContext | null>;
  slideIdleExpiry(
    tokenHash: string,
    idleExpiresAtEpochMs: number,
    lastUsedAtEpochMs: number,
  ): Promise<void>;
  /** Idempotently revoke a session; a missing/already-revoked token is a no-op. */
  revokeByTokenHash(tokenHash: string, revokedAtEpochMs: number): Promise<void>;
}

/**
 * Issues opaque one-time tokens (email verification, password reset) and
 * derives their stored SHA-256 hash. Shape mirrors {@link SessionTokenIssuer}
 * but is kept as a distinct port so the two concerns can evolve independently.
 * The raw token is 256-bit CSPRNG output shown once (embedded in the emailed
 * link); only its lowercase-hex SHA-256 hash is persisted (design.md section 1,
 * requirement 19.6).
 */
export interface OneTimeTokenIssuer {
  /** Create a fresh 256-bit token and its stored hash. */
  issue(): { readonly token: string; readonly tokenHash: string };
  /** Derive the stored hash for a token presented by a client. */
  hashToken(token: string): string;
}

/** A one-time token row as loaded from persistence for consumption. */
export interface StoredOneTimeToken {
  readonly id: string;
  readonly memberId: string;
  readonly partnerId: string;
  readonly type: OneTimeTokenType;
  readonly tokenHash: string;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  readonly usedAtEpochMs: number | null;
}

/** The token to persist when issuing a fresh verification/reset token. */
export interface OneTimeTokenIssuance {
  readonly id: string;
  readonly memberId: string;
  readonly partnerId: string;
  readonly type: OneTimeTokenType;
  readonly tokenHash: string;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

/**
 * Persistence port for one-time tokens plus the effects their consumption
 * applies. Consumption effects run in the same transaction as the single-use
 * guard so a token can never be redeemed twice or leave a half-applied effect.
 * Not tenant-scoped: verification/reset run before a session (and its
 * `TenantContext`) exists. Raw Prisma stays inside the adapter.
 */
export interface OneTimeTokenGateway {
  /**
   * Atomically invalidate every outstanding unused token of the same type for
   * the member (marking them used at `invalidatedAtEpochMs`) and insert the new
   * token. Issuing a fresh token therefore always retires older ones.
   */
  issue(issuance: OneTimeTokenIssuance, invalidatedAtEpochMs: number): Promise<void>;
  /** Load a token by its stored hash, or `null` when unknown. */
  findByTokenHash(tokenHash: string): Promise<StoredOneTimeToken | null>;
  /**
   * Mark the token used (only if still unused) and set the member's email as
   * verified/active in one transaction. Returns `false` when the single-use
   * guard loses the race (the token was already consumed).
   */
  applyEmailVerification(
    tokenId: string,
    memberId: string,
    partnerId: string,
    usedAtEpochMs: number,
  ): Promise<boolean>;
  /**
   * Mark the token used (only if still unused), replace the member password
   * hash, and bump the member's security version (revoking existing sessions)
   * in one transaction. Returns `false` when the token was already consumed.
   */
  applyPasswordReset(
    tokenId: string,
    memberId: string,
    partnerId: string,
    usedAtEpochMs: number,
    newPasswordHash: string,
  ): Promise<boolean>;
}

/** A transactional email to deliver via the SMTP adapter. */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

/** Outbound email port; the SMTP adapter implements it in infrastructure. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Best-effort keyed counter store for rate limiting. */
export interface RateLimitStore {
  get(key: string): Promise<import("@domain/task-7-2").WindowCounter | undefined>;
  set(
    key: string,
    counter: import("@domain/task-7-2").WindowCounter,
    expiresAtEpochMs: number,
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

export type { AuthenticatedPrincipal };
