/**
 * Tenant member-management commands: invite, update, and revoke.
 *
 * These are the sensitive operations gated to the `owner` role by the pure
 * permission matrix (task 5.1, requirement 4.4). Each command re-checks the
 * permission itself (defense-in-depth: never rely solely on upstream
 * middleware), operates only within the caller's tenant scope (task 7.1 —
 * a cross-tenant target is indistinguishable from a missing one), and writes a
 * complete audit event in the same transaction as the mutation (task 5.7,
 * requirement 4.5). Every outcome is a tagged union so the transport layer maps
 * results to safe responses without relying on thrown control flow.
 */
import { normalizeEmail, validateEmail } from "@domain/task-5-1/identity";
import { createAuditEvent, type AuditEventDescriptor } from "@domain/task-5-7";

import { checkPermission, type SessionContext } from "../authorization/session-context";
import type {
  Clock,
  IdGenerator,
  MemberManagementGateway,
  MemberManagementTransaction,
  MemberPasswordHasher,
  MemberRole,
  MemberStatus,
  MemberView,
  SecretGenerator,
} from "./ports";

const VALID_ROLES: ReadonlySet<MemberRole> = new Set<MemberRole>(["owner", "member"]);
const VALID_STATUSES: ReadonlySet<MemberStatus> = new Set<MemberStatus>([
  "pending_verification",
  "active",
  "suspended",
  "disabled",
]);

/** Status a revoked member is moved to; disabled members cannot authenticate. */
const REVOKED_STATUS: MemberStatus = "disabled";

export interface InviteMemberInput {
  readonly caller: SessionContext;
  readonly email: string;
  readonly role: MemberRole;
  /** Request identity for the audit trail (uuid). */
  readonly requestId: string;
}

export interface UpdateMemberInput {
  readonly caller: SessionContext;
  readonly memberId: string;
  readonly role?: MemberRole;
  readonly status?: MemberStatus;
  readonly requestId: string;
}

export interface RevokeMemberInput {
  readonly caller: SessionContext;
  readonly memberId: string;
  readonly requestId: string;
}

export type MemberCommandOutcome =
  | { readonly ok: true; readonly member: MemberView }
  | { readonly ok: false; readonly reason: "forbidden" }
  | { readonly ok: false; readonly reason: "self_forbidden" }
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "email_taken" }
  | { readonly ok: false; readonly reason: "validation"; readonly code: string };

