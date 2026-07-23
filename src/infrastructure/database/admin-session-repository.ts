import type { $Enums, PrismaClient } from "@/generated/prisma";

import type {
  AdminSessionAuthContext,
  AdminSessionGateway,
} from "@application/admin/ports";
import type { AdminSessionRecord, PartnerAdminLoginStatus } from "@domain/task-7-5";

/**
 * Non-tenant-scoped admin session gateway.
 *
 * Admin sessions are looked up by their opaque token hash and belong to a
 * global {@link PartnerAdmin} (no `partnerId`), so this binds to the root client
 * rather than a `TenantScopedRepository`. It joins the owning admin to expose
 * the current `securityVersion`, `permissions`, and status, letting the domain
 * invalidate a session whose admin changed password or was disabled. Raw Prisma
 * stays inside this module.
 */
const STATUS_TO_DOMAIN: Record<$Enums.PartnerAdminStatus, PartnerAdminLoginStatus> = {
  ACTIVE: "active",
  DISABLED: "disabled",
};

export class PrismaAdminSessionGateway implements AdminSessionGateway {
  private readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  async create(session: AdminSessionRecord): Promise<void> {
    await this.client.partnerAdminSession.create({
      data: {
        id: session.id,
        adminId: session.adminId,
        tokenHash: session.tokenHash,
        securityVersion: session.securityVersion,
        expiresAt: new Date(session.expiresAtEpochMs),
        idleExpiresAt: new Date(session.idleExpiresAtEpochMs),
        createdAt: new Date(session.createdAtEpochMs),
      },
    });
  }

  async findByTokenHash(tokenHash: string): Promise<AdminSessionAuthContext | null> {
    const row = await this.client.partnerAdminSession.findUnique({
      where: { tokenHash },
      include: {
        admin: {
          select: { securityVersion: true, permissions: true, status: true },
        },
      },
    });
    if (row === null) return null;

    const session: AdminSessionRecord = {
      id: row.id,
      adminId: row.adminId,
      tokenHash: row.tokenHash,
      securityVersion: row.securityVersion,
      createdAtEpochMs: row.createdAt.getTime(),
      expiresAtEpochMs: row.expiresAt.getTime(),
      idleExpiresAtEpochMs: row.idleExpiresAt.getTime(),
      lastUsedAtEpochMs: row.lastUsedAt?.getTime() ?? null,
      revokedAtEpochMs: row.revokedAt?.getTime() ?? null,
    };

    return {
      session,
      currentSecurityVersion: row.admin.securityVersion,
      permissions: row.admin.permissions,
      status: STATUS_TO_DOMAIN[row.admin.status],
    };
  }

  async slideIdleExpiry(
    tokenHash: string,
    idleExpiresAtEpochMs: number,
    lastUsedAtEpochMs: number,
  ): Promise<void> {
    await this.client.partnerAdminSession.updateMany({
      where: { tokenHash, revokedAt: null },
      data: {
        idleExpiresAt: new Date(idleExpiresAtEpochMs),
        lastUsedAt: new Date(lastUsedAtEpochMs),
      },
    });
  }

  async revokeByTokenHash(
    tokenHash: string,
    revokedAtEpochMs: number,
  ): Promise<void> {
    // Only the first revocation writes a timestamp; a repeat logout on an
    // already-revoked (or missing) session affects zero rows and is a no-op.
    await this.client.partnerAdminSession.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date(revokedAtEpochMs) },
    });
  }
}
