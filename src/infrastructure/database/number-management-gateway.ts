import { $Enums, Prisma, type PartnerNumber } from "@/generated/prisma";

import {
  ActiveNumberConflictError,
  type AuditWriteInput,
  type DeviceRef,
  type NewNumberRecord,
  type NumberManagementGateway,
  type NumberManagementTransaction,
  type NumberStateHistoryRecord,
  type NumberStatusMutation,
  type NumberView,
} from "@application/numbers/ports";
import type { AuditActorType } from "@domain/task-5-7";
import type { NumberStatus } from "@domain/task-5-2-device-inventory-pricing";

import { hashActorRef, PrismaAuditEventRepository } from "./audit-event-repository";
import type { PartnerTransactionClient } from "./client";
import { assertAffectedExactlyOne, scopedIdWhere, scopedWhere } from "./tenant-scoping";
import type { TenantContext } from "./tenant-context";
import type { UnitOfWork } from "./unit-of-work";

const NUMBER_STATUS_TO_DB: Readonly<Record<NumberStatus, $Enums.PartnerNumberStatus>> = {
  offline: $Enums.PartnerNumberStatus.OFFLINE,
  available: $Enums.PartnerNumberStatus.AVAILABLE,
  reserved: $Enums.PartnerNumberStatus.RESERVED,
  busy: $Enums.PartnerNumberStatus.BUSY,
  disabled: $Enums.PartnerNumberStatus.DISABLED,
};

const NUMBER_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerNumberStatus, NumberStatus>> = {
  OFFLINE: "offline",
  AVAILABLE: "available",
  RESERVED: "reserved",
  BUSY: "busy",
  DISABLED: "disabled",
};

const ACTOR_TYPE_TO_DB: Readonly<Record<AuditActorType, $Enums.AuditActorType>> = {
  partner_member: $Enums.AuditActorType.PARTNER_MEMBER,
  partner_admin: $Enums.AuditActorType.PARTNER_ADMIN,
  device: $Enums.AuditActorType.DEVICE,
  system: $Enums.AuditActorType.SYSTEM,
};

function toNumberView(number: PartnerNumber): NumberView {
  return {
    id: number.id,
    partnerId: number.partnerId,
    deviceId: number.deviceId,
    canonicalNumber: number.canonicalNumber,
    countryCode: number.countryCode,
    operatorCode: number.operatorCode,
    status: NUMBER_STATUS_FROM_DB[number.status],
    enabled: number.enabled,
    hasActiveOrder: number.currentOrderId !== null,
  };
}

/** True when a Prisma error is a unique-constraint violation (P2002). */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Prisma-backed {@link NumberManagementTransaction} bound to a single
 * transaction client and tenant. Every read/write is folded with the tenant's
 * `partnerId` (task 7.1), so a cross-tenant id is indistinguishable from a
 * missing row and a number mutation can never touch another tenant's inventory.
 * The number mutation, its state-history entry, and the audit event all commit
 * atomically within the unit-of-work transaction.
 *
 * MVP-global uniqueness of the active canonical number (requirement 7.2) is
 * enforced by the `activeCanonicalNumber` unique column; a collision (even
 * across tenants) surfaces as {@link ActiveNumberConflictError}.
 */
class PrismaNumberManagementTransaction implements NumberManagementTransaction {
  private readonly tx: PartnerTransactionClient;
  private readonly tenant: TenantContext;
  private readonly audit: PrismaAuditEventRepository;

  constructor(tx: PartnerTransactionClient, tenant: TenantContext) {
    this.tx = tx;
    this.tenant = tenant;
    this.audit = new PrismaAuditEventRepository(tx);
  }

  async findDeviceRef(deviceId: string): Promise<DeviceRef | null> {
    const device = await this.tx.partnerDevice.findFirst({
      where: scopedIdWhere(this.tenant, deviceId),
      select: { id: true },
    });
    return device === null ? null : { id: device.id };
  }

  async findNumberById(id: string): Promise<NumberView | null> {
    const number = await this.tx.partnerNumber.findFirst({
      where: scopedIdWhere(this.tenant, id),
    });
    return number === null ? null : toNumberView(number);
  }

