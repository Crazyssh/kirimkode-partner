import { createHash } from "node:crypto";

import { Prisma, type PrismaClient } from "@/generated/prisma";

import type { ReplayNonceRegistry } from "@application/internal-api/ports";

/**
 * Non-tenant-scoped `ReplayNonce` registry for Internal API v1 (task 9.1).
 *
 * A nonce is claimed with a single atomic insert keyed by `(principalId,
 * nonceHash)`. The table's unique constraint is the concurrency primitive: two
 * requests replaying the same nonce race on the insert and exactly one wins, so
 * `registerNonce` returns `true` for the first caller and `false` (Prisma
 * P2002 unique violation) for any replay. Only the SHA-256 hash of the nonce is
 * persisted so the raw value never lands in the table. Expired rows are pruned
 * by the retention sweep (task 3.x); the `expiresAt` written here bounds the
 * 10-minute uniqueness window. Raw Prisma never leaves this module.
 */
export class PrismaReplayNonceGateway implements ReplayNonceRegistry {
  private readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  async registerNonce(
    principalId: string,
    nonce: string,
    expiresAtEpochMs: number,
  ): Promise<boolean> {
    const nonceHash = createHash("sha256").update(nonce, "utf8").digest("hex");
    try {
      await this.client.replayNonce.create({
        data: { principalId, nonceHash, expiresAt: new Date(expiresAtEpochMs) },
      });
      return true;
    } catch (error) {
      // Unique-constraint violation on (principalId, nonceHash): this nonce was
      // already claimed within its window, i.e. a replay. Any other error is a
      // genuine failure and must propagate.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return false;
      }
      throw error;
    }
  }
}
