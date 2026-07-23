import { $Enums } from "@/generated/prisma";

import type {
  AdminDeviceRef,
  AdminNumberHistoryInput,
  AdminNumberRef,
  AdminOfferRef,
  AdminPartnerHeader,
  AdminPartnerListItem,
  AdminResourceAuditInput,
  AdminResourceMutationGateway,
  AdminResourceMutationTransaction,
  AdminResourceReadGateway,
  AdminSmsListItem,
  AdminSmsMatchStatus,
} from "@application/admin/resource-ports";
import type { DeviceEffectiveStatus } from "@application/devices";
import type { PortalOfferStatus } from "@application/portal";
import type { NumberStatus } from "@domain/task-5-2-device-inventory-pricing";
import type { PartnerStatus } from "@domain/task-5-1/partner-status";

import { hashActorRef, PrismaAuditEventRepository } from "./audit-event-repository";
import type { PartnerDatabaseExecutor, PartnerTransactionClient } from "./client";
import { assertAffectedExactlyOne, scopedIdWhere } from "./tenant-scoping";
import { createTenantContext, type TenantContext } from "./tenant-context";
import type { UnitOfWork } from "./unit-of-work";

const PARTNER_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerStatus, PartnerStatus>> = {
  PENDING: "pending",
  APPROVED: "approved",
  SUSPENDED: "suspended",
  REJECTED: "rejected",
};

const DEVICE_STATUS_FROM_DB: Readonly<
  Record<$Enums.PartnerDeviceStatus, DeviceEffectiveStatus>
> = {
  OFFLINE: "offline",
  ONLINE: "online",
  DISABLED: "disabled",
};

const NUMBER_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerNumberStatus, NumberStatus>> = {
  OFFLINE: "offline",
  AVAILABLE: "available",
  RESERVED: "reserved",
  BUSY: "busy",
  DISABLED: "disabled",
};

const NUMBER_STATUS_TO_DB: Readonly<Record<NumberStatus, $Enums.PartnerNumberStatus>> = {
  offline: $Enums.PartnerNumberStatus.OFFLINE,
  available: $Enums.PartnerNumberStatus.AVAILABLE,
  reserved: $Enums.PartnerNumberStatus.RESERVED,
  busy: $Enums.PartnerNumberStatus.BUSY,
  disabled: $Enums.PartnerNumberStatus.DISABLED,
};

const OFFER_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerOfferStatus, PortalOfferStatus>> = {
  INACTIVE: "inactive",
  ACTIVE: "active",
  DISABLED: "disabled",
};

const SMS_MATCH_STATUS_FROM_DB: Readonly<Record<$Enums.SmsMatchStatus, AdminSmsMatchStatus>> = {
  PENDING: "pending",
  MATCHED: "matched",
  UNMATCHED: "unmatched",
  AMBIGUOUS: "ambiguous",
};

/**
 * Prisma-backed redaction-safe reads for the Partner Admin resource explorer
 * (task 15.3).
 *
 * Unlike the tenant-scoped portal read model, these reads are keyed by an
 * explicit `partnerId` because an admin acts across the platform. Every
 * projection is redaction-safe: the partner directory and header expose no
 * secrets, and the SMS projection returns metadata only — the encrypted sender
 * and body ciphertext, any plaintext, and the OTP are never selected
 * (requirements 16.3, 16.7, 19.3). Raw Prisma never leaves this adapter.
 */
export class PrismaAdminResourceReadGateway implements AdminResourceReadGateway {
  private readonly executor: PartnerDatabaseExecutor;

  constructor(executor: PartnerDatabaseExecutor) {
    this.executor = executor;
  }

