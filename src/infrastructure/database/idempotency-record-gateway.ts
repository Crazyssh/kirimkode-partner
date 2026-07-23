import { Prisma, type $Enums, type PrismaClient } from "@/generated/prisma";

import type {
  IdempotencyRecordInsert,
  IdempotencyRecordLookup,
  IdempotencyRecordRow,
  IdempotencyRecordState,
  IdempotencyStore,
  IdempotencyTransactionRunner,
} from "@application/internal-api/ports";
import type { JsonValue } from "@domain/task-5-3/canonical-request-hash";

import type { PartnerTransactionClient } from "./client";

/**
 * Prisma-backed idempotency record store for Internal API v1 (task 9.2).
 *
 * The idempotency record is not tenant-scoped — it is keyed on the Internal API
 * service principal `(scope, principalId, key)` — so this gateway binds to a
 * transaction handle rather than a `TenantContext`. Both `find` and `insert`
 * run on the caller-provided transaction so the record commits atomically with
 * the domain effect (design section 4). A unique-constraint violation on insert
 * is reported as `{ inserted: false }`, letting the engine replay the record
 * committed by a concurrent winner instead of double-applying the effect. Raw
 * Prisma never leaves this module.
 */
const STATE_TO_DB: Readonly<Record<IdempotencyRecordState, $Enums.IdempotencyState>> = {
  processing: "PROCESSING",
  completed: "COMPLETED",
  failed: "FAILED",
};

export class PrismaIdempotencyStore
  implements IdempotencyStore<PartnerTransactionClient>
{
  async find(
    tx: PartnerTransactionClient,
    lookup: IdempotencyRecordLookup,
  ): Promise<IdempotencyRecordRow | null> {
    const row = await tx.idempotencyRecord.findUnique({
      where: {
        scope_principalId_key: {
          scope: lookup.scope,
          principalId: lookup.principalId,
          key: lookup.key,
        },
      },
      select: {
        scope: true,
        principalId: true,
        key: true,
        requestHash: true,
        responseStatus: true,
        responseJson: true,
      },
    });
    // A record with no persisted response is a `processing` row that never
    // committed a result; treat it as absent so the engine can proceed.
    if (row === null || row.responseStatus === null || row.responseJson === null) {
      return null;
    }
    return {
      scope: row.scope,
      principalId: row.principalId,
      key: row.key,
      requestHash: row.requestHash,
      responseStatus: row.responseStatus,
      responseJson: row.responseJson as JsonValue,
    };
  }

  async insert(
    tx: PartnerTransactionClient,
    record: IdempotencyRecordInsert,
  ): Promise<{ readonly inserted: boolean }> {
    try {
      await tx.idempotencyRecord.create({
        data: {
          scope: record.scope,
          principalId: record.principalId,
          key: record.key,
          requestHash: record.requestHash,
          responseStatus: record.responseStatus,
          responseJson: record.responseJson as Prisma.InputJsonValue,
          state: STATE_TO_DB[record.state],
          expiresAt: new Date(record.expiresAtEpochMs),
        },
      });
      return { inserted: true };
    } catch (error) {
      // Unique violation on (scope, principalId, key): a concurrent attempt
      // committed first. Report the lost race so the engine replays instead.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return { inserted: false };
      }
      throw error;
    }
  }
}

/**
 * Non-tenant-scoped transaction runner for the Internal API idempotency engine
 * (task 9.2). Wraps `PrismaClient.$transaction` so the engine, its store, and
 * the domain effect all share one interactive transaction. The tenant-scoped
 * unit of work (task 7.1) is inappropriate here because Internal API mutations
 * are keyed on a service principal, not a partner tenant.
 */
export class PrismaIdempotencyTransactionRunner
  implements IdempotencyTransactionRunner<PartnerTransactionClient>
{
  private readonly client: PrismaClient;
  private readonly timeoutMs: number;
  private readonly maxWaitMs: number;

  constructor(
    client: PrismaClient,
    options: { readonly timeoutMs?: number; readonly maxWaitMs?: number } = {},
  ) {
    this.client = client;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxWaitMs = options.maxWaitMs ?? 5_000;
  }

  async run<T>(work: (tx: PartnerTransactionClient) => Promise<T>): Promise<T> {
    return this.client.$transaction((tx) => work(tx), {
      timeout: this.timeoutMs,
      maxWait: this.maxWaitMs,
    });
  }
}
