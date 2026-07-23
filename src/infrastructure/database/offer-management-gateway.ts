import { $Enums, Prisma, type PartnerOffer } from "@/generated/prisma";

import {
  ActiveOfferConflictError,
  OfferInUseError,
  type AuditWriteInput,
  type NewOfferRecord,
  type OfferManagementGateway,
  type OfferManagementTransaction,
  type OfferMutation,
  type OfferRecord,
  type PlatformConfigSnapshot,
} from "@application/offers/ports";
import type { OfferStatus, PartnerStatus } from "@domain/task-5-2-device-inventory-pricing";

import { PrismaAuditEventRepository } from "./audit-event-repository";
import type { PartnerTransactionClient } from "./client";
import { readActivePlatformConfig } from "./platform-config-reader";
import { assertAffectedExactlyOne, scopedIdWhere } from "./tenant-scoping";
import type { TenantContext } from "./tenant-context";
import type { UnitOfWork } from "./unit-of-work";

const OFFER_STATUS_TO_DB: Readonly<Record<OfferStatus, $Enums.PartnerOfferStatus>> = {
  inactive: $Enums.PartnerOfferStatus.INACTIVE,
  active: $Enums.PartnerOfferStatus.ACTIVE,
};

const OFFER_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerOfferStatus, OfferStatus>> = {
  INACTIVE: "inactive",
  ACTIVE: "active",
  // The MVP offer commands only toggle inactive/active; a `disabled` row (admin
  // action) is treated as inactive supply by the domain.
  DISABLED: "inactive",
};

const PARTNER_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerStatus, PartnerStatus>> = {
  PENDING: "pending",
  APPROVED: "approved",
  SUSPENDED: "suspended",
  REJECTED: "rejected",
};

function toOfferRecord(offer: PartnerOffer): OfferRecord {
  return {
    id: offer.id,
    partnerId: offer.partnerId,
    serviceCode: offer.serviceCode,
    countryCode: offer.countryCode,
    operatorCode: offer.operatorCode,
    basePriceIdr: offer.basePriceIdr,
    status: OFFER_STATUS_FROM_DB[offer.status],
    configVersion: offer.configVersion,
  };
}

/** True when a Prisma error is a unique-constraint violation (P2002). */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** True when a Prisma error is a foreign-key restrict violation (P2003). */
function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003";
}

/**
 * Prisma-backed {@link OfferManagementTransaction} bound to a single
 * transaction client and tenant. Every read/write is folded with the tenant's
 * `partnerId` (task 7.1), so a cross-tenant id is indistinguishable from a
 * missing row and an offer mutation can never touch another tenant's supply.
 * The offer mutation and its audit event commit atomically within the
 * unit-of-work transaction.
 *
 * MVP-global uniqueness of the active catalog dimension (requirement 8.1) is
 * enforced by the `activeDimensionKey` unique column; a collision surfaces as
 * {@link ActiveOfferConflictError}. An attempt to delete an offer still
 * referenced by an order hits the FK restrict and surfaces as
 * {@link OfferInUseError}.
 */
class PrismaOfferManagementTransaction implements OfferManagementTransaction {
  private readonly tx: PartnerTransactionClient;
  private readonly tenant: TenantContext;
  private readonly audit: PrismaAuditEventRepository;

  constructor(tx: PartnerTransactionClient, tenant: TenantContext) {
    this.tx = tx;
    this.tenant = tenant;
    this.audit = new PrismaAuditEventRepository(tx);
  }

  async loadPartnerStatus(): Promise<PartnerStatus | null> {
    const partner = await this.tx.partner.findUnique({
      where: { id: this.tenant.partnerId },
      select: { status: true },
    });
    return partner === null ? null : PARTNER_STATUS_FROM_DB[partner.status];
  }

  loadActiveConfig(): Promise<PlatformConfigSnapshot | null> {
    return readActivePlatformConfig(this.tx);
  }

  async findOfferById(id: string): Promise<OfferRecord | null> {
    const offer = await this.tx.partnerOffer.findFirst({
      where: scopedIdWhere(this.tenant, id),
    });
    return offer === null ? null : toOfferRecord(offer);
  }

  async insertOffer(record: NewOfferRecord): Promise<OfferRecord> {
    try {
      const created = await this.tx.partnerOffer.create({
        data: {
          id: record.id,
          partnerId: this.tenant.partnerId,
          serviceCode: record.serviceCode,
          countryCode: record.countryCode,
          operatorCode: record.operatorCode,
          basePriceIdr: record.basePriceIdr,
          status: OFFER_STATUS_TO_DB[record.status],
          configVersion: record.configVersion,
          activeDimensionKey: record.activeDimensionKey,
          createdAt: new Date(record.createdAtEpochMs),
        },
      });
      return toOfferRecord(created);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ActiveOfferConflictError();
      throw error;
    }
  }

  async updateOffer(id: string, mutation: OfferMutation): Promise<OfferRecord> {
    try {
      const { count } = await this.tx.partnerOffer.updateMany({
        where: scopedIdWhere(this.tenant, id),
        data: {
          basePriceIdr: mutation.basePriceIdr,
          status: OFFER_STATUS_TO_DB[mutation.status],
          configVersion: mutation.configVersion,
          activeDimensionKey: mutation.activeDimensionKey,
        },
      });
      assertAffectedExactlyOne(count, { compareAndSet: false });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ActiveOfferConflictError();
      throw error;
    }
    return this.requireOffer(id);
  }

  async deleteOfferById(id: string): Promise<void> {
    try {
      const { count } = await this.tx.partnerOffer.deleteMany({
        where: scopedIdWhere(this.tenant, id),
      });
      assertAffectedExactlyOne(count, { compareAndSet: false });
    } catch (error) {
      if (isForeignKeyViolation(error)) throw new OfferInUseError();
      throw error;
    }
  }

  async recordAudit(input: AuditWriteInput): Promise<void> {
    await this.audit.record({
      id: input.id,
      partnerId: input.partnerId,
      requestId: input.requestId,
      descriptor: input.descriptor,
    });
  }

  private async requireOffer(id: string): Promise<OfferRecord> {
    const offer = await this.tx.partnerOffer.findFirstOrThrow({
      where: scopedIdWhere(this.tenant, id),
    });
    return toOfferRecord(offer);
  }
}

/**
 * Composes the task 7.1 unit of work into the application's
 * {@link OfferManagementGateway} port. Every offer mutation plus its audit
 * event runs in one tenant-scoped transaction.
 */
export class PrismaOfferManagementGateway implements OfferManagementGateway {
  private readonly unitOfWork: UnitOfWork;

  constructor(unitOfWork: UnitOfWork) {
    this.unitOfWork = unitOfWork;
  }

  runInTenant<T>(
    tenant: TenantContext,
    work: (tx: OfferManagementTransaction) => Promise<T>,
  ): Promise<T> {
    return this.unitOfWork.run(tenant, ({ tx, tenant: scopedTenant }) =>
      work(new PrismaOfferManagementTransaction(tx, scopedTenant)),
    );
  }
}
