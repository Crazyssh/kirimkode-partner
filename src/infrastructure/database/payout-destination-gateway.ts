import { $Enums } from "@/generated/prisma";

import type {
  AuditWriteInput,
  NewPayoutDestination,
  PayoutDestinationGateway,
  PayoutDestinationTransaction,
  PayoutDestinationView,
} from "@application/payouts/ports";

import { PrismaAuditEventRepository } from "./audit-event-repository";
import type { PartnerTransactionClient } from "./client";
import type { TenantContext } from "./tenant-context";
import type { UnitOfWork } from "./unit-of-work";

/**
 * Prisma-backed {@link PayoutDestinationTransaction} bound to a single
 * transaction client and tenant (task 14.3).
 *
 * Creating a payout destination stores ONLY the encrypted account-number
 * envelope, its key version, and `accountNumberLast4` — the raw account number
 * is never persisted or logged in the clear (requirement 23.3). The insert and
 * its audit event commit atomically inside the tenant-scoped unit-of-work
 * transaction (requirement 14.7). The tenant's `partnerId` is folded into every
 * write (task 7.1), so a destination can never be created under another tenant.
 * Raw Prisma never leaves this adapter.
 */
class PrismaPayoutDestinationTransaction implements PayoutDestinationTransaction {
  private readonly tx: PartnerTransactionClient;
  private readonly tenant: TenantContext;
  private readonly audit: PrismaAuditEventRepository;

  constructor(tx: PartnerTransactionClient, tenant: TenantContext) {
    this.tx = tx;
    this.tenant = tenant;
    this.audit = new PrismaAuditEventRepository(tx);
  }

  async insertDestination(
    record: NewPayoutDestination,
  ): Promise<PayoutDestinationView> {
    const created = await this.tx.payoutDestination.create({
      data: {
        id: record.id,
        partnerId: this.tenant.partnerId,
        bankCode: record.bankCode,
        accountNumberCiphertext: Buffer.from(record.accountNumberCiphertext),
        keyVersion: record.keyVersion,
        accountNumberLast4: record.accountNumberLast4,
        accountHolderName: record.accountHolderName,
        status: $Enums.PayoutDestinationStatus.ACTIVE,
        createdAt: new Date(record.createdAtEpochMs),
      },
      select: {
        id: true,
        partnerId: true,
        bankCode: true,
        accountNumberLast4: true,
        accountHolderName: true,
        status: true,
      },
    });
    return {
      id: created.id,
      partnerId: created.partnerId,
      bankCode: created.bankCode,
      accountNumberLast4: created.accountNumberLast4,
      accountHolderName: created.accountHolderName,
      status: created.status === $Enums.PayoutDestinationStatus.ACTIVE ? "active" : "disabled",
    };
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
 * {@link PayoutDestinationGateway} port. The destination insert and its audit
 * event run in one tenant-scoped transaction.
 */
export class PrismaPayoutDestinationGateway implements PayoutDestinationGateway {
  private readonly unitOfWork: UnitOfWork;

  constructor(unitOfWork: UnitOfWork) {
    this.unitOfWork = unitOfWork;
  }

  runInTenant<T>(
    tenant: TenantContext,
    work: (tx: PayoutDestinationTransaction) => Promise<T>,
  ): Promise<T> {
    return this.unitOfWork.run(tenant, ({ tx, tenant: scopedTenant }) =>
      work(new PrismaPayoutDestinationTransaction(tx, scopedTenant)),
    );
  }
}
