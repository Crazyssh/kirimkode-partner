import { $Enums, Prisma, type PartnerDevice } from "@/generated/prisma";

import type {
  ActiveOfferDimension,
  HeartbeatDeviceRow,
  HeartbeatDeviceUpdate,
  HeartbeatDeviceView,
  HeartbeatGateway,
  HeartbeatSampleRecord,
  IdleNumberRow,
  NumberStatusChange,
  RecordHeartbeatTransaction,
} from "@application/heartbeat/ports";
import type {
  DeviceCapabilities,
  DeviceStatus,
  DeviceType,
  NumberStatus,
} from "@domain/task-5-2-device-inventory-pricing";

import { hashActorRef } from "./audit-event-repository";
import type { PartnerTransactionClient } from "./client";
import { scopedIdWhere, scopedWhere } from "./tenant-scoping";
import type { TenantContext } from "./tenant-context";
import type { UnitOfWork } from "./unit-of-work";

const DEVICE_TYPE_FROM_DB: Readonly<Record<$Enums.PartnerDeviceType, DeviceType>> = {
  SIMULATOR: "simulator",
  ANDROID: "android",
  MODEM: "modem",
  GOIP: "goip",
  API: "api",
};

const DEVICE_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerDeviceStatus, DeviceStatus>> = {
  OFFLINE: "offline",
  ONLINE: "online",
  DISABLED: "disabled",
};

