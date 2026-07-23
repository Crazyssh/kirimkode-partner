import { type PrismaClient } from "@/generated/prisma";

import type {
  RetentionBatchInput,
  RetentionBatchResult,
  RetentionConfig,
  RetentionGateway,
} from "@application/cron-jobs";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** An empty ciphertext used to overwrite a redacted SMS payload in place. */
const REDACTED_BYTES = Buffer.alloc(0);

/**
 * Prisma-backed persistence for the `retention-redaction` job (task 16.3).
 *
 * A job lease is platform-global (task 16.1), so this adapter binds to the raw
 * Prisma client rather than a `TenantContext`; retention spans every tenant's
 * data. Raw Prisma never leaves this module.
 *
 * Each pass selects a bounded, id-ordered page of *due* candidates and disposes
 * of them idempotently (requirement 20.2):
 *
 *  - `redactRawSms` overwrites the sender/body ciphertext and stamps
 *    `redactedAt`; the `redactedAt IS NULL` filter makes a re-run a no-op and
 *    the SMS row (with its match/audit linkage) survives (requirement 19.5).
 *  - `redactOtp` nulls the terminal order's OTP ciphertext/key/fingerprint; the
 *    `otpCiphertext IS NOT NULL` filter makes a re-run a no-op and the order,
 *    its Earning, and the ledger are untouched (requirement 19.5).
 *  - `pruneHeartbeatMetadata` / `pruneSecurityEvents` delete stale rows; the
 *    device's authoritative `lastSeenAt` is a separate column and is preserved.
 *
 * The financial/audit evidence tables (audit, ledger, payout) are never
 * referenced here, so retention can never destroy required records.
 */
export class PrismaRetentionGateway implements RetentionGateway {
  private readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  async loadRetentionConfig(): Promise<RetentionConfig | null> {
    const config = await this.client.platformConfig.findFirst({
      where: { retiredAt: null, activeKey: { not: null } },
      orderBy: { version: "desc" },
      select: {
        smsRawRetentionDays: true,
        otpRetentionHours: true,
        heartbeatMetadataRetentionDays: true,
        securityEventRetentionDays: true,
        auditRetentionDays: true,
        financialRetentionDays: true,
      },
    });
    if (config === null) return null;
    return {
      smsRawMs: config.smsRawRetentionDays * DAY_MS,
      otpAfterTerminalMs: config.otpRetentionHours * HOUR_MS,
      heartbeatMetadataMs: config.heartbeatMetadataRetentionDays * DAY_MS,
      securityLogMs: config.securityEventRetentionDays * DAY_MS,
      auditMs: config.auditRetentionDays * DAY_MS,
      ledgerPayoutMs: config.financialRetentionDays * DAY_MS,
    };
  }

  async redactRawSms(input: RetentionBatchInput): Promise<RetentionBatchResult> {
    const rows = await this.client.partnerSms.findMany({
      where: {
        redactedAt: null,
        receivedAtServer: { lte: new Date(input.olderThanEpochMs) },
        ...(input.afterId === null ? {} : { id: { gt: input.afterId } }),
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: input.limit,
    });
    if (rows.length === 0) return emptyResult();

    const ids = rows.map((row) => row.id);
    // Overwrite the sensitive ciphertext in place and mark the row redacted.
    // Guard on `redactedAt IS NULL` so a concurrent/retried pass is a no-op.
    const updated = await this.client.partnerSms.updateMany({
      where: { id: { in: ids }, redactedAt: null },
      data: {
        senderCiphertext: REDACTED_BYTES,
        bodyCiphertext: REDACTED_BYTES,
        redactedAt: new Date(input.nowEpochMs),
      },
    });
    return {
      processed: updated.count,
      lastId: ids.at(-1) ?? null,
      drained: rows.length < input.limit,
    };
  }

  async redactOtp(input: RetentionBatchInput): Promise<RetentionBatchResult> {
    const rows = await this.client.partnerOrder.findMany({
      where: {
        otpCiphertext: { not: null },
        terminalAt: { lte: new Date(input.olderThanEpochMs) },
        ...(input.afterId === null ? {} : { id: { gt: input.afterId } }),
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: input.limit,
    });
    if (rows.length === 0) return emptyResult();

    const ids = rows.map((row) => row.id);
    // Null out the OTP payload only; the order, its Earning, and the ledger are
    // preserved (requirement 19.5). Guard keeps a re-run a no-op.
    const updated = await this.client.partnerOrder.updateMany({
      where: { id: { in: ids }, otpCiphertext: { not: null } },
      data: {
        otpCiphertext: null,
        otpKeyVersion: null,
        otpFingerprint: null,
      },
    });
    return {
      processed: updated.count,
      lastId: ids.at(-1) ?? null,
      drained: rows.length < input.limit,
    };
  }

  async pruneHeartbeatMetadata(
    input: RetentionBatchInput,
  ): Promise<RetentionBatchResult> {
    const rows = await this.client.deviceHeartbeat.findMany({
      where: {
        receivedAt: { lte: new Date(input.olderThanEpochMs) },
        ...(input.afterId === null ? {} : { id: { gt: input.afterId } }),
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: input.limit,
    });
    if (rows.length === 0) return emptyResult();

    const ids = rows.map((row) => row.id);
    const deleted = await this.client.deviceHeartbeat.deleteMany({
      where: { id: { in: ids } },
    });
    return {
      processed: deleted.count,
      lastId: ids.at(-1) ?? null,
      drained: rows.length < input.limit,
    };
  }

  async pruneSecurityEvents(
    input: RetentionBatchInput,
  ): Promise<RetentionBatchResult> {
    const rows = await this.client.securityEvent.findMany({
      where: {
        createdAt: { lte: new Date(input.olderThanEpochMs) },
        ...(input.afterId === null ? {} : { id: { gt: input.afterId } }),
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: input.limit,
    });
    if (rows.length === 0) return emptyResult();

    const ids = rows.map((row) => row.id);
    const deleted = await this.client.securityEvent.deleteMany({
      where: { id: { in: ids } },
    });
    return {
      processed: deleted.count,
      lastId: ids.at(-1) ?? null,
      drained: rows.length < input.limit,
    };
  }
}

/** A result for an empty page (nothing due): drained, nothing processed. */
function emptyResult(): RetentionBatchResult {
  return { processed: 0, lastId: null, drained: true };
}
