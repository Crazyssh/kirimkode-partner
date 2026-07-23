import type { $Enums, PrismaClient } from "@/generated/prisma";

import type { SessionAuthContext, SessionGateway } from "@application/auth/ports";
import type { PartnerMemberLoginStatus, SessionRecord } from "@domain/task-7-2";

/**
 * Non-tenant-scoped session gateway.
 *
 * Sessions are looked up by their opaque token hash before any tenant context
 * exists (the session is what *establishes* the tenant), so this adapter binds
 * to the root client rather than a `TenantScopedRepository`. It joins the owning
 * member to expose the member's current `securityVersion` and status, letting
 * the domain invalidate a session whose member changed password or was
 * disabled. Raw Prisma stays inside this module.
 */
const STATUS_TO_DOMAIN: Record<$Enums.PartnerMemberStatus, PartnerMemberLoginStatus> = {
  PENDING_VERIFICATION: "pending_verification",
  ACTIVE: "active",
  SUSPENDED: "suspended",
  DISABLED: "disabled",
};

const ROLE_TO_DOMAIN: Record<$Enums.PartnerMemberRole, "owner" | "member"> = {
  OWNER: "owner",
  MEMBER: "member",
};

export class PrismaSessionGateway implements SessionGateway {
  private readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  async create(session: SessionRecord): Promise<void> {
    await this.client.partnerSession.create({
      data: {
        id: session.id,
        memberId: session.memberId,
        partnerId: session.partnerId,
        tokenHash: session.tokenHash,
        securityVersion: session.securityVersion,
        expiresAt: new Date(session.expiresAtEpochMs),
        idleExpiresAt: new Date(session.idleExpiresAtEpochMs),
        createdAt: new Date(session.createdAtEpochMs),
      },
    });
  }

  async findByTokenHash(tokenHash: string): Promise<SessionAuthContext | null> {
    const row = await this.client.partnerSession.findUnique({
      where: { tokenHash },
      include: {
        member: {
          select: { securityVersion: true, role: true, status: true },
        },
      },
    });
    if (row === null) return null;

    const session: SessionRecord = {
      id: row.id,
      memberId: row.memberId,
      partnerId: row.partnerId,
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
      currentSecurityVersion: row.member.securityVersion,
      role: ROLE_TO_DOMAIN[row.member.role],
      status: STATUS_TO_DOMAIN[row.member.status],
    };
  }

  async slideIdleExpiry(
    tokenHash: string,
    idleExpiresAtEpochMs: number,
    lastUsedAtEpochMs: number,
  ): Promise<void> {
    await this.client.partnerSession.updateMany({
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
    await this.client.partnerSession.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date(revokedAtEpochMs) },
    });
  }
}