const DEVICE_STATUS_TO_DB: Readonly<Record<DeviceStatus, $Enums.PartnerDeviceStatus>> = {
  offline: $Enums.PartnerDeviceStatus.OFFLINE,
  online: $Enums.PartnerDeviceStatus.ONLINE,
  disabled: $Enums.PartnerDeviceStatus.DISABLED,
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

function toDeviceView(device: PartnerDevice): HeartbeatDeviceView {
  return {
    id: device.id,
    partnerId: device.partnerId,
    type: DEVICE_TYPE_FROM_DB[device.type],
    status: DEVICE_STATUS_FROM_DB[device.effectiveStatus],
    lastSeenAtEpochMs: device.lastSeenAt ? device.lastSeenAt.getTime() : 0,
    agentVersion: device.agentVersion,
    capabilities: device.capabilitiesJson as unknown as DeviceCapabilities,
  };
}

/**
 * Prisma-backed {@link RecordHeartbeatTransaction} bound to a single
 * transaction client and tenant. Every read/write is folded with the tenant's
 * `partnerId` (task 7.1), so a cross-tenant device is indistinguishable from a
 * missing one and a heartbeat can never touch another tenant's inventory. The
 * heartbeat sample insert, device update, and idle-number reconciliation all
 * commit atomically within the unit-of-work transaction.
 */
class PrismaRecordHeartbeatTransaction implements RecordHeartbeatTransaction {
  private readonly tx: PartnerTransactionClient;
  private readonly tenant: TenantContext;

  constructor(tx: PartnerTransactionClient, tenant: TenantContext) {
    this.tx = tx;
    this.tenant = tenant;
  }

  async findDeviceForHeartbeat(deviceId: string): Promise<HeartbeatDeviceRow | null> {
    const device = await this.tx.partnerDevice.findFirst({
      where: scopedIdWhere(this.tenant, deviceId),
    });
    if (device === null) return null;
    return {
      id: device.id,
      partnerId: device.partnerId,
      type: DEVICE_TYPE_FROM_DB[device.type],
      status: DEVICE_STATUS_FROM_DB[device.effectiveStatus],
      lastSeenAtEpochMs: device.lastSeenAt ? device.lastSeenAt.getTime() : null,
      capabilities: device.capabilitiesJson as unknown as DeviceCapabilities,
      agentVersion: device.agentVersion,
    };
  }

  async insertHeartbeatSample(sample: HeartbeatSampleRecord): Promise<void> {
    await this.tx.deviceHeartbeat.create({
      data: {
        id: sample.id,
        deviceId: sample.deviceId,
        receivedAt: new Date(sample.receivedAtEpochMs),
        signal: sample.signal,
        operator: sample.operator,
        health: sample.health === null ? Prisma.JsonNull : (sample.health as Prisma.InputJsonValue),
        agentVersion: sample.agentVersion,
      },
    });
  }

  async applyHeartbeatToDevice(
    deviceId: string,
    update: HeartbeatDeviceUpdate,
  ): Promise<HeartbeatDeviceView> {
    // Scoped update: a cross-tenant or missing device affects zero rows and the
    // subsequent read returns the (still absent) row, so no other tenant's
    // device is ever mutated.
    await this.tx.partnerDevice.updateMany({
      where: scopedIdWhere(this.tenant, deviceId),
      data: {
        effectiveStatus: DEVICE_STATUS_TO_DB[update.status],
        lastSeenAt: new Date(update.lastSeenAtEpochMs),
        agentVersion: update.agentVersion,
        metadataJson:
          update.metadataJson === null
            ? Prisma.JsonNull
            : (update.metadataJson as Prisma.InputJsonValue),
        ...(update.capabilities === null
          ? {}
          : { capabilitiesJson: update.capabilities as unknown as Prisma.InputJsonValue }),
      },
    });

    const device = await this.tx.partnerDevice.findFirstOrThrow({
      where: scopedIdWhere(this.tenant, deviceId),
    });
    return toDeviceView(device);
  }

  async listIdleNumbers(deviceId: string): Promise<readonly IdleNumberRow[]> {
    const numbers = await this.tx.partnerNumber.findMany({
      where: scopedWhere(this.tenant, {
        deviceId,
        status: {
          in: [$Enums.PartnerNumberStatus.OFFLINE, $Enums.PartnerNumberStatus.AVAILABLE],
        },
      }),
      select: {
        id: true,
        status: true,
        enabled: true,
        countryCode: true,
        operatorCode: true,
        currentOrderId: true,
      },
    });
    return numbers.map((number) => ({
      id: number.id,
      status: NUMBER_STATUS_FROM_DB[number.status],
      enabled: number.enabled,
      countryCode: number.countryCode,
      operatorCode: number.operatorCode,
      hasActiveOrder: number.currentOrderId !== null,
    }));
  }

  async listActiveOfferDimensions(): Promise<readonly ActiveOfferDimension[]> {
    const offers = await this.tx.partnerOffer.findMany({
      where: scopedWhere(this.tenant, { status: $Enums.PartnerOfferStatus.ACTIVE }),
      select: { countryCode: true, operatorCode: true },
      distinct: ["countryCode", "operatorCode"],
    });
    return offers.map((offer) => ({
      countryCode: offer.countryCode,
      operatorCode: offer.operatorCode,
    }));
  }

  async applyNumberStatus(change: NumberStatusChange): Promise<void> {
    await this.tx.partnerNumber.updateMany({
      where: scopedIdWhere(this.tenant, change.numberId),
      data: { status: NUMBER_STATUS_TO_DB[change.toStatus] },
    });
    await this.tx.numberStateHistory.create({
      data: {
        id: change.historyId,
        numberId: change.numberId,
        fromStatus: NUMBER_STATUS_TO_DB[change.fromStatus],
        toStatus: NUMBER_STATUS_TO_DB[change.toStatus],
        actorType: $Enums.AuditActorType.DEVICE,
        actorRefHash: hashActorRef(change.actorRef),
        reason: change.reason,
        createdAt: new Date(change.occurredAtEpochMs),
      },
    });
  }
}

/**
 * Composes the task 7.1 unit of work into the application's
 * {@link HeartbeatGateway} port. The heartbeat sample, device liveness update,
 * and idle-number recovery run in one tenant-scoped transaction.
 */
export class PrismaHeartbeatGateway implements HeartbeatGateway {
  private readonly unitOfWork: UnitOfWork;

  constructor(unitOfWork: UnitOfWork) {
    this.unitOfWork = unitOfWork;
  }

  runInTenant<T>(
    tenant: TenantContext,
    work: (tx: RecordHeartbeatTransaction) => Promise<T>,
  ): Promise<T> {
    return this.unitOfWork.run(tenant, ({ tx, tenant: scopedTenant }) =>
      work(new PrismaRecordHeartbeatTransaction(tx, scopedTenant)),
    );
  }
}
