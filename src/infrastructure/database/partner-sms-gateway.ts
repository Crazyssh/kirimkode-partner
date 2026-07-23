import { $Enums, Prisma } from "@/generated/prisma";

import type {
  EncryptedSmsRecord,
  PartnerSmsGateway,
  PartnerSmsInsertResult,
  SafePartnerSmsView,
} from "@application/sms";

import type { PartnerTransactionClient } from "./client";
import { ResourceNotFoundError } from "./repository-errors";
import { createTenantContext } from "./tenant-context";
import { scopedIdWhere } from "./tenant-scoping";

/**
 * Prisma-backed {@link PartnerSmsGateway} for encrypted SMS persistence (task 12.1).
 *
 * The row carries ciphertext only — the plaintext sender/body never reach this
 * adapter (design section 8: SMS disimpan terenkripsi pada level aplikasi). The
 * method runs on the caller-provided transaction handle (the same interactive
 * transaction the task 9.2 idempotency engine and the task 12.2 matching
 * pipeline use), so the SMS insert commits atomically with the surrounding
 * effect.
 *
 * Tenant isolation is enforced through device ownership: `PartnerSms` has no
 * `partnerId` column of its own, so the adapter first confirms the target
 * device belongs to the trusted tenant (task 7.1 defense-in-depth). A
 * cross-tenant or missing device is indistinguishable — both surface as
 * {@link ResourceNotFoundError} (RESOURCE_NOT_FOUND) so a caller can never probe
 * another tenant's inventory.
 *
 * Insertion is idempotent on the `(deviceId, messageId)` and
 * `(deviceId, idempotencyKey)` unique constraints: a replay loses the race on
 * the unique index and resolves to `duplicate` instead of writing a second row,
 * letting the Agent API return the first result deterministically
 * (requirements 11.3, 18.5). Raw Prisma never leaves this adapter.
 */
const SMS_MATCH_STATUS_FROM_DB: Readonly<
  Record<$Enums.SmsMatchStatus, SafePartnerSmsView["matchStatus"]>
> = {
  PENDING: "pending",
  MATCHED: "matched",
  UNMATCHED: "unmatched",
  AMBIGUOUS: "ambiguous",
};

interface CreatedSmsRow {
  readonly id: string;
  readonly deviceId: string;
  readonly numberId: string;
  readonly messageId: string;
  readonly keyVersion: number;
  readonly bodyFingerprint: string;
  readonly matchStatus: $Enums.SmsMatchStatus;
  readonly matchedOrderId: string | null;
  readonly receivedAtDevice: Date;
  readonly receivedAtServer: Date;
  readonly extractedAt: Date | null;
  readonly redactedAt: Date | null;
}

/** Project a persisted row into the redaction-safe view (no ciphertext, no plaintext). */
function toSafeView(row: CreatedSmsRow): SafePartnerSmsView {
  return Object.freeze({
    id: row.id,
    deviceId: row.deviceId,
    numberId: row.numberId,
    messageId: row.messageId,
    keyVersion: row.keyVersion,
    bodyFingerprint: row.bodyFingerprint,
    matchStatus: SMS_MATCH_STATUS_FROM_DB[row.matchStatus],
    matchedOrderId: row.matchedOrderId,
    receivedAtDeviceEpochMs: row.receivedAtDevice.getTime(),
    receivedAtServerEpochMs: row.receivedAtServer.getTime(),
    extractedAtEpochMs: row.extractedAt === null ? null : row.extractedAt.getTime(),
    redactedAtEpochMs: row.redactedAt === null ? null : row.redactedAt.getTime(),
  });
}

/**
 * Classify which unique constraint a P2002 violation hit so the caller can tell
 * a `messageId` replay from an `idempotencyKey` replay. Prisma reports the
 * offending columns (or constraint name) in `meta.target`; both shapes are
 * flattened to text and matched on the idempotency-key field name, defaulting
 * to the message-id constraint otherwise.
 */
function classifyDuplicate(
  error: Prisma.PrismaClientKnownRequestError,
): "message_id" | "idempotency_key" {
  const target = error.meta?.target;
  const text = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return text.includes("idempotencyKey") || text.includes("idempotency_key")
    ? "idempotency_key"
    : "message_id";
}

export class PrismaPartnerSmsGateway
  implements PartnerSmsGateway<PartnerTransactionClient>
{
  async insertEncryptedSms(
    tx: PartnerTransactionClient,
    partnerId: string,
    record: EncryptedSmsRecord,
  ): Promise<PartnerSmsInsertResult> {
    const tenant = createTenantContext(partnerId);

    // Defense-in-depth tenant isolation: the SMS is only accepted for a device
    // the tenant owns. A cross-tenant/missing device is opaque (RESOURCE_NOT_FOUND).
    const ownedDevice = await tx.partnerDevice.findFirst({
      where: scopedIdWhere(tenant, record.deviceId),
      select: { id: true },
    });
    if (ownedDevice === null) {
      throw new ResourceNotFoundError();
    }

    try {
      const created = (await tx.partnerSms.create({
        data: {
          id: record.id,
          deviceId: record.deviceId,
          numberId: record.numberId,
          messageId: record.messageId,
          idempotencyKey: record.idempotencyKey,
          senderCiphertext: Buffer.from(record.senderCiphertext),
          bodyCiphertext: Buffer.from(record.bodyCiphertext),
          keyVersion: record.keyVersion,
          bodyFingerprint: record.bodyFingerprint,
          receivedAtDevice: new Date(record.receivedAtDeviceEpochMs),
        },
        select: {
          id: true,
          deviceId: true,
          numberId: true,
          messageId: true,
          keyVersion: true,
          bodyFingerprint: true,
          matchStatus: true,
          matchedOrderId: true,
          receivedAtDevice: true,
          receivedAtServer: true,
          extractedAt: true,
          redactedAt: true,
        },
      })) as CreatedSmsRow;
      return { kind: "inserted", sms: toSafeView(created) };
    } catch (error) {
      // Unique violation on (deviceId, messageId) or (deviceId, idempotencyKey):
      // a duplicate delivery. Report the replay so the pipeline returns the
      // first result rather than double-processing.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return { kind: "duplicate", matchedBy: classifyDuplicate(error) };
      }
      throw error;
    }
  }
}
