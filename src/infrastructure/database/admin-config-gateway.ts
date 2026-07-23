import type { Prisma, PrismaClient } from "@/generated/prisma";

import type {
  ActivePlatformConfigRow,
  AdminConfigGateway,
  PublishConfigVersionInput,
} from "@application/admin";

import { PrismaAuditEventRepository } from "./audit-event-repository";

/**
 * Append-only Prisma persistence for admin PlatformConfig management (task
 * 15.4, requirement 16.5).
 *
 * A PlatformConfig is immutable and versioned. `loadActive` resolves the
 * current highest active version (the row whose `activeKey` slot is set and
 * whose `retiredAt` is null; the reader everywhere takes the highest `version`).
 * `publishNewVersion` INSERTs a brand-new version inside a transaction —
 * `version = max(version) + 1`, a fresh unique active-slot key, and the
 * `config.changed` audit event — and never UPDATEs or DELETEs an existing row,
 * so `platform_configs` stays append-only (matching the immutability grants)
 * and every order keeps the exact config version it snapshotted (requirement
 * 8.5). Raw Prisma never leaves this adapter.
 */
export class PrismaAdminConfigGateway implements AdminConfigGateway {
  private readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  async loadActive(): Promise<ActivePlatformConfigRow | null> {
    const config = await this.client.platformConfig.findFirst({
      where: { retiredAt: null, activeKey: { not: null } },
      orderBy: { version: "desc" },
      select: {
        version: true,
        serviceCode: true,
        countryCode: true,
        operatorCode: true,
        currency: true,
        minBasePriceIdr: true,
        maxBasePriceIdr: true,
        fixedFeeIdr: true,
        markupBps: true,
        roundToIdr: true,
        orderTimeoutSeconds: true,
        cancelMinimumSeconds: true,
        heartbeatIntervalSeconds: true,
        heartbeatTimeoutSeconds: true,
        heartbeatSweepSeconds: true,
        reservationRecoverySeconds: true,
        earningHoldSeconds: true,
        minimumPayoutIdr: true,
        smsRawRetentionDays: true,
        otpRetentionHours: true,
        heartbeatMetadataRetentionDays: true,
        securityEventRetentionDays: true,
        auditRetentionDays: true,
        financialRetentionDays: true,
        simulatorAllowlistJson: true,
      },
    });
    if (config === null) return null;

    return {
      version: config.version,
      serviceCode: config.serviceCode,
      countryCode: config.countryCode,
      operatorCode: config.operatorCode,
      currency: config.currency,
      minBasePriceIdr: config.minBasePriceIdr,
      maxBasePriceIdr: config.maxBasePriceIdr,
      fixedFeeIdr: config.fixedFeeIdr,
      markupBps: config.markupBps,
      roundToIdr: config.roundToIdr,
      orderTimeoutSeconds: config.orderTimeoutSeconds,
      cancelMinimumSeconds: config.cancelMinimumSeconds,
      heartbeatIntervalSeconds: config.heartbeatIntervalSeconds,
      heartbeatTimeoutSeconds: config.heartbeatTimeoutSeconds,
      heartbeatSweepSeconds: config.heartbeatSweepSeconds,
      reservationRecoverySeconds: config.reservationRecoverySeconds,
      earningHoldSeconds: config.earningHoldSeconds,
      minimumPayoutIdr: config.minimumPayoutIdr,
      smsRawRetentionDays: config.smsRawRetentionDays,
      otpRetentionHours: config.otpRetentionHours,
      heartbeatMetadataRetentionDays: config.heartbeatMetadataRetentionDays,
      securityEventRetentionDays: config.securityEventRetentionDays,
      auditRetentionDays: config.auditRetentionDays,
      financialRetentionDays: config.financialRetentionDays,
      simulatorAllowlist: parseSimulatorAllowlist(config.simulatorAllowlistJson),
    };
  }

  async publishNewVersion(
    input: PublishConfigVersionInput,
  ): Promise<{ readonly version: number }> {
    return this.client.$transaction(async (tx) => {
      const max = await tx.platformConfig.aggregate({ _max: { version: true } });
      const version = (max._max.version ?? 0) + 1;

      await tx.platformConfig.create({
        data: {
          id: input.id,
          version,
          serviceCode: input.carried.serviceCode,
          countryCode: input.carried.countryCode,
          operatorCode: input.carried.operatorCode,
          currency: input.carried.currency,
          minBasePriceIdr: input.edited.minBasePriceIdr,
          maxBasePriceIdr: input.edited.maxBasePriceIdr,
          fixedFeeIdr: input.edited.fixedFeeIdr,
          markupBps: input.edited.markupBps,
          roundToIdr: input.edited.roundToIdr,
          heartbeatIntervalSeconds: input.edited.heartbeatIntervalSeconds,
          heartbeatTimeoutSeconds: input.edited.heartbeatTimeoutSeconds,
          heartbeatSweepSeconds: input.carried.heartbeatSweepSeconds,
          orderTimeoutSeconds: input.edited.orderTimeoutSeconds,
          cancelMinimumSeconds: input.edited.cancelMinimumSeconds,
          reservationRecoverySeconds: input.carried.reservationRecoverySeconds,
          earningHoldSeconds: input.edited.earningHoldSeconds,
          minimumPayoutIdr: input.edited.minimumPayoutIdr,
          smsRawRetentionDays: input.edited.smsRawRetentionDays,
          otpRetentionHours: input.edited.otpRetentionHours,
          heartbeatMetadataRetentionDays: input.edited.heartbeatMetadataRetentionDays,
          securityEventRetentionDays: input.edited.securityEventRetentionDays,
          auditRetentionDays: input.edited.auditRetentionDays,
          financialRetentionDays: input.edited.financialRetentionDays,
          simulatorAllowlistJson: {
            partnerIds: [...input.carried.simulatorAllowlist.partnerIds],
          } as Prisma.InputJsonValue,
          activeKey: `active-v${version}`,
          activeFrom: new Date(input.activeFromEpochMs),
          createdByAdminId: input.createdByAdminId,
        },
      });

      await new PrismaAuditEventRepository(tx).record({
        id: crypto.randomUUID(),
        partnerId: null,
        requestId: input.requestId,
        descriptor: input.auditDescriptor,
      });

      return { version };
    });
  }
}

/** Parse the stored `{ partnerIds: string[] }` JSON, defaulting to empty. */
function parseSimulatorAllowlist(
  value: Prisma.JsonValue,
): Readonly<{ partnerIds: readonly string[] }> {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { partnerIds?: unknown }).partnerIds)
  ) {
    const ids = (value as { partnerIds: unknown[] }).partnerIds.filter(
      (id): id is string => typeof id === "string",
    );
    return { partnerIds: ids };
  }
  return { partnerIds: [] };
}
