import { $Enums, Prisma, type PartnerNumber } from "@/generated/prisma";

import {
  ActiveNumberConflictError,
  type AuditWriteInput,
  type NewNumberRecord,
  type NumberStateHistoryRecord,
  type NumberStatusMutation,
  type NumberView,
} from "@application/numbers/ports";
import type {
  ActiveNumberIdentity,
  AgentDeviceRef,
  AgentNumberAvailabilityContext,
  AgentNumberGateway,
} from "@application/numbers/agent-ports";
import type { AuditActorType } from "@domain/task-5-7";
import type { DeviceStatus, NumberStatus } from "@domain/task-5-2-device-inventory-pricing";

import { hashActorRef, PrismaAuditEventRepository } from "./audit-event-repository";
import type { PartnerTransactionClient } from "./client";
import { createTenantContext } from "./tenant-context";
import { assertAffectedExactlyOne, scopedIdWhere, scopedWhere } from "./tenant-scoping";

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

const DEVICE_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerDeviceStatus, DeviceStatus>> = {
  OFFLINE: "offline",
  ONLINE: "online",
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
 * Prisma-backed {@link AgentNumberGateway} for the Agent API device number
 * commands (task 11.3).
 *
 * Every method runs on the caller-provided transaction handle — the same
 * interactive transaction the task 9.2 idempotency engine uses — so the number
 * mutation, its state-history entry, the audit event, and the idempotency
 * record all commit atomically. Reads and writes fold the trusted `partnerId`
 * into their predicate (task 7.1), so a cross-tenant id is indistinguishable
 * from a missing row and a device can never touch another tenant's inventory.
 * Raw Prisma never leaves this adapter.
 *
 * MVP-global uniqueness of the active canonical number (requirement 7.2) is
 * enforced by the `activeCanonicalNumber` unique column; a collision surfaces
 * as {@link ActiveNumberConflictError}.
 */
export class PrismaAgentNumberGateway
  implements AgentNumberGateway<PartnerTransactionClient>
{
  async findOwnedDevice(
    tx: PartnerTransactionClient,
    partnerId: string,
    deviceId: string,
  ): Promise<AgentDeviceRef | null> {
    const tenant = createTenantContext(partnerId);
    const device = await tx.partnerDevice.findFirst({
      where: scopedIdWhere(tenant, deviceId),
      select: { id: true },
    });
    return device === null ? null : { id: device.id };
  }

  async listActiveNumbers(
    tx: PartnerTransactionClient,
    partnerId: string,
  ): Promise<readonly ActiveNumberIdentity[]> {
    const tenant = createTenantContext(partnerId);
    const numbers = await tx.partnerNumber.findMany({
      where: scopedWhere(tenant, {
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

  async insertNumber(
    tx: PartnerTransactionClient,
    partnerId: string,
    record: NewNumberRecord,
  ): Promise<NumberView> {
    const tenant = createTenantContext(partnerId);
    try {
      const created = await tx.partnerNumber.create({
        data: {
          id: record.id,
          partnerId: tenant.partnerId,
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

  async loadNumberForAvailability(
    tx: PartnerTransactionClient,
    partnerId: string,
    numberId: string,
  ): Promise<AgentNumberAvailabilityContext | null> {
    const tenant = createTenantContext(partnerId);
    const number = await tx.partnerNumber.findFirst({
      where: scopedIdWhere(tenant, numberId),
      select: {
        id: true,
        deviceId: true,
        canonicalNumber: true,
        countryCode: true,
        operatorCode: true,
        status: true,
        enabled: true,
        currentOrderId: true,
        device: { select: { effectiveStatus: true, lastSeenAt: true } },
      },
    });
    if (number === null) return null;

    // An active offer of the tenant covering the number's catalog dimension.
    const activeOffer = await tx.partnerOffer.findFirst({
      where: scopedWhere(tenant, {
        status: $Enums.PartnerOfferStatus.ACTIVE,
        countryCode: number.countryCode,
        operatorCode: number.operatorCode,
      }),
      select: { id: true },
    });

    return {
      numberId: number.id,
      deviceId: number.deviceId,
      canonicalNumber: number.canonicalNumber,
      countryCode: number.countryCode,
      operatorCode: number.operatorCode,
      status: NUMBER_STATUS_FROM_DB[number.status],
      enabled: number.enabled,
      hasActiveOrder: number.currentOrderId !== null,
      hasActiveOffer: activeOffer !== null,
      device: {
        status: DEVICE_STATUS_FROM_DB[number.device.effectiveStatus],
        lastSeenAtEpochMs: number.device.lastSeenAt === null ? null : number.device.lastSeenAt.getTime(),
      },
    };
  }

  async applyNumberStatus(
    tx: PartnerTransactionClient,
    partnerId: string,
    numberId: string,
    mutation: NumberStatusMutation,
  ): Promise<NumberView> {
    const tenant = createTenantContext(partnerId);
    try {
      const { count } = await tx.partnerNumber.updateMany({
        where: scopedIdWhere(tenant, numberId),
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
    const updated = await tx.partnerNumber.findFirstOrThrow({
      where: scopedIdWhere(tenant, numberId),
    });
    return toNumberView(updated);
  }

  async appendStateHistory(
    tx: PartnerTransactionClient,
    record: NumberStateHistoryRecord,
  ): Promise<void> {
    await tx.numberStateHistory.create({
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

  async recordAudit(tx: PartnerTransactionClient, input: AuditWriteInput): Promise<void> {
    await new PrismaAuditEventRepository(tx).record({
      id: input.id,
      partnerId: input.partnerId,
      requestId: input.requestId,
      descriptor: input.descriptor,
    });
  }
}
