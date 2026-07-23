import { $Enums, type Prisma, type PartnerDevice } from "@/generated/prisma";

import type { PartnerDatabaseExecutor } from "./client";
import { ResourceNotFoundError } from "./repository-errors";
import type { TenantContext } from "./tenant-context";
import { TenantScopedRepository } from "./tenant-repository";
import { assertAffectedExactlyOne, scopedIdWhere, scopedWhere } from "./tenant-scoping";

/** Fields the device row is created with; `partnerId`/`id` stay controlled. */
export interface PartnerDeviceCreate {
  readonly id: string;
  readonly type: $Enums.PartnerDeviceType;
  readonly label: string;
  readonly effectiveStatus: $Enums.PartnerDeviceStatus;
  readonly capabilitiesJson: Prisma.InputJsonValue;
  readonly createdAt: Date;
}

/** Fields a status command may change on a device. */
export interface PartnerDeviceStatusMutation {
  readonly effectiveStatus: $Enums.PartnerDeviceStatus;
  readonly disabledAt: Date | null;
}

/** The row to insert for a new device credential (hash-only). */
export interface DeviceCredentialCreate {
  readonly id: string;
  readonly deviceId: string;
  readonly publicId: string;
  readonly secretHash: string;
  readonly createdAt: Date;
}

/**
 * Tenant-scoped repository for `PartnerDevice` and its `DeviceCredential`s.
 *
 * Every read and write is folded with the tenant's `partnerId` (task 7.1), so a
 * cross-tenant id is indistinguishable from a missing row (RESOURCE_NOT_FOUND)
 * and a spoofed field can never widen the scope. The raw agent secret is never
 * handled here — only the pre-computed hash is stored (requirement 5.2).
 */
export class PartnerDeviceRepository extends TenantScopedRepository {
  constructor(executor: PartnerDatabaseExecutor, tenant: TenantContext) {
    super(executor, tenant);
  }

  async findById(id: string): Promise<PartnerDevice | null> {
    return this.executor.partnerDevice.findFirst({
      where: scopedIdWhere(this.tenant, id),
    });
  }

  async requireById(id: string): Promise<PartnerDevice> {
    const device = await this.findById(id);
    if (!device) throw new ResourceNotFoundError();
    return device;
  }

  async create(data: PartnerDeviceCreate): Promise<PartnerDevice> {
    return this.executor.partnerDevice.create({
      data: {
        id: data.id,
        partnerId: this.tenant.partnerId,
        type: data.type,
        label: data.label,
        effectiveStatus: data.effectiveStatus,
        capabilitiesJson: data.capabilitiesJson,
        createdAt: data.createdAt,
      },
    });
  }

  /**
   * Apply a scoped status change. A cross-tenant or missing id affects zero
   * rows and surfaces as RESOURCE_NOT_FOUND rather than editing another
   * tenant's device.
   */
  async updateStatus(
    id: string,
    mutation: PartnerDeviceStatusMutation,
  ): Promise<PartnerDevice> {
    const { count } = await this.executor.partnerDevice.updateMany({
      where: scopedIdWhere(this.tenant, id),
      data: {
        effectiveStatus: mutation.effectiveStatus,
        disabledAt: mutation.disabledAt,
      },
    });
    assertAffectedExactlyOne(count, { compareAndSet: false });
    return this.requireById(id);
  }

  async createCredential(data: DeviceCredentialCreate): Promise<void> {
    await this.executor.deviceCredential.create({
      data: {
        id: data.id,
        partnerId: this.tenant.partnerId,
        deviceId: data.deviceId,
        publicId: data.publicId,
        secretHash: data.secretHash,
        status: $Enums.CredentialStatus.ACTIVE,
        createdAt: data.createdAt,
      },
    });
  }

  /**
   * Revoke every active credential of a device immediately (grace period zero,
   * design section 6). Scoped to the tenant, so a cross-tenant device revokes
   * nothing. Returns the number of credentials revoked.
   */
  async revokeActiveCredentials(deviceId: string, revokedAt: Date): Promise<number> {
    const { count } = await this.executor.deviceCredential.updateMany({
      where: scopedWhere(this.tenant, {
        deviceId,
        status: $Enums.CredentialStatus.ACTIVE,
      }),
      data: { status: $Enums.CredentialStatus.REVOKED, revokedAt },
    });
    return count;
  }
}