  async listTenantActiveNumbers(): Promise<
    readonly { readonly id: string; readonly canonicalNumber: string; readonly status: NumberStatus }[]
  > {
    const numbers = await this.tx.partnerNumber.findMany({
      where: scopedWhere(this.tenant, {
        status: { not: $Enums.PartnerNumberStatus.DISABLED },
      }),
      select: { id: true, canonicalNumber: true, status: true },
    });
    return numbers.map((number) => ({
      id: number.id,
      canonicalNumber: number.canonicalNumber,
      status: NUMBER_STATUS_FROM_DB[number.status],
    }));
  }

  async insertNumber(record: NewNumberRecord): Promise<NumberView> {
    try {
      const created = await this.tx.partnerNumber.create({
        data: {
          id: record.id,
          partnerId: this.tenant.partnerId,
          deviceId: record.deviceId,
          canonicalNumber: record.canonicalNumber,
          activeCanonicalNumber: record.activeCanonicalNumber,
          countryCode: record.countryCode,
          operatorCode: record.operatorCode,
          status: NUMBER_STATUS_TO_DB[record.status],
          enabled: record.enabled,
          createdAt: new Date(record.createdAtEpochMs),
        },
      });
      return toNumberView(created);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ActiveNumberConflictError();
      throw error;
    }
  }

  async updateNumberStatus(id: string, mutation: NumberStatusMutation): Promise<NumberView> {
    try {
      const { count } = await this.tx.partnerNumber.updateMany({
        where: scopedIdWhere(this.tenant, id),
        data: {
          status: NUMBER_STATUS_TO_DB[mutation.status],
          enabled: mutation.enabled,
          activeCanonicalNumber: mutation.activeCanonicalNumber,
        },
      });
      assertAffectedExactlyOne(count, { compareAndSet: false });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ActiveNumberConflictError();
      throw error;
    }
    return this.requireNumber(id);
  }

  async moveNumberDevice(id: string, deviceId: string): Promise<NumberView> {
    const { count } = await this.tx.partnerNumber.updateMany({
      where: scopedIdWhere(this.tenant, id),
      data: { deviceId },
    });
    assertAffectedExactlyOne(count, { compareAndSet: false });
    return this.requireNumber(id);
  }

  async deleteNumberById(id: string): Promise<void> {
    // State history has an ON DELETE RESTRICT relation to the number, so its
    // rows are removed first inside the same transaction.
    await this.tx.numberStateHistory.deleteMany({ where: { numberId: id } });
    const { count } = await this.tx.partnerNumber.deleteMany({
      where: scopedIdWhere(this.tenant, id),
    });
    assertAffectedExactlyOne(count, { compareAndSet: false });
  }

  async appendStateHistory(record: NumberStateHistoryRecord): Promise<void> {
    await this.tx.numberStateHistory.create({
      data: {
        id: record.id,
        numberId: record.numberId,
        fromStatus: record.fromStatus === null ? null : NUMBER_STATUS_TO_DB[record.fromStatus],
        toStatus: NUMBER_STATUS_TO_DB[record.toStatus],
        actorType: ACTOR_TYPE_TO_DB[record.actorType],
        actorRefHash: hashActorRef(record.actorRef),
        reason: record.reason,
        createdAt: new Date(record.occurredAtEpochMs),
      },
    });
  }

  async recordAudit(input: AuditWriteInput): Promise<void> {
    await this.audit.record({
      id: input.id,
      partnerId: input.partnerId,
      requestId: input.requestId,
      descriptor: input.descriptor,
    });
  }

  private async requireNumber(id: string): Promise<NumberView> {
    const number = await this.tx.partnerNumber.findFirstOrThrow({
      where: scopedIdWhere(this.tenant, id),
    });
    return toNumberView(number);
  }
}

/**
 * Composes the task 7.1 unit of work into the application's
 * {@link NumberManagementGateway} port. All number mutations plus their
 * state-history and audit events run in one tenant-scoped transaction.
 */
export class PrismaNumberManagementGateway implements NumberManagementGateway {
  private readonly unitOfWork: UnitOfWork;

  constructor(unitOfWork: UnitOfWork) {
    this.unitOfWork = unitOfWork;
  }

  runInTenant<T>(
    tenant: TenantContext,
    work: (tx: NumberManagementTransaction) => Promise<T>,
  ): Promise<T> {
    return this.unitOfWork.run(tenant, ({ tx, tenant: scopedTenant }) =>
      work(new PrismaNumberManagementTransaction(tx, scopedTenant)),
    );
  }
}