  async listPartners(): Promise<readonly AdminPartnerListItem[]> {
    const partners = await this.executor.partner.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        displayName: true,
        legalName: true,
        status: true,
        statusReason: true,
        createdAt: true,
        approvedAt: true,
        _count: { select: { devices: true, numbers: true, members: true } },
      },
    });
    return partners.map((partner) => ({
      partnerId: partner.id,
      displayName: partner.displayName,
      legalName: partner.legalName,
      status: PARTNER_STATUS_FROM_DB[partner.status],
      statusReason: partner.statusReason,
      createdAtEpochMs: partner.createdAt.getTime(),
      approvedAtEpochMs: partner.approvedAt?.getTime() ?? null,
      deviceCount: partner._count.devices,
      numberCount: partner._count.numbers,
      memberCount: partner._count.members,
    }));
  }

  async loadPartnerHeader(partnerId: string): Promise<AdminPartnerHeader | null> {
    const partner = await this.executor.partner.findUnique({
      where: { id: partnerId },
      select: {
        id: true,
        displayName: true,
        legalName: true,
        status: true,
        statusReason: true,
        simulatorAllowed: true,
        createdAt: true,
        approvedAt: true,
      },
    });
    if (partner === null) return null;
    return {
      partnerId: partner.id,
      displayName: partner.displayName,
      legalName: partner.legalName,
      status: PARTNER_STATUS_FROM_DB[partner.status],
      statusReason: partner.statusReason,
      simulatorAllowed: partner.simulatorAllowed,
      createdAtEpochMs: partner.createdAt.getTime(),
      approvedAtEpochMs: partner.approvedAt?.getTime() ?? null,
    };
  }

  async listRedactedSms(
    partnerId: string,
    limit: number,
  ): Promise<readonly AdminSmsListItem[]> {
    // Scope by the number's tenant; the SMS row has no direct partnerId. Only
    // redaction-safe columns are selected — never the sender/body ciphertext or
    // any OTP material.
    const rows = await this.executor.partnerSms.findMany({
      where: { number: { partnerId } },
      orderBy: { receivedAtServer: "desc" },
      take: limit,
      select: {
        id: true,
        deviceId: true,
        numberId: true,
        matchStatus: true,
        matchedOrderId: true,
        bodyFingerprint: true,
        keyVersion: true,
        receivedAtDevice: true,
        receivedAtServer: true,
        extractedAt: true,
        redactedAt: true,
        number: { select: { canonicalNumber: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      numberId: row.numberId,
      canonicalNumber: row.number.canonicalNumber,
      matchStatus: SMS_MATCH_STATUS_FROM_DB[row.matchStatus],
      matchedOrderId: row.matchedOrderId,
      bodyFingerprint: row.bodyFingerprint,
      keyVersion: row.keyVersion,
      receivedAtDeviceEpochMs: row.receivedAtDevice.getTime(),
      receivedAtServerEpochMs: row.receivedAtServer.getTime(),
      extractedAtEpochMs: row.extractedAt?.getTime() ?? null,
      redactedAtEpochMs: row.redactedAt?.getTime() ?? null,
    }));
  }
}

/**
 * Prisma-backed {@link AdminResourceMutationTransaction} bound to a single
 * transaction client and target partner. Every read/write is folded with the
 * partner's id (via {@link scopedIdWhere}), so a cross-partner id is
 * indistinguishable from a missing row. A disable is a status-only change that
 * preserves the row and its history (requirement 16.4); the mutation and its
 * audit event commit atomically within the unit-of-work transaction.
 */
class PrismaAdminResourceMutationTransaction
  implements AdminResourceMutationTransaction
{
  private readonly tx: PartnerTransactionClient;
  private readonly tenant: TenantContext;
  private readonly audit: PrismaAuditEventRepository;

  constructor(tx: PartnerTransactionClient, tenant: TenantContext) {
    this.tx = tx;
    this.tenant = tenant;
    this.audit = new PrismaAuditEventRepository(tx);
  }

  async findDevice(deviceId: string): Promise<AdminDeviceRef | null> {
    const device = await this.tx.partnerDevice.findFirst({
      where: scopedIdWhere(this.tenant, deviceId),
      select: { id: true, effectiveStatus: true },
    });
    return device === null
      ? null
      : { id: device.id, effectiveStatus: DEVICE_STATUS_FROM_DB[device.effectiveStatus] };
  }

  async disableDevice(deviceId: string, nowEpochMs: number): Promise<void> {
    const { count } = await this.tx.partnerDevice.updateMany({
      where: scopedIdWhere(this.tenant, deviceId),
      data: {
        effectiveStatus: $Enums.PartnerDeviceStatus.DISABLED,
        disabledAt: new Date(nowEpochMs),
      },
    });
    assertAffectedExactlyOne(count, { compareAndSet: false });
  }

  async findNumber(numberId: string): Promise<AdminNumberRef | null> {
    const number = await this.tx.partnerNumber.findFirst({
      where: scopedIdWhere(this.tenant, numberId),
      select: { id: true, status: true },
    });
    return number === null
      ? null
      : { id: number.id, status: NUMBER_STATUS_FROM_DB[number.status] };
  }

  async disableNumber(numberId: string): Promise<void> {
    const { count } = await this.tx.partnerNumber.updateMany({
      where: scopedIdWhere(this.tenant, numberId),
      data: {
        status: $Enums.PartnerNumberStatus.DISABLED,
        enabled: false,
        activeCanonicalNumber: null,
      },
    });
    assertAffectedExactlyOne(count, { compareAndSet: false });
  }

  async appendNumberHistory(record: AdminNumberHistoryInput): Promise<void> {
    await this.tx.numberStateHistory.create({
      data: {
        id: record.id,
        numberId: record.numberId,
        fromStatus: NUMBER_STATUS_TO_DB[record.fromStatus],
        toStatus: NUMBER_STATUS_TO_DB[record.toStatus],
        actorType: $Enums.AuditActorType.PARTNER_ADMIN,
        actorRefHash: hashActorRef(record.actorRef),
        reason: record.reason,
        createdAt: new Date(record.occurredAtEpochMs),
      },
    });
  }

  async findOffer(offerId: string): Promise<AdminOfferRef | null> {
    const offer = await this.tx.partnerOffer.findFirst({
      where: scopedIdWhere(this.tenant, offerId),
      select: { id: true, status: true },
    });
    return offer === null
      ? null
      : { id: offer.id, status: OFFER_STATUS_FROM_DB[offer.status] };
  }

  async disableOffer(offerId: string): Promise<void> {
    const { count } = await this.tx.partnerOffer.updateMany({
      where: scopedIdWhere(this.tenant, offerId),
      data: {
        status: $Enums.PartnerOfferStatus.DISABLED,
        activeDimensionKey: null,
      },
    });
    assertAffectedExactlyOne(count, { compareAndSet: false });
  }

  async recordAudit(input: AdminResourceAuditInput): Promise<void> {
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
 * {@link AdminResourceMutationGateway} port. The transaction is scoped to the
 * target partner's id, so every admin disable + its audit event runs in one
 * atomic, validated scope.
 */
export class PrismaAdminResourceMutationGateway
  implements AdminResourceMutationGateway
{
  private readonly unitOfWork: UnitOfWork;

  constructor(unitOfWork: UnitOfWork) {
    this.unitOfWork = unitOfWork;
  }

  runForPartner<T>(
    partnerId: string,
    work: (tx: AdminResourceMutationTransaction) => Promise<T>,
  ): Promise<T> {
    return this.unitOfWork.run(createTenantContext(partnerId), ({ tx, tenant }) =>
      work(new PrismaAdminResourceMutationTransaction(tx, tenant)),
    );
  }
}
