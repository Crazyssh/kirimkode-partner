/**
 * Application-owned ports for the Partner Admin realm (task 7.5).
 *
 * The admin services orchestrate the pure admin-realm policies (task 7.5) and
 * the partner status state machine (task 5.1) over these ports; infrastructure
 * supplies the adapters (Argon2id, crypto session tokens, Prisma admin
 * identity/session gateways, and a partner lifecycle gateway built on the task
 * 7.1 unit of work). Keeping the seams here lets the services be unit-tested
 * with in-memory fakes and keeps raw Prisma/crypto out of the transport layer.
 */
import type { AuditEventDescriptor } from "@domain/task-5-7";
import type { PartnerStatus } from "@domain/task-5-1/partner-status";
import type {
  AdminSessionRecord,
  PartnerAdminLoginStatus,
} from "@domain/task-7-5";

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Generates opaque identifiers (UUIDs) for new sessions and audit events. */
export interface IdGenerator {
  uuid(): string;
}

/**
 * Password hashing port. `hash` produces an Argon2id encoded string; `verify`
 * is constant-time and returns `false` (never throws) for malformed hashes so
 * it can be safely run against a decoy hash during anti-enumeration.
 */
export interface AdminPasswordHasher {
  verify(encodedHash: string, password: string): Promise<boolean>;
  /**
   * A valid encoded hash of a throwaway secret. Login verifies against this
   * when no admin matches so a missing email and a wrong password cost the same
   * time, denying timing-based user enumeration.
   */
  readonly decoyHash: string;
}

/** Issues opaque admin session tokens and derives their stored SHA-256 hash. */
export interface AdminSessionTokenIssuer {
  issue(): { readonly token: string; readonly tokenHash: string };
  hashToken(token: string): string;
}

/** The credential-bearing view of an admin used to evaluate a login. */
export interface AdminAuthRecord {
  readonly adminId: string;
  readonly passwordHash: string;
  readonly permissions: readonly string[];
  readonly securityVersion: number;
  readonly status: PartnerAdminLoginStatus;
}

/**
 * Non-tenant-scoped admin identity gateway. Admins live in a global realm with
 * no `partnerId`, so this cannot use the tenant-scoped repositories. The
 * adapter still fully encapsulates Prisma.
 */
export interface AdminIdentityGateway {
  findAdminByEmail(emailNormalized: string): Promise<AdminAuthRecord | null>;
  /**
   * Resolve an admin by its opaque id for a step-up re-authentication (task
   * 15.4). The session already proves who the admin is; re-auth only needs to
   * verify their current password against the stored hash, so this returns the
   * same credential-bearing view keyed by id. Returns `null` for an unknown id.
   */
  findAdminById(adminId: string): Promise<AdminAuthRecord | null>;
}

/** The joined admin-session + admin view needed to authenticate a request. */
export interface AdminSessionAuthContext {
  readonly session: AdminSessionRecord;
  /** The admin's *current* security version (for invalidation on bump). */
  readonly currentSecurityVersion: number;
  readonly permissions: readonly string[];
  readonly status: PartnerAdminLoginStatus;
}

/** Persistence port for admin sessions, keyed by the opaque token hash. */
export interface AdminSessionGateway {
  create(session: AdminSessionRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<AdminSessionAuthContext | null>;
  slideIdleExpiry(
    tokenHash: string,
    idleExpiresAtEpochMs: number,
    lastUsedAtEpochMs: number,
  ): Promise<void>;
  /** Idempotently revoke a session; a missing/already-revoked token is a no-op. */
  revokeByTokenHash(tokenHash: string, revokedAtEpochMs: number): Promise<void>;
}

/** A read of a partner's current lifecycle status. */
export interface PartnerStatusView {
  readonly partnerId: string;
  readonly status: PartnerStatus;
}

/** An audit event to persist alongside a partner status change. */
export interface AdminAuditWriteInput {
  readonly id: string;
  readonly partnerId: string;
  readonly requestId: string;
  readonly descriptor: AuditEventDescriptor;
}

/**
 * Operations available inside a single partner-lifecycle transaction. The
 * status read, the compare-and-set update, and the audit insert all run in one
 * transaction so a status change and its audit event commit atomically
 * (requirement 3.5). The CAS update never touches orders, numbers, or ledger —
 * a suspend only changes the partner's status, so terminal order results are
 * left intact (requirement 3.4).
 */
export interface PartnerLifecycleTransaction {
  loadStatus(partnerId: string): Promise<PartnerStatusView | null>;
  /**
   * Compare-and-set the partner status: update only when the row still holds
   * `expectedStatus`. Returns `true` when exactly one row changed, `false` on a
   * lost race (the status moved underneath us). `approvedAt` is stamped when the
   * partner becomes `approved`.
   */
  updateStatus(input: {
    readonly partnerId: string;
    readonly expectedStatus: PartnerStatus;
    readonly nextStatus: PartnerStatus;
    readonly reason: string;
    readonly nowEpochMs: number;
  }): Promise<boolean>;
  recordAudit(input: AdminAuditWriteInput): Promise<void>;
}

/** Runs partner-lifecycle work inside a single transaction. */
export interface PartnerLifecycleGateway {
  runForPartner<T>(
    partnerId: string,
    work: (tx: PartnerLifecycleTransaction) => Promise<T>,
  ): Promise<T>;
}
