import type { $Enums, PartnerMember, Prisma } from "@/generated/prisma";

import type { PartnerDatabaseExecutor } from "./client";
import { ResourceNotFoundError } from "./repository-errors";
import type { TenantContext } from "./tenant-context";
import { TenantScopedRepository } from "./tenant-repository";
import {
  assertAffectedExactlyOne,
  scopedIdWhere,
  scopedWhere,
} from "./tenant-scoping";

/** Fields a caller may change on a member; `partnerId`/`id` stay controlled. */
export interface PartnerMemberMutation {
  readonly role?: $Enums.PartnerMemberRole;
  readonly status?: $Enums.PartnerMemberStatus;
  readonly emailVerifiedAt?: Date | null;
  readonly passwordHash?: string;
  readonly securityVersion?: number;
}

/**
 * Tenant-scoped repository for `PartnerMember`. Demonstrates tenant isolation
 * on an aggregate without optimistic-concurrency versioning: reads and writes
 * are always folded with the tenant's `partnerId`, and a cross-tenant id is
 * indistinguishable from a missing row (RESOURCE_NOT_FOUND).
 */
export class PartnerMemberRepository extends TenantScopedRepository {
  constructor(executor: PartnerDatabaseExecutor, tenant: TenantContext) {
    super(executor, tenant);
  }

  async findById(id: string): Promise<PartnerMember | null> {
    return this.executor.partnerMember.findFirst({
      where: scopedIdWhere(this.tenant, id),
    });
  }

  async requireById(id: string): Promise<PartnerMember> {
    const member = await this.findById(id);
    if (!member) throw new ResourceNotFoundError();
    return member;
  }

  async listByRole(role: $Enums.PartnerMemberRole): Promise<PartnerMember[]> {
    return this.executor.partnerMember.findMany({
      where: scopedWhere(this.tenant, { role }),
      orderBy: { createdAt: "asc" },
    });
  }

  async create(
    data: Omit<Prisma.PartnerMemberUncheckedCreateInput, "partnerId">,
  ): Promise<PartnerMember> {
    return this.executor.partnerMember.create({
      data: { ...data, partnerId: this.tenant.partnerId },
    });
  }

  /**
   * Apply a scoped update. Because the predicate carries `partnerId`, a
   * cross-tenant or missing id affects zero rows and surfaces as
   * RESOURCE_NOT_FOUND rather than silently editing another tenant's member.
   */
  async update(id: string, mutation: PartnerMemberMutation): Promise<PartnerMember> {
    const { count } = await this.executor.partnerMember.updateMany({
      where: scopedIdWhere(this.tenant, id),
      data: { ...mutation },
    });
    assertAffectedExactlyOne(count, { compareAndSet: false });
    return this.requireById(id);
  }
}
