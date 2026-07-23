import type { $Enums, PrismaClient } from "@/generated/prisma";

import type { AdminAuthRecord, AdminIdentityGateway } from "@application/admin/ports";
import type { PartnerAdminLoginStatus } from "@domain/task-7-5";

/**
 * Non-tenant-scoped Partner Admin identity gateway.
 *
 * Admins live in a global realm with no `partnerId`, so this binds to the root
 * client rather than a `TenantScopedRepository`. It exposes only the
 * credential-bearing view the admin login needs; Prisma is fully encapsulated
 * here and never handed to the transport layer.
 */
const STATUS_TO_DOMAIN: Record<$Enums.PartnerAdminStatus, PartnerAdminLoginStatus> = {
  ACTIVE: "active",
  DISABLED: "disabled",
};

export class PrismaAdminIdentityGateway implements AdminIdentityGateway {
  private readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  async findAdminByEmail(emailNormalized: string): Promise<AdminAuthRecord | null> {
    const admin = await this.client.partnerAdmin.findUnique({
      where: { emailNormalized },
      select: {
        id: true,
        passwordHash: true,
        permissions: true,
        securityVersion: true,
        status: true,
      },
    });
    return admin === null ? null : toAuthRecord(admin);
  }

  async findAdminById(adminId: string): Promise<AdminAuthRecord | null> {
    const admin = await this.client.partnerAdmin.findUnique({
      where: { id: adminId },
      select: {
        id: true,
        passwordHash: true,
        permissions: true,
        securityVersion: true,
        status: true,
      },
    });
    return admin === null ? null : toAuthRecord(admin);
  }
}

interface PartnerAdminAuthRow {
  readonly id: string;
  readonly passwordHash: string;
  readonly permissions: readonly string[];
  readonly securityVersion: number;
  readonly status: $Enums.PartnerAdminStatus;
}

function toAuthRecord(admin: PartnerAdminAuthRow): AdminAuthRecord {
  return {
    adminId: admin.id,
    passwordHash: admin.passwordHash,
    permissions: [...admin.permissions],
    securityVersion: admin.securityVersion,
    status: STATUS_TO_DOMAIN[admin.status],
  };
}
