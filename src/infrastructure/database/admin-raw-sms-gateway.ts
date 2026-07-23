import { $Enums } from "@/generated/prisma";

import type {
  EncryptedRawSmsRecord,
  RawSmsMatchStatus,
  RawSmsReadGateway,
} from "@application/admin";

import type { PartnerDatabaseExecutor } from "./client";

const SMS_MATCH_STATUS_FROM_DB: Readonly<Record<$Enums.SmsMatchStatus, RawSmsMatchStatus>> = {
  PENDING: "pending",
  MATCHED: "matched",
  UNMATCHED: "unmatched",
  AMBIGUOUS: "ambiguous",
};

/**
 * Prisma read gateway for the gated raw SMS feature (task 15.4, requirement
 * 19.3).
 *
 * Loads a single encrypted SMS by id together with its owning partner (via the
 * number's tenant, for the audit trail), the canonical number, and the matched
 * order's encrypted OTP. It returns ciphertext only — decryption happens in the
 * cipher behind the {@link import("@application/admin").RawSmsDecryptor} port,
 * and only after the {@link import("@application/admin").AdminRawSmsService}
 * authorization gate passes. Raw Prisma never leaves this adapter.
 */
export class PrismaRawSmsReadGateway implements RawSmsReadGateway {
  private readonly executor: PartnerDatabaseExecutor;

  constructor(executor: PartnerDatabaseExecutor) {
    this.executor = executor;
  }

  async loadEncryptedSmsById(smsId: string): Promise<EncryptedRawSmsRecord | null> {
    const row = await this.executor.partnerSms.findUnique({
      where: { id: smsId },
      select: {
        id: true,
        senderCiphertext: true,
        bodyCiphertext: true,
        keyVersion: true,
        matchStatus: true,
        matchedOrderId: true,
        receivedAtServer: true,
        redactedAt: true,
        number: { select: { partnerId: true, canonicalNumber: true } },
        matchedOrder: { select: { otpCiphertext: true, otpKeyVersion: true } },
      },
    });
    if (row === null) return null;

    return {
      id: row.id,
      partnerId: row.number.partnerId,
      canonicalNumber: row.number.canonicalNumber,
      matchStatus: SMS_MATCH_STATUS_FROM_DB[row.matchStatus],
      matchedOrderId: row.matchedOrderId,
      senderCiphertext: Uint8Array.from(row.senderCiphertext),
      bodyCiphertext: Uint8Array.from(row.bodyCiphertext),
      keyVersion: row.keyVersion,
      otpCiphertext:
        row.matchedOrder?.otpCiphertext != null
          ? Uint8Array.from(row.matchedOrder.otpCiphertext)
          : null,
      otpKeyVersion: row.matchedOrder?.otpKeyVersion ?? null,
      receivedAtServerEpochMs: row.receivedAtServer.getTime(),
      redactedAtEpochMs: row.redactedAt?.getTime() ?? null,
    };
  }
}
