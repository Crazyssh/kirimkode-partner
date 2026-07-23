import { $Enums, type PartnerMember } from "@/generated/prisma";

import type {
  AuditWriteInput,
  MemberChanges,
  MemberManagementGateway,
  MemberManagementTransaction,
  MemberRole,
  MemberStatus,
  MemberView,
  NewMemberRecord,
} from "@application/members/ports";

import type { PartnerTransactionClient } from "./client";
import { PrismaAuditEventRepository } from "./audit-event-repository";
import { PartnerMemberRepository } from "./partner-member-repository";
import type { TenantContext } from "./tenant-context";
import type { UnitOfWork } from "./unit-of-work";

const ROLE_TO_DB: Readonly<Record<MemberRole, $Enums.PartnerMemberRole>> = {
  owner: $Enums.PartnerMemberRole.OWNER,
  member: $Enums.PartnerMemberRole.MEMBER,
};

const ROLE_FROM_DB: Readonly<Record<$Enums.PartnerMemberRole, MemberRole>> = {
  OWNER: "owner",
  MEMBER: "member",
};

const STATUS_TO_DB: Readonly<Record<MemberStatus, $Enums.PartnerMemberStatus>> = {
  pending_verification: $Enums.PartnerMemberStatus.PENDING_VERIFICATION,
  active: $Enums.PartnerMemberStatus.ACTIVE,
  suspended: $Enums.PartnerMemberStatus.SUSPENDED,
  disabled: $Enums.PartnerMemberStatus.DISABLED,
};

const STATUS_FROM_DB: Readonly<Record<$Enums.PartnerMemberStatus, MemberStatus>> = {
  PENDING_VERIFICATION: "pending_verification",
  ACTIVE: "active",
  SUSPENDED: "suspended",
  DISABLED: "disabled",
};

function toMemberView(member: PartnerMember): MemberView {
  return {
    id: member.id,
    partnerId: member.partnerId,
    emailNormalized: member.emailNormalized,
    role: ROLE_FROM_DB[member.role],
    status: STATUS_FROM_DB[member.status],
  };
}

/**
 * Prisma-backed {@link MemberManagementTransaction} bound to a single
 * transaction client and tenant. Tenant-scoped reads/writes go through the
 * task 7.1 {@link PartnerMemberRepository} (so `partnerId` isolation and
 * cross-tenant→not-found are enforced uniformly); the global email probe and
 * the audit insert use the same transaction client so everything commits
 * atomically.
 */
class PrismaMemberManagementTransaction implements MemberManagementTransaction {
  private readonly members: PartnerMemberRepository;
  private readonly audit: PrismaAuditEventRepository;
  private readonly tx: PartnerTransactionClient;

  constructor(tx: PartnerTransactionClient, tenant: TenantContext) {
    this.tx = tx;
    this.members = new PartnerMemberRepository(tx, tenant);
    this.audit = new PrismaAuditEventRepository(tx);
  }

  async findById(id: string): Promise<MemberView | null> {
    const member = await this.members.findById(id);
    return member ? toMemberView(member) : null;
  }

  async emailExistsGlobally(emailNormalized: string): Promise<boolean> {
    const existing = await this.tx.partnerMember.findUnique({
      where: { emailNormalized },
      select: { id: true },
    });
    return existing !== null;
  }

  async createMember(record: NewMemberRecord): Promise<MemberView> {
    const created = await this.members.create({
      id: record.id,
      emailNormalized: record.emailNormalized,
      passwordHash: record.passwordHash,
      role: ROLE_TO_DB[record.role],
      status: STATUS_TO_DB[record.status],
    });
    return toMemberView(created);
  }

  async updateMember(id: string, changes: MemberChanges): Promise<MemberView> {
    const updated = await this.members.update(id, {
      role: changes.role === undefined ? undefined : ROLE_TO_DB[changes.role],
      status: changes.status === undefined ? undefined : STATUS_TO_DB[changes.status],
    });
    return toMemberView(updated);
  }

  async recordAudit(input: AuditWriteInput): Promise<void> {
    await this.audit.record({
      id: input.id,
      partnerId: input.partnerId,
      requestId: input.requestId,
      descriptor: input.descriptor,
    });
  }
}

/**
 * Composes the task 7.1 unit of work into the application's
 * {@link MemberManagementGateway} port. All member mutations plus their audit
 * events run in one tenant-scoped transaction.
 */
export class PrismaMemberManagementGateway implements MemberManagementGateway {
  private readonly unitOfWork: UnitOfWork;

  constructor(unitOfWork: UnitOfWork) {
    this.unitOfWork = unitOfWork;
  }

  runInTenant<T>(
    tenant: TenantContext,
    work: (tx: MemberManagementTransaction) => Promise<T>,
  ): Promise<T> {
    return this.unitOfWork.run(tenant, ({ tx, tenant: scopedTenant }) =>
      work(new PrismaMemberManagementTransaction(tx, scopedTenant)),
    );
  }
}