export interface MemberManagementServiceDeps {
  readonly gateway: MemberManagementGateway;
  readonly passwordHasher: MemberPasswordHasher;
  readonly secretGenerator: SecretGenerator;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export class MemberManagementService {
  private readonly deps: MemberManagementServiceDeps;

  constructor(deps: MemberManagementServiceDeps) {
    this.deps = deps;
  }

  /**
   * Invite a new member into the caller's tenant. Owner-only. Creates a
   * `pending_verification` member whose password is an unguessable placeholder
   * (the invitee sets a real password via the reset flow), enforcing global
   * email uniqueness inside the transaction.
   */
  async invite(input: InviteMemberInput): Promise<MemberCommandOutcome> {
    const denied = this.requireManageMembers(input.caller);
    if (denied) return denied;

    if (!VALID_ROLES.has(input.role)) {
      return { ok: false, reason: "validation", code: "INVALID_ROLE" };
    }
    const emailValidation = validateEmail(input.email);
    if (!emailValidation.valid) {
      return { ok: false, reason: "validation", code: emailValidation.code };
    }
    const emailNormalized = normalizeEmail(input.email);

    // Hash the placeholder secret outside the transaction to keep it short.
    const passwordHash = await this.deps.passwordHasher.hash(
      this.deps.secretGenerator.generate(),
    );

    return this.deps.gateway.runInTenant(input.caller.tenant, async (tx) => {
      if (await tx.emailExistsGlobally(emailNormalized)) {
        return { ok: false, reason: "email_taken" } as const;
      }

      const now = this.deps.clock.nowEpochMs();
      const member = await tx.createMember({
        id: this.deps.idGenerator.uuid(),
        emailNormalized,
        role: input.role,
        passwordHash,
        status: "pending_verification",
        createdAtEpochMs: now,
      });

      await this.writeAudit(tx, {
        caller: input.caller,
        requestId: input.requestId,
        occurredAtEpochMs: now,
        descriptor: createAuditEvent({
          actorType: "partner_member",
          actorRef: input.caller.principal.memberId,
          action: "member.invited",
          targetType: "partner_member",
          targetId: member.id,
          result: "success",
          occurredAtEpochMs: now,
          metadata: { role: member.role, status: member.status },
        }),
      });

      return { ok: true, member } as const;
    });
  }

  /**
   * Update an existing member's role and/or status. Owner-only. A member may
   * not change their own role/status through this command (prevents an owner
   * from accidentally locking themselves out).
   */
  async update(input: UpdateMemberInput): Promise<MemberCommandOutcome> {
    const denied = this.requireManageMembers(input.caller);
    if (denied) return denied;

    if (input.role === undefined && input.status === undefined) {
      return { ok: false, reason: "validation", code: "NO_CHANGES" };
    }
    if (input.role !== undefined && !VALID_ROLES.has(input.role)) {
      return { ok: false, reason: "validation", code: "INVALID_ROLE" };
    }
    if (input.status !== undefined && !VALID_STATUSES.has(input.status)) {
      return { ok: false, reason: "validation", code: "INVALID_STATUS" };
    }
    if (input.memberId === input.caller.principal.memberId) {
      return { ok: false, reason: "self_forbidden" };
    }

    return this.deps.gateway.runInTenant(input.caller.tenant, async (tx) => {
      const existing = await tx.findById(input.memberId);
      if (!existing) return { ok: false, reason: "not_found" } as const;

      const member = await tx.updateMember(input.memberId, {
        role: input.role,
        status: input.status,
      });

      const now = this.deps.clock.nowEpochMs();
      await this.writeAudit(tx, {
        caller: input.caller,
        requestId: input.requestId,
        occurredAtEpochMs: now,
        descriptor: createAuditEvent({
          actorType: "partner_member",
          actorRef: input.caller.principal.memberId,
          action: "member.role_changed",
          targetType: "partner_member",
          targetId: member.id,
          result: "success",
          occurredAtEpochMs: now,
          metadata: {
            previousRole: existing.role,
            nextRole: member.role,
            previousStatus: existing.status,
            nextStatus: member.status,
          },
        }),
      });

      return { ok: true, member } as const;
    });
  }

  /**
   * Revoke a member's access by disabling them. Owner-only. Disabling denies
   * the member any new session (task 7.2 evaluates status on every request), so
   * a revoked member is locked out without deleting audit/financial history. A
   * member cannot revoke themselves.
   */
  async revoke(input: RevokeMemberInput): Promise<MemberCommandOutcome> {
    const denied = this.requireManageMembers(input.caller);
    if (denied) return denied;

    if (input.memberId === input.caller.principal.memberId) {
      return { ok: false, reason: "self_forbidden" };
    }

    return this.deps.gateway.runInTenant(input.caller.tenant, async (tx) => {
      const existing = await tx.findById(input.memberId);
      if (!existing) return { ok: false, reason: "not_found" } as const;

      const member = await tx.updateMember(input.memberId, { status: REVOKED_STATUS });

      const now = this.deps.clock.nowEpochMs();
      await this.writeAudit(tx, {
        caller: input.caller,
        requestId: input.requestId,
        occurredAtEpochMs: now,
        descriptor: createAuditEvent({
          actorType: "partner_member",
          actorRef: input.caller.principal.memberId,
          action: "member.revoked",
          targetType: "partner_member",
          targetId: member.id,
          result: "success",
          occurredAtEpochMs: now,
          metadata: {
            previousStatus: existing.status,
            nextStatus: member.status,
            role: member.role,
          },
        }),
      });

      return { ok: true, member } as const;
    });
  }

  /** Owner-only gate for every member-management command (requirement 4.4). */
  private requireManageMembers(
    caller: SessionContext,
  ): { readonly ok: false; readonly reason: "forbidden" } | null {
    const permission = checkPermission(caller, "manage_members");
    return permission.allowed ? null : { ok: false, reason: "forbidden" };
  }

  private async writeAudit(
    tx: MemberManagementTransaction,
    args: {
      readonly caller: SessionContext;
      readonly requestId: string;
      readonly occurredAtEpochMs: number;
      readonly descriptor: AuditEventDescriptor;
    },
  ): Promise<void> {
    await tx.recordAudit({
      id: this.deps.idGenerator.uuid(),
      partnerId: args.caller.tenant.partnerId,
      requestId: args.requestId,
      descriptor: args.descriptor,
    });
  }
}
