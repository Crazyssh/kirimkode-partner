import type { PlatformConfigSnapshot } from "@application/offers/ports";

import type { PartnerTransactionClient } from "./client";

/**
 * Read the single immutable active {@link PlatformConfigSnapshot}.
 *
 * The active config is the row whose `activeKey` slot is set and whose
 * `retiredAt` is null; when several ever qualify we take the highest `version`.
 * A newer config is published by retiring the previous one and inserting a new
 * version — an existing row is never mutated in place (requirement 8.5) — so
 * this projection is always a read. Only the pricing/guardrail/catalog fields
 * plus the heartbeat-liveness window the pure domain needs are returned; the
 * rest of the config (retention, payout, timeouts) is irrelevant here.
 */
export async function readActivePlatformConfig(
  tx: PartnerTransactionClient,
): Promise<PlatformConfigSnapshot | null> {
  const config = await tx.platformConfig.findFirst({
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
      heartbeatTimeoutSeconds: true,
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
    heartbeatTimeoutSeconds: config.heartbeatTimeoutSeconds,
  };
}
