import { $Enums, type Prisma, type PartnerDevice } from "@/generated/prisma";

import type {
  AuditWriteInput,
  DeviceEffectiveStatus,
  DeviceManagementGateway,
  DeviceManagementTransaction,
  DeviceStatusChange,
  DeviceView,
  NewCredentialRecord,
  NewDeviceRecord,
  PartnerGateView,
} from "@application/devices/ports";
import type { DeviceCapabilities, DeviceType } from "@domain/task-5-7";
import type { PartnerStatus } from "@domain/task-5-1/partner-status";

import type { PartnerTransactionClient } from "./client";
import { PrismaAuditEventRepository } from "./audit-event-repository";
import { PartnerDeviceRepository } from "./partner-device-repository";
import type { TenantContext } from "./tenant-context";
import type { UnitOfWork } from "./unit-of-work";

const TYPE_TO_DB: Readonly<Record<DeviceType, $Enums.PartnerDeviceType>> = {
  simulator: $Enums.PartnerDeviceType.SIMULATOR,
  android: $Enums.PartnerDeviceType.ANDROID,
  modem: $Enums.PartnerDeviceType.MODEM,
  goip: $Enums.PartnerDeviceType.GOIP,
  api: $Enums.PartnerDeviceType.API,
};

const TYPE_FROM_DB: Readonly<Record<$Enums.PartnerDeviceType, DeviceType>> = {
  SIMULATOR: "simulator",
  ANDROID: "android",
  MODEM: "modem",
  GOIP: "goip",
  API: "api",
};

const STATUS_TO_DB: Readonly<Record<DeviceEffectiveStatus, $Enums.PartnerDeviceStatus>> = {
  offline: $Enums.PartnerDeviceStatus.OFFLINE,
  online: $Enums.PartnerDeviceStatus.ONLINE,
  disabled: $Enums.PartnerDeviceStatus.DISABLED,
};

const STATUS_FROM_DB: Readonly<Record<$Enums.PartnerDeviceStatus, DeviceEffectiveStatus>> = {
  OFFLINE: "offline",
  ONLINE: "online",
  DISABLED: "disabled",
};

const PARTNER_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerStatus, PartnerStatus>> = {
  PENDING: "pending",
  APPROVED: "approved",
  SUSPENDED: "suspended",
  REJECTED: "rejected",
};

function toDeviceView(device: PartnerDevice): DeviceView {
  return {
    id: device.id,
    partnerId: device.partnerId,
    type: TYPE_FROM_DB[device.type],
    label: device.label,
    effectiveStatus: STATUS_FROM_DB[device.effectiveStatus],
    disabledAtEpochMs: device.disabledAt ? device.disabledAt.getTime() : null,
    lastSeenAtEpochMs: device.lastSeenAt ? device.lastSeenAt.getTime() : null,
    agentVersion: device.agentVersion,
    // Capabilities were validated by `declareCapabilities` before storage.
    capabilities: device.capabilitiesJson as unknown as DeviceCapabilities,
  };
}

/**
 * Prisma-backed {@link DeviceManagementTransaction} bound to a single
 * transaction client and tenant. Tenant-scoped device/credential reads and
 * writes go through the task 7.1 {@link PartnerDeviceRepository}; the partner
 * gate read and the audit insert use the same transaction client so a device or
 * credential change and its audit event commit atomically (requirement 19.1).
 */
class PrismaDeviceManagementTransaction implements DeviceManagementTransaction {
  private readonly devices: PartnerDeviceRepository;
  private readonly audit: PrismaAuditEventRepository;
  private readonly tx: PartnerTransactionClient;
  private readonly tenant: TenantContext;

  constructor(tx: PartnerTransactionClient, tenant: TenantContext) {
    this.tx = tx;
    this.tenant = tenant;
    this.devices = new PartnerDeviceRepository(tx, tenant);
    this.audit = new PrismaAuditEventRepository(tx);
  }

  async loadPartnerGate(): Promise<PartnerGateView | null> {
    const partner = await this.tx.partner.findUnique({
      where: { id: this.tenant.partnerId },
      select: { status: true, simulatorAllowed: true },
    });
    if (partner === null) return null;
    return {
      status: PARTNER_STATUS_FROM_DB[partner.status],
      simulatorAllowed: partner.simulatorAllowed,
    };
  }

  async findDeviceById(id: string): Promise<DeviceView | null> {
    const device = await this.devices.findById(id);
    return device ? toDeviceView(device) : null;
  }

  async createDevice(record: NewDeviceRecord): Promise<DeviceView> {
    const created = await this.devices.create({
      id: record.id,
      type: TYPE_TO_DB[record.type],
      label: record.label,
      effectiveStatus: $Enums.PartnerDeviceStatus.OFFLINE,
      capabilitiesJson: record.capabilities as unknown as Prisma.InputJsonValue,
      createdAt: new Date(record.createdAtEpochMs),
    });
    return toDeviceView(created);
  }

  async updateDeviceStatus(id: string, change: DeviceStatusChange): Promise<DeviceView> {
    const updated = await this.devices.updateStatus(id, {
      effectiveStatus: STATUS_TO_DB[change.effectiveStatus],
      disabledAt: change.disabledAtEpochMs === null ? null : new Date(change.disabledAtEpochMs),
    });
    return toDeviceView(updated);
  }

  async createCredential(record: NewCredentialRecord): Promise<void> {
    await this.devices.createCredential({
      id: record.id,
      deviceId: record.deviceId,
      publicId: record.publicId,
      secretHash: record.secretHash,
      createdAt: new Date(record.createdAtEpochMs),
    });
  }

  async revokeActiveCredentials(deviceId: string, revokedAtEpochMs: number): Promise<number> {
    return this.devices.revokeActiveCredentials(deviceId, new Date(revokedAtEpochMs));
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
 * {@link DeviceManagementGateway} port. All device/credential mutations plus
 * their audit events run in one tenant-scoped transaction.
 */
export class PrismaDeviceManagementGateway implements DeviceManagementGateway {
  private readonly unitOfWork: UnitOfWork;

  constructor(unitOfWork: UnitOfWork) {
    this.unitOfWork = unitOfWork;
  }

  runInTenant<T>(
    tenant: TenantContext,
    work: (tx: DeviceManagementTransaction) => Promise<T>,
  ): Promise<T> {
    return this.unitOfWork.run(tenant, ({ tx, tenant: scopedTenant }) =>
      work(new PrismaDeviceManagementTransaction(tx, scopedTenant)),
    );
  }
}
