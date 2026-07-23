import type { $Enums, PrismaClient } from "@/generated/prisma";

import type {
  OneTimeTokenGateway,
  OneTimeTokenIssuance,
  StoredOneTimeToken,
} from "@application/auth/ports";
import type { OneTimeTokenType } from "@domain/task-5-1/one-time-token";

/**
 * Non-tenant-scoped one-time token gateway.
 *
 * Email verification and password reset run before a session (and its
 * `TenantContext`) exists, so this adapter binds to the root client rather than
 * a tenant-scoped repository; the partner id is carried explicitly on each row.
 * Every consumption effect runs inside a transaction together with a single-use
 * guard (`updateMany` on `usedAt: null`) so a token is redeemable at most once
 * even under concurrent requests. Raw Prisma never leaves this module.
 */
const TYPE_TO_DB: Record<OneTimeTokenType, $Enums.OneTimeTokenType> = {
  email_verification: "EMAIL_VERIFICATION",
  password_reset: "PASSWORD_RESET",
};

const TYPE_TO_DOMAIN: Record<$Enums.OneTimeTokenType, OneTimeTokenType> = {
  EMAIL_VERIFICATION: "email_verification",
  PASSWORD_RESET: "password_reset",
};

export class PrismaOneTimeTokenGateway implements OneTimeTokenGateway {
  private readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  async issue(issuance: OneTimeTokenIssuance, invalidatedAtEpochMs: number): Promise<void> {
    await this.client.$transaction(async (tx) => {
      // Retire any outstanding unused token of the same type for this member so
      // only the freshest link is ever redeemable (design.md section 1).
      await tx.oneTimeToken.updateMany({
        where: {
          memberId: issuance.memberId,
          partnerId: issuance.partnerId,
          type: TYPE_TO_DB[issuance.type],
          usedAt: null,
        },
        data: { usedAt: new Date(invalidatedAtEpochMs) },
      });
      await tx.oneTimeToken.create({
        data: {
          id: issuance.id,
          memberId: issuance.memberId,
          partnerId: issuance.partnerId,
          type: TYPE_TO_DB[issuance.type],
          tokenHash: issuance.tokenHash,
          expiresAt: new Date(issuance.expiresAtEpochMs),
          createdAt: new Date(issuance.issuedAtEpochMs),
        },
      });
    });
  }

  async findByTokenHash(tokenHash: string): Promise<StoredOneTimeToken | null> {
    const row = await this.client.oneTimeToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        memberId: true,
        partnerId: true,
        type: true,
        tokenHash: true,
        createdAt: true,
        expiresAt: true,
        usedAt: true,
      },
    });
    if (row === null) return null;

    return {
      id: row.id,
      memberId: row.memberId,
      partnerId: row.partnerId,
      type: TYPE_TO_DOMAIN[row.type],
      tokenHash: row.tokenHash,
      issuedAtEpochMs: row.createdAt.getTime(),
      expiresAtEpochMs: row.expiresAt.getTime(),
      usedAtEpochMs: row.usedAt?.getTime() ?? null,
    };
  }

  async applyEmailVerification(
    tokenId: string,
    memberId: string,
    partnerId: string,
    usedAtEpochMs: number,
  ): Promise<boolean> {
    return this.client.$transaction(async (tx) => {
      const used = await tx.oneTimeToken.updateMany({
        where: { id: tokenId, usedAt: null },
        data: { usedAt: new Date(usedAtEpochMs) },
      });
      // Lost the single-use race: another request already consumed the token.
      if (used.count === 0) return false;

      const usedAt = new Date(usedAtEpochMs);
      await tx.partnerMember.updateMany({
        where: { id: memberId, partnerId, emailVerifiedAt: null },
        data: { emailVerifiedAt: usedAt },
      });
      // Promote a still-pending member to active now that email is confirmed.
      await tx.partnerMember.updateMany({
        where: { id: memberId, partnerId, status: "PENDING_VERIFICATION" },
        data: { status: "ACTIVE" },
      });
      return true;
    });
  }

  async applyPasswordReset(
    tokenId: string,
    memberId: string,
    partnerId: string,
    usedAtEpochMs: number,
    newPasswordHash: string,
  ): Promise<boolean> {
    return this.client.$transaction(async (tx) => {
      const used = await tx.oneTimeToken.updateMany({
        where: { id: tokenId, usedAt: null },
        data: { usedAt: new Date(usedAtEpochMs) },
      });
      if (used.count === 0) return false;

      // Bumping the security version revokes all existing sessions on next
      // resolve (design.md section 1).
      await tx.partnerMember.update({
        where: { id: memberId },
        data: {
          passwordHash: newPasswordHash,
          securityVersion: { increment: 1 },
        },
      });
      return true;
    });
  }
}
