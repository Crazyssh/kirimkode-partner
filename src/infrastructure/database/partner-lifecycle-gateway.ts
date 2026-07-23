import { $Enums } from "@/generated/prisma";

import type {
  AdminAuditWriteInput,
  PartnerLifecycleGateway,
  PartnerLifecycleTransaction,
  PartnerStatusView,
} from "@application/admin/ports";
import type { PartnerStatus } from "@domain/task-5-1/partner-status";

import type { PartnerTransactionClient } from "./client";
import { PrismaAuditEventRepository } from "./audit-event-repository";
import { createTenantContext } from "./tenant-context";
import type { UnitOfWork } from "./unit-of-work";

const STATUS_TO_DB: Readonly<Record<PartnerStatus, $Enums.PartnerStatus>> = {
  pending: $Enums.PartnerStatus.PENDING,
  approved: $Enums.PartnerStatus.APPROVED,
  suspended: $Enums.PartnerStatus.SUSPENDED,
  rejected: $Enums.PartnerStatus.REJECTED,
};

const STATUS_FROM_DB: Readonly<Record<$Enums.PartnerStatus, PartnerStatus>> = {
  PENDING: "pending",
  APPROVED: "approved",
  SUSPENDED: "suspended",
  REJECTED: "rejected",
};

/**
 * Prisma-backed {@link PartnerLifecycleTransaction} bound to a single
 * transaction client. The status read, the compare-and-set update, and the
 * audit insert all use the same transaction client so a partner status change
 * and its audit event commit atomically (requirement 3.5). The update only ever
 * touches the `partners` row — never orders, numbers, or ledger — so a suspend
 * leaves terminal order results intact (requirement 3.4).
 */
class PrismaPartnerLifecycleTransaction implements PartnerLifecycleTransaction {
  private readonly tx: PartnerTransactionClient;
  private readonly audit: PrismaAuditEventRepository;

  constructor(tx: PartnerTransactionClient) {
    this.tx = tx;
    this.audit = new PrismaAuditEventRepository(tx);
  }

  async loadStatus(partnerId: string): Promise<PartnerStatusView | null> {
    const partner = await this.tx.partner.findUnique({
      where: { id: partnerId },
      select: { id: true, status: true },
    });
    if (partner === null) return null;
    return { partnerId: partner.id, status: STATUS_FROM_DB[partner.status] };
  }

  async updateStatus(input: {
    readonly partnerId: string;
    readonly expectedStatus: PartnerStatus;
    readonly nextStatus: PartnerStatus;
    readonly reason: string;
    readonly nowEpochMs: number;
  }): Promise<boolean> {
    const result = await this.tx.partner.updateMany({
      // Compare-and-set: only mutate while the row still holds the status we
      // read, so a concurrent change loses the race instead of double-applying.
      where: { id: input.partnerId, status: STATUS_TO_DB[input.expectedStatus] },
      data: {
        status: STATUS_TO_DB[input.nextStatus],
        statusReason: input.reason,
        ...(input.nextStatus === "approved"
          ? { approvedAt: new Date(input.nowEpochMs) }
          : {}),
      },
    });
    return result.count === 1;
  }

  async recordAudit(input: AdminAuditWriteInput): Promise<void> {
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
 * {@link PartnerLifecycleGateway} port. The transaction is scoped to the target
 * partner's own id (the admin acts on that partner), keeping every write inside
 * one atomic, validated scope.
 */
export class PrismaPartnerLifecycleGateway implements PartnerLifecycleGateway {
  private readonly unitOfWork: UnitOfWork;

  constructor(unitOfWork: UnitOfWork) {
    this.unitOfWork = unitOfWork;
  }

  runForPartner<T>(
    partnerId: string,
    work: (tx: PartnerLifecycleTransaction) => Promise<T>,
  ): Promise<T> {
    return this.unitOfWork.run(createTenantContext(partnerId), ({ tx }) =>
      work(new PrismaPartnerLifecycleTransaction(tx)),
    );
  }
}
