/**
 * Application-owned ports for tenant member management.
 *
 * The member-management service orchestrates the pure role/permission matrix
 * (task 5.1) and audit descriptors (task 5.7) over these ports; infrastructure
 * supplies the adapters (Prisma tenant-scoped repositories + unit of work from
 * task 7.1, Argon2id, crypto). Every mutating operation runs inside a single
 * tenant-scoped transaction so the member change and its audit event commit
 * atomically (requirements 4.4, 4.5). Raw Prisma never leaves the adapter.
 */
import type { AuditEventDescriptor } from "@domain/task-5-7";
import type { PartnerMemberRole } from "@domain/task-5-1/tenant-policy";
import type { PartnerMemberLoginStatus } from "@domain/task-7-2";
import type { TenantContext } from "@infrastructure/database";

export type MemberRole = PartnerMemberRole;
export type MemberStatus = PartnerMemberLoginStatus;

/** A safe, tenant-scoped view of a member (no credential material). */
export interface MemberView {
  readonly id: string;
  readonly partnerId: string;
  readonly emailNormalized: string;
  readonly role: MemberRole;
  readonly status: MemberStatus;
}

/** The row to insert when inviting a new member. */
export interface NewMemberRecord {
  readonly id: string;
  readonly emailNormalized: string;
  readonly role: MemberRole;
  /** Argon2id hash of an unguessable placeholder secret (see invite flow). */
  readonly passwordHash: string;
  readonly status: MemberStatus;
  readonly createdAtEpochMs: number;
}

/** Fields a member-management command may change on an existing member. */
export interface MemberChanges {
  readonly role?: MemberRole;
  readonly status?: MemberStatus;
}

/** An audit event to persist alongside a member mutation. */
export interface AuditWriteInput {
  readonly id: string;
  readonly partnerId: string;
  readonly requestId: string;
  readonly descriptor: AuditEventDescriptor;
}

/**
 * Operations available inside a tenant-scoped member-management transaction.
 * Reads/writes are folded with the tenant's `partnerId`; a cross-tenant id is
 * indistinguishable from a missing row (returns `null`).
 */
export interface MemberManagementTransaction {
  findById(id: string): Promise<MemberView | null>;
  /** Global email-uniqueness probe — emails are unique across all tenants. */
  emailExistsGlobally(emailNormalized: string): Promise<boolean>;
  createMember(record: NewMemberRecord): Promise<MemberView>;
  updateMember(id: string, changes: MemberChanges): Promise<MemberView>;
  recordAudit(input: AuditWriteInput): Promise<void>;
}

/**
 * Runs member-management work inside a single tenant-scoped transaction bound
 * to a validated {@link TenantContext} (task 7.1 unit of work).
 */
export interface MemberManagementGateway {
  runInTenant<T>(
    tenant: TenantContext,
    work: (tx: MemberManagementTransaction) => Promise<T>,
  ): Promise<T>;
}

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Generates opaque identifiers (UUIDs) for new members and audit events. */
export interface IdGenerator {
  uuid(): string;
}

/** Password hashing port (Argon2id in production). */
export interface MemberPasswordHasher {
  hash(password: string): Promise<string>;
}

/** Produces a high-entropy random secret for an invited member's placeholder. */
export interface SecretGenerator {
  generate(): string;
}
