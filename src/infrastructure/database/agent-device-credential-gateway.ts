import type { $Enums, PrismaClient } from "@/generated/prisma";

import type {
  AgentDeviceAuthRecord,
  AgentDeviceCredentialGateway,
  DeviceCredentialStatus,
  DeviceEffectiveStatus,
} from "@application/agent-api/ports";
import type { PartnerStatus } from "@domain/task-5-1/partner-status";

/**
 * Non-tenant-scoped `DeviceCredential` gateway for Agent API v1 (task 11.1).
 *
 * The Agent API authenticator resolves which tenant a caller belongs to, so it
 * cannot yet hold a `TenantContext`; this adapter therefore binds to the root
 * client and looks a credential up by its unique `publicId`, joining the owning
 * device and partner in one query so the guard can verify the secret and
 * enforce the Partner/Device fail-closed gates without a second round-trip. It
 * exposes only the stored hash and lifecycle/status fields — never the raw
 * secret, which is never stored (requirement 5.2). Raw Prisma never leaves this
 * module.
 */
const CREDENTIAL_STATUS_FROM_DB: Readonly<Record<$Enums.CredentialStatus, DeviceCredentialStatus>> = {
  ACTIVE: "active",
  SUPERSEDED: "superseded",
  REVOKED: "revoked",
};

const DEVICE_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerDeviceStatus, DeviceEffectiveStatus>> = {
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

export class PrismaAgentDeviceCredentialGateway implements AgentDeviceCredentialGateway {
  private readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  async findByPublicId(publicId: string): Promise<AgentDeviceAuthRecord | null> {
    const row = await this.client.deviceCredential.findUnique({
      where: { publicId },
      select: {
        publicId: true,
        secretHash: true,
        deviceId: true,
        partnerId: true,
        status: true,
        device: { select: { effectiveStatus: true } },
        partner: { select: { status: true } },
      },
    });
    if (row === null) return null;
    return {
      publicId: row.publicId,
      secretHash: row.secretHash,
      deviceId: row.deviceId,
      partnerId: row.partnerId,
      credentialStatus: CREDENTIAL_STATUS_FROM_DB[row.status],
      deviceStatus: DEVICE_STATUS_FROM_DB[row.device.effectiveStatus],
      partnerStatus: PARTNER_STATUS_FROM_DB[row.partner.status],
    };
  }
}
