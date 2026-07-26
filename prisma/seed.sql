-- Idempotent MVP PlatformConfig seed for the dedicated Partner database only.
INSERT INTO "platform_configs" (
  "id", "version", "serviceCode", "countryCode", "operatorCode", "currency",
  "minBasePriceIdr", "maxBasePriceIdr", "fixedFeeIdr", "markupBps", "roundToIdr",
  "heartbeatIntervalSeconds", "heartbeatTimeoutSeconds", "heartbeatSweepSeconds",
  "orderTimeoutSeconds", "cancelMinimumSeconds", "reservationRecoverySeconds",
  "earningHoldSeconds", "minimumPayoutIdr", "smsRawRetentionDays", "otpRetentionHours",
  "heartbeatMetadataRetentionDays", "securityEventRetentionDays", "auditRetentionDays",
  "financialRetentionDays", "simulatorAllowlistJson", "activeKey", "activeFrom"
) VALUES (
  '00000000-0000-4000-8000-000000000001', 1, 'wa', 'ID', 'any', 'IDR',
  500, 5000, 250, 1500, 50, 30, 90, 30, 1200, 180, 30, 86400, 1000,
  7, 24, 30, 90, 2557, 2557, '{"partnerIds":[]}'::jsonb, 'mvp-active',
  TIMESTAMPTZ '2026-07-22 00:01:00+00'
)
ON CONFLICT ("version") DO NOTHING;

DO $seed_verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "platform_configs" WHERE "version" = 1 AND "id" = '00000000-0000-4000-8000-000000000001'
      AND "serviceCode" = 'wa' AND "countryCode" = 'ID' AND "operatorCode" = 'any' AND "currency" = 'IDR'
      AND "minBasePriceIdr" = 500 AND "maxBasePriceIdr" = 5000 AND "fixedFeeIdr" = 250
      AND "markupBps" = 1500 AND "roundToIdr" = 50 AND "heartbeatIntervalSeconds" = 30
      AND "heartbeatTimeoutSeconds" = 90 AND "heartbeatSweepSeconds" = 30 AND "orderTimeoutSeconds" = 1200
      AND "cancelMinimumSeconds" = 180 AND "reservationRecoverySeconds" = 30 AND "earningHoldSeconds" = 86400
      AND "minimumPayoutIdr" = 1000 AND "smsRawRetentionDays" = 7 AND "otpRetentionHours" = 24
      AND "heartbeatMetadataRetentionDays" = 30 AND "securityEventRetentionDays" = 90
      AND "auditRetentionDays" = 2557 AND "financialRetentionDays" = 2557
      AND "simulatorAllowlistJson" = '{"partnerIds":[]}'::jsonb AND "activeKey" = 'mvp-active' AND "retiredAt" IS NULL
  ) THEN RAISE EXCEPTION 'PlatformConfig version 1 exists with non-MVP values'; END IF;
END;
$seed_verify$;

-- The catalog dimension the MVP config serves, declared explicitly.
--
-- The dimension list lives in its own table so the platform can serve more than
-- one service/country/operator without duplicating the global operational values
-- (heartbeat windows, earningHoldSeconds, minimumPayoutIdr, retention) per
-- dimension. Seeding it here means a fresh install declares its catalog rather
-- than relying on the "undeclared catalog falls back to the config dimension"
-- rule, which exists only so an already-migrated database can never stop selling.
--
-- All pricing override columns are NULL: this dimension inherits the config's
-- pricing formula exactly, so the seeded price is unchanged.
INSERT INTO "catalog_dimensions" (
  "id", "serviceCode", "countryCode", "operatorCode", "enabled",
  "minBasePriceIdr", "maxBasePriceIdr", "fixedFeeIdr", "markupBps", "roundToIdr",
  "note", "createdAt", "updatedAt"
) VALUES (
  '00000000-0000-4000-8000-000000000101', 'wa', 'ID', 'any', true,
  NULL, NULL, NULL, NULL, NULL,
  'MVP catalog dimension seeded with the version 1 platform config.',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
ON CONFLICT ("serviceCode", "countryCode", "operatorCode") DO NOTHING;

DO $dimension_verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "catalog_dimensions"
    WHERE "serviceCode" = 'wa' AND "countryCode" = 'ID' AND "operatorCode" = 'any'
      AND "enabled" AND "minBasePriceIdr" IS NULL AND "maxBasePriceIdr" IS NULL
      AND "fixedFeeIdr" IS NULL AND "markupBps" IS NULL AND "roundToIdr" IS NULL
  ) THEN RAISE EXCEPTION 'MVP catalog dimension exists with non-MVP values'; END IF;
END;
$dimension_verify$;
