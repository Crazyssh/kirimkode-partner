-- CreateEnum
CREATE TYPE "PartnerStatus" AS ENUM ('pending', 'approved', 'suspended', 'rejected');

-- CreateEnum
CREATE TYPE "PartnerMemberRole" AS ENUM ('owner', 'member');

-- CreateEnum
CREATE TYPE "PartnerMemberStatus" AS ENUM ('pending_verification', 'active', 'suspended', 'disabled');

-- CreateEnum
CREATE TYPE "PartnerAdminStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "OneTimeTokenType" AS ENUM ('email_verification', 'password_reset');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('active', 'superseded', 'revoked');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('partner_member', 'partner_admin', 'device', 'service', 'system', 'cron');

-- CreateEnum
CREATE TYPE "AuditResult" AS ENUM ('succeeded', 'failed', 'denied');

-- CreateEnum
CREATE TYPE "SecurityEventCategory" AS ENUM ('authentication_failure', 'replay_attempt', 'rate_limited', 'ownership_violation', 'sensitive_data_access', 'credential_event');

-- CreateEnum
CREATE TYPE "SecurityEventResult" AS ENUM ('observed', 'blocked', 'allowed');

-- CreateEnum
CREATE TYPE "PartnerDeviceType" AS ENUM ('simulator', 'android', 'modem', 'goip', 'api');

-- CreateEnum
CREATE TYPE "PartnerDeviceStatus" AS ENUM ('offline', 'online', 'disabled');

-- CreateEnum
CREATE TYPE "PartnerNumberStatus" AS ENUM ('offline', 'available', 'reserved', 'busy', 'disabled');

-- CreateEnum
CREATE TYPE "PartnerOfferStatus" AS ENUM ('inactive', 'active', 'disabled');

-- CreateEnum
CREATE TYPE "PartnerOrderStatus" AS ENUM ('created', 'reserved', 'waiting_sms', 'success', 'cancelled', 'timeout', 'failed');

-- CreateEnum
CREATE TYPE "SmsMatchStatus" AS ENUM ('pending', 'matched', 'unmatched', 'ambiguous');

-- CreateEnum
CREATE TYPE "IdempotencyState" AS ENUM ('processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "PartnerEarningStatus" AS ENUM ('pending', 'available', 'requested', 'paid', 'reversed');

-- CreateEnum
CREATE TYPE "LedgerEventType" AS ENUM ('order_success', 'hold_release', 'earning_reversal', 'payout_lock', 'payout_unlock', 'payout_paid', 'manual_adjustment');

-- CreateEnum
CREATE TYPE "LedgerBucket" AS ENUM ('platform_partner_payable', 'partner_pending', 'partner_available', 'partner_payout_locked', 'partner_paid', 'partner_reversed');

-- CreateEnum
CREATE TYPE "PayoutDestinationStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "PartnerPayoutStatus" AS ENUM ('requested', 'approved', 'processing', 'paid', 'rejected', 'failed');

-- CreateEnum
CREATE TYPE "PayoutPaymentMethod" AS ENUM ('bank_transfer_manual');

-- CreateEnum
CREATE TYPE "ReconciliationIssueType" AS ENUM ('order_number_mismatch', 'earning_snapshot_mismatch', 'ledger_imbalance', 'payout_allocation_mismatch', 'projection_ledger_mismatch', 'stale_financial_state');

-- CreateEnum
CREATE TYPE "ReconciliationSeverity" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "ReconciliationIssueStatus" AS ENUM ('open', 'resolved', 'dismissed');

-- CreateTable
CREATE TABLE "partners" (
    "id" UUID NOT NULL,
    "legalName" VARCHAR(200) NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "status" "PartnerStatus" NOT NULL DEFAULT 'pending',
    "simulatorAllowed" BOOLEAN NOT NULL DEFAULT false,
    "statusReason" VARCHAR(500),
    "approvedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_members" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "emailNormalized" VARCHAR(320) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "role" "PartnerMemberRole" NOT NULL,
    "emailVerifiedAt" TIMESTAMPTZ(6),
    "securityVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "PartnerMemberStatus" NOT NULL DEFAULT 'pending_verification',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partner_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_sessions" (
    "id" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "securityVersion" INTEGER NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "idleExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "one_time_tokens" (
    "id" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "type" "OneTimeTokenType" NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "one_time_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_admins" (
    "id" UUID NOT NULL,
    "emailNormalized" VARCHAR(320) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "securityVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "PartnerAdminStatus" NOT NULL DEFAULT 'active',
    "lastLoginAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partner_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_admin_sessions" (
    "id" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "securityVersion" INTEGER NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "idleExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partner_admin_sessions_tokenHash_key" ON "partner_admin_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "partner_admin_sessions_adminId_revokedAt_expiresAt_idx" ON "partner_admin_sessions"("adminId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "partner_admin_sessions_idleExpiresAt_idx" ON "partner_admin_sessions"("idleExpiresAt");

-- AddForeignKey
ALTER TABLE "partner_admin_sessions" ADD CONSTRAINT "partner_admin_sessions_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "partner_admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraint
ALTER TABLE "partner_admin_sessions" ADD CONSTRAINT "partner_admin_sessions_security_version_check" CHECK ("securityVersion" > 0), ADD CONSTRAINT "partner_admin_sessions_expiry_check" CHECK ("expiresAt" > "createdAt" AND "idleExpiresAt" <= "expiresAt");

-- CreateTable
CREATE TABLE "partner_devices" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "type" "PartnerDeviceType" NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "effectiveStatus" "PartnerDeviceStatus" NOT NULL DEFAULT 'offline',
    "disabledAt" TIMESTAMPTZ(6),
    "lastSeenAt" TIMESTAMPTZ(6),
    "agentVersion" VARCHAR(64),
    "capabilitiesJson" JSONB NOT NULL DEFAULT '{}',
    "metadataJson" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partner_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_credentials" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "publicId" VARCHAR(80) NOT NULL,
    "secretHash" CHAR(64) NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(6),
    "lastUsedAt" TIMESTAMPTZ(6),

    CONSTRAINT "device_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_credentials" (
    "id" UUID NOT NULL,
    "clientId" VARCHAR(100) NOT NULL,
    "keyId" VARCHAR(100) NOT NULL,
    "secretHash" CHAR(64) NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "lastUsedAt" TIMESTAMPTZ(6),

    CONSTRAINT "service_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "partnerId" UUID,
    "actorType" "AuditActorType" NOT NULL,
    "actorRefHash" CHAR(64) NOT NULL,
    "action" VARCHAR(120) NOT NULL,
    "targetType" VARCHAR(100) NOT NULL,
    "targetId" VARCHAR(128) NOT NULL,
    "result" "AuditResult" NOT NULL,
    "safeMetadataJson" JSONB,
    "requestId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" UUID NOT NULL,
    "partnerId" UUID,
    "principalHash" CHAR(64) NOT NULL,
    "category" "SecurityEventCategory" NOT NULL,
    "result" "SecurityEventResult" NOT NULL,
    "networkHash" CHAR(64),
    "safeMetadataJson" JSONB,
    "requestId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_configs" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "serviceCode" VARCHAR(32) NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "operatorCode" VARCHAR(32) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "minBasePriceIdr" INTEGER NOT NULL,
    "maxBasePriceIdr" INTEGER NOT NULL,
    "fixedFeeIdr" INTEGER NOT NULL,
    "markupBps" INTEGER NOT NULL,
    "roundToIdr" INTEGER NOT NULL,
    "heartbeatIntervalSeconds" INTEGER NOT NULL,
    "heartbeatTimeoutSeconds" INTEGER NOT NULL,
    "heartbeatSweepSeconds" INTEGER NOT NULL,
    "orderTimeoutSeconds" INTEGER NOT NULL,
    "cancelMinimumSeconds" INTEGER NOT NULL,
    "reservationRecoverySeconds" INTEGER NOT NULL,
    "earningHoldSeconds" INTEGER NOT NULL,
    "minimumPayoutIdr" INTEGER NOT NULL,
    "smsRawRetentionDays" INTEGER NOT NULL,
    "otpRetentionHours" INTEGER NOT NULL,
    "heartbeatMetadataRetentionDays" INTEGER NOT NULL,
    "securityEventRetentionDays" INTEGER NOT NULL,
    "auditRetentionDays" INTEGER NOT NULL,
    "financialRetentionDays" INTEGER NOT NULL,
    "simulatorAllowlistJson" JSONB NOT NULL,
    "activeKey" VARCHAR(32),
    "activeFrom" TIMESTAMPTZ(6) NOT NULL,
    "retiredAt" TIMESTAMPTZ(6),
    "createdByAdminId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_heartbeats" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signal" INTEGER,
    "operator" VARCHAR(64),
    "health" JSONB,
    "agentVersion" VARCHAR(64),

    CONSTRAINT "device_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_numbers" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "canonicalNumber" VARCHAR(20) NOT NULL,
    "activeCanonicalNumber" VARCHAR(20),
    "countryCode" CHAR(2) NOT NULL,
    "operatorCode" VARCHAR(32) NOT NULL,
    "status" "PartnerNumberStatus" NOT NULL DEFAULT 'offline',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "currentOrderId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partner_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_state_history" (
    "id" UUID NOT NULL,
    "numberId" UUID NOT NULL,
    "fromStatus" "PartnerNumberStatus",
    "toStatus" "PartnerNumberStatus" NOT NULL,
    "actorType" "AuditActorType" NOT NULL,
    "actorRefHash" CHAR(64) NOT NULL,
    "reason" VARCHAR(500),
    "operationKey" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "number_state_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_offers" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "serviceCode" VARCHAR(32) NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "operatorCode" VARCHAR(32) NOT NULL,
    "basePriceIdr" INTEGER NOT NULL,
    "status" "PartnerOfferStatus" NOT NULL DEFAULT 'inactive',
    "configVersion" INTEGER NOT NULL,
    "activeDimensionKey" VARCHAR(160),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partner_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_orders" (
    "id" UUID NOT NULL,
    "buyerOrderRef" VARCHAR(128) NOT NULL,
    "buyerAccountRef" VARCHAR(128) NOT NULL,
    "partnerId" UUID NOT NULL,
    "numberId" UUID NOT NULL,
    "offerId" UUID NOT NULL,
    "status" "PartnerOrderStatus" NOT NULL DEFAULT 'created',
    "otpCiphertext" BYTEA,
    "otpKeyVersion" INTEGER,
    "otpFingerprint" CHAR(64),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "terminalReason" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reservedAt" TIMESTAMPTZ(6),
    "waitingAt" TIMESTAMPTZ(6),
    "succeededAt" TIMESTAMPTZ(6),
    "terminalAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "partner_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_snapshots" (
    "orderId" UUID NOT NULL,
    "serviceCode" VARCHAR(32) NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "operatorCode" VARCHAR(32) NOT NULL,
    "canonicalNumber" VARCHAR(20) NOT NULL,
    "basePriceIdr" INTEGER NOT NULL,
    "retailPriceIdr" INTEGER NOT NULL,
    "payoutIdr" INTEGER NOT NULL,
    "platformMarginIdr" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "configVersion" INTEGER NOT NULL,

    CONSTRAINT "order_snapshots_pkey" PRIMARY KEY ("orderId")
);

-- CreateTable
CREATE TABLE "order_transitions" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "fromStatus" "PartnerOrderStatus",
    "toStatus" "PartnerOrderStatus" NOT NULL,
    "actorType" "AuditActorType" NOT NULL,
    "actorRefHash" CHAR(64) NOT NULL,
    "reason" VARCHAR(500),
    "operationKey" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_sms" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "numberId" UUID NOT NULL,
    "messageId" VARCHAR(255) NOT NULL,
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "senderCiphertext" BYTEA NOT NULL,
    "bodyCiphertext" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "bodyFingerprint" CHAR(64) NOT NULL,
    "receivedAtDevice" TIMESTAMPTZ(6) NOT NULL,
    "receivedAtServer" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "matchStatus" "SmsMatchStatus" NOT NULL DEFAULT 'pending',
    "matchedOrderId" UUID,
    "extractedAt" TIMESTAMPTZ(6),
    "redactedAt" TIMESTAMPTZ(6),

    CONSTRAINT "partner_sms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "scope" VARCHAR(100) NOT NULL,
    "principalId" VARCHAR(128) NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "responseStatus" INTEGER,
    "responseJson" JSONB,
    "state" "IdempotencyState" NOT NULL DEFAULT 'processing',
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "replay_nonces" (
    "id" UUID NOT NULL,
    "principalId" VARCHAR(128) NOT NULL,
    "nonceHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "replay_nonces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_earnings" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "amountIdr" INTEGER NOT NULL,
    "status" "PartnerEarningStatus" NOT NULL DEFAULT 'pending',
    "availableAt" TIMESTAMPTZ(6) NOT NULL,
    "reversedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partner_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "eventType" "LedgerEventType" NOT NULL,
    "eventKey" VARCHAR(255) NOT NULL,
    "referenceType" VARCHAR(80) NOT NULL,
    "referenceId" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "bucket" "LedgerBucket" NOT NULL,
    "amountIdrSigned" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_destinations" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "bankCode" VARCHAR(32) NOT NULL,
    "accountNumberCiphertext" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "accountNumberLast4" CHAR(4) NOT NULL,
    "accountHolderName" VARCHAR(160) NOT NULL,
    "status" "PayoutDestinationStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payout_destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_payouts" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "destinationId" UUID NOT NULL,
    "destinationSnapshotJsonEncrypted" BYTEA NOT NULL,
    "amountIdr" INTEGER NOT NULL,
    "status" "PartnerPayoutStatus" NOT NULL DEFAULT 'requested',
    "paymentMethod" "PayoutPaymentMethod" NOT NULL DEFAULT 'bank_transfer_manual',
    "paymentReference" VARCHAR(160),
    "requestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMPTZ(6),
    "createdByMemberId" UUID NOT NULL,
    "processedByAdminId" UUID,
    "failureReason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partner_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_allocations" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "payoutId" UUID NOT NULL,
    "earningId" UUID NOT NULL,
    "amountIdr" INTEGER NOT NULL,
    "releasedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_transitions" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "payoutId" UUID NOT NULL,
    "fromStatus" "PartnerPayoutStatus",
    "toStatus" "PartnerPayoutStatus" NOT NULL,
    "actorType" "AuditActorType" NOT NULL,
    "actorRefHash" CHAR(64) NOT NULL,
    "reason" VARCHAR(500),
    "operationKey" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_leases" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "ownerId" VARCHAR(128) NOT NULL,
    "leaseUntil" TIMESTAMPTZ(6) NOT NULL,
    "cursorJson" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "job_leases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_issues" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "type" "ReconciliationIssueType" NOT NULL,
    "referenceId" VARCHAR(128) NOT NULL,
    "severity" "ReconciliationSeverity" NOT NULL DEFAULT 'medium',
    "detailsSafeJson" JSONB NOT NULL,
    "status" "ReconciliationIssueStatus" NOT NULL DEFAULT 'open',
    "detectedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(6),
    "resolutionAuditId" UUID,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reconciliation_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "partners_status_createdAt_idx" ON "partners"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "partner_members_emailNormalized_key" ON "partner_members"("emailNormalized");

-- CreateIndex
CREATE INDEX "partner_members_partnerId_role_status_idx" ON "partner_members"("partnerId", "role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "partner_members_id_partnerId_key" ON "partner_members"("id", "partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "partner_sessions_tokenHash_key" ON "partner_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "partner_sessions_partnerId_revokedAt_expiresAt_idx" ON "partner_sessions"("partnerId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "partner_sessions_memberId_revokedAt_idx" ON "partner_sessions"("memberId", "revokedAt");

-- CreateIndex
CREATE INDEX "partner_sessions_idleExpiresAt_idx" ON "partner_sessions"("idleExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "one_time_tokens_tokenHash_key" ON "one_time_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "one_time_tokens_memberId_type_usedAt_expiresAt_idx" ON "one_time_tokens"("memberId", "type", "usedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "one_time_tokens_partnerId_createdAt_idx" ON "one_time_tokens"("partnerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "partner_admins_emailNormalized_key" ON "partner_admins"("emailNormalized");

-- CreateIndex
CREATE INDEX "partner_admins_status_idx" ON "partner_admins"("status");

-- CreateIndex
CREATE INDEX "partner_devices_partnerId_effectiveStatus_lastSeenAt_idx" ON "partner_devices"("partnerId", "effectiveStatus", "lastSeenAt");

-- CreateIndex
CREATE INDEX "partner_devices_effectiveStatus_lastSeenAt_idx" ON "partner_devices"("effectiveStatus", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "partner_devices_id_partnerId_key" ON "partner_devices"("id", "partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "device_credentials_publicId_key" ON "device_credentials"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "device_credentials_secretHash_key" ON "device_credentials"("secretHash");

-- CreateIndex
CREATE INDEX "device_credentials_partnerId_deviceId_status_idx" ON "device_credentials"("partnerId", "deviceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "service_credentials_secretHash_key" ON "service_credentials"("secretHash");

-- CreateIndex
CREATE INDEX "service_credentials_clientId_status_idx" ON "service_credentials"("clientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "service_credentials_clientId_keyId_key" ON "service_credentials"("clientId", "keyId");

-- CreateIndex
CREATE INDEX "audit_events_partnerId_createdAt_idx" ON "audit_events"("partnerId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_actorType_actorRefHash_createdAt_idx" ON "audit_events"("actorType", "actorRefHash", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_targetType_targetId_createdAt_idx" ON "audit_events"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_action_createdAt_idx" ON "audit_events"("action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_requestId_idx" ON "audit_events"("requestId");

-- CreateIndex
CREATE INDEX "security_events_partnerId_createdAt_idx" ON "security_events"("partnerId", "createdAt");

-- CreateIndex
CREATE INDEX "security_events_principalHash_createdAt_idx" ON "security_events"("principalHash", "createdAt");

-- CreateIndex
CREATE INDEX "security_events_category_result_createdAt_idx" ON "security_events"("category", "result", "createdAt");

-- CreateIndex
CREATE INDEX "security_events_requestId_idx" ON "security_events"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "platform_configs_version_key" ON "platform_configs"("version");

-- CreateIndex
CREATE UNIQUE INDEX "platform_configs_activeKey_key" ON "platform_configs"("activeKey");

-- CreateIndex
CREATE INDEX "platform_configs_activeFrom_retiredAt_idx" ON "platform_configs"("activeFrom", "retiredAt");

-- CreateIndex
CREATE INDEX "platform_configs_serviceCode_countryCode_operatorCode_activ_idx" ON "platform_configs"("serviceCode", "countryCode", "operatorCode", "activeFrom");

-- CreateIndex
CREATE INDEX "platform_configs_createdByAdminId_idx" ON "platform_configs"("createdByAdminId");

-- CreateIndex
CREATE INDEX "device_heartbeats_deviceId_receivedAt_idx" ON "device_heartbeats"("deviceId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "device_heartbeats_receivedAt_idx" ON "device_heartbeats"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "partner_numbers_activeCanonicalNumber_key" ON "partner_numbers"("activeCanonicalNumber");

-- CreateIndex
CREATE UNIQUE INDEX "partner_numbers_currentOrderId_key" ON "partner_numbers"("currentOrderId");

-- CreateIndex
CREATE INDEX "partner_numbers_status_enabled_countryCode_operatorCode_id_idx" ON "partner_numbers"("status", "enabled", "countryCode", "operatorCode", "id");

-- CreateIndex
CREATE INDEX "partner_numbers_partnerId_status_enabled_countryCode_operat_idx" ON "partner_numbers"("partnerId", "status", "enabled", "countryCode", "operatorCode");

-- CreateIndex
CREATE INDEX "partner_numbers_deviceId_status_enabled_idx" ON "partner_numbers"("deviceId", "status", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "partner_numbers_id_partnerId_key" ON "partner_numbers"("id", "partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "number_state_history_operationKey_key" ON "number_state_history"("operationKey");

-- CreateIndex
CREATE INDEX "number_state_history_numberId_createdAt_idx" ON "number_state_history"("numberId", "createdAt");

-- CreateIndex
CREATE INDEX "number_state_history_toStatus_createdAt_idx" ON "number_state_history"("toStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "partner_offers_activeDimensionKey_key" ON "partner_offers"("activeDimensionKey");

-- CreateIndex
CREATE INDEX "partner_offers_status_serviceCode_countryCode_operatorCode__idx" ON "partner_offers"("status", "serviceCode", "countryCode", "operatorCode", "partnerId");

-- CreateIndex
CREATE INDEX "partner_offers_partnerId_status_serviceCode_countryCode_ope_idx" ON "partner_offers"("partnerId", "status", "serviceCode", "countryCode", "operatorCode");

-- CreateIndex
CREATE UNIQUE INDEX "partner_offers_id_partnerId_key" ON "partner_offers"("id", "partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "partner_orders_buyerOrderRef_key" ON "partner_orders"("buyerOrderRef");

-- CreateIndex
CREATE INDEX "partner_orders_numberId_status_createdAt_idx" ON "partner_orders"("numberId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "partner_orders_partnerId_status_createdAt_idx" ON "partner_orders"("partnerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "partner_orders_buyerAccountRef_createdAt_idx" ON "partner_orders"("buyerAccountRef", "createdAt");

-- CreateIndex
CREATE INDEX "partner_orders_status_expiresAt_idx" ON "partner_orders"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "partner_orders_id_partnerId_key" ON "partner_orders"("id", "partnerId");

-- CreateIndex
CREATE INDEX "order_snapshots_serviceCode_countryCode_operatorCode_idx" ON "order_snapshots"("serviceCode", "countryCode", "operatorCode");

-- CreateIndex
CREATE UNIQUE INDEX "order_transitions_operationKey_key" ON "order_transitions"("operationKey");

-- CreateIndex
CREATE INDEX "order_transitions_orderId_createdAt_idx" ON "order_transitions"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "order_transitions_toStatus_createdAt_idx" ON "order_transitions"("toStatus", "createdAt");

-- CreateIndex
CREATE INDEX "partner_sms_numberId_receivedAtServer_idx" ON "partner_sms"("numberId", "receivedAtServer");

-- CreateIndex
CREATE INDEX "partner_sms_matchedOrderId_idx" ON "partner_sms"("matchedOrderId");

-- CreateIndex
CREATE INDEX "partner_sms_matchStatus_receivedAtServer_idx" ON "partner_sms"("matchStatus", "receivedAtServer");

-- CreateIndex
CREATE INDEX "partner_sms_redactedAt_receivedAtServer_idx" ON "partner_sms"("redactedAt", "receivedAtServer");

-- CreateIndex
CREATE UNIQUE INDEX "partner_sms_deviceId_messageId_key" ON "partner_sms"("deviceId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "partner_sms_deviceId_idempotencyKey_key" ON "partner_sms"("deviceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "idempotency_records_expiresAt_idx" ON "idempotency_records"("expiresAt");

-- CreateIndex
CREATE INDEX "idempotency_records_scope_state_createdAt_idx" ON "idempotency_records"("scope", "state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_scope_principalId_key_key" ON "idempotency_records"("scope", "principalId", "key");

-- CreateIndex
CREATE INDEX "replay_nonces_expiresAt_idx" ON "replay_nonces"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "replay_nonces_principalId_nonceHash_key" ON "replay_nonces"("principalId", "nonceHash");

-- CreateIndex
CREATE UNIQUE INDEX "partner_earnings_orderId_key" ON "partner_earnings"("orderId");

-- CreateIndex
CREATE INDEX "partner_earnings_partnerId_status_availableAt_idx" ON "partner_earnings"("partnerId", "status", "availableAt");

-- CreateIndex
CREATE INDEX "partner_earnings_status_availableAt_idx" ON "partner_earnings"("status", "availableAt");

-- CreateIndex
CREATE INDEX "partner_earnings_status_updatedAt_idx" ON "partner_earnings"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "partner_earnings_id_partnerId_key" ON "partner_earnings"("id", "partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "partner_earnings_orderId_partnerId_key" ON "partner_earnings"("orderId", "partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_eventKey_key" ON "ledger_transactions"("eventKey");

-- CreateIndex
CREATE INDEX "ledger_transactions_partnerId_createdAt_idx" ON "ledger_transactions"("partnerId", "createdAt");

-- CreateIndex
CREATE INDEX "ledger_transactions_eventType_createdAt_idx" ON "ledger_transactions"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "ledger_transactions_referenceType_referenceId_createdAt_idx" ON "ledger_transactions"("referenceType", "referenceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_id_partnerId_key" ON "ledger_transactions"("id", "partnerId");

-- CreateIndex
CREATE INDEX "ledger_entries_transactionId_createdAt_idx" ON "ledger_entries"("transactionId", "createdAt");

-- CreateIndex
CREATE INDEX "ledger_entries_partnerId_bucket_createdAt_idx" ON "ledger_entries"("partnerId", "bucket", "createdAt");

-- CreateIndex
CREATE INDEX "payout_destinations_partnerId_status_createdAt_idx" ON "payout_destinations"("partnerId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payout_destinations_id_partnerId_key" ON "payout_destinations"("id", "partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "partner_payouts_paymentReference_key" ON "partner_payouts"("paymentReference");

-- CreateIndex
CREATE INDEX "partner_payouts_partnerId_status_requestedAt_idx" ON "partner_payouts"("partnerId", "status", "requestedAt");

-- CreateIndex
CREATE INDEX "partner_payouts_status_requestedAt_idx" ON "partner_payouts"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "partner_payouts_status_updatedAt_idx" ON "partner_payouts"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "partner_payouts_processedByAdminId_status_idx" ON "partner_payouts"("processedByAdminId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "partner_payouts_id_partnerId_key" ON "partner_payouts"("id", "partnerId");

-- CreateIndex
-- Partial unique: an Earning may sit in at most one ACTIVE allocation. A payout
-- that is rejected/failed sets releasedAt on its allocations (see
-- partner_guard_allocation_mutation), removing them from this index so the
-- returned-to-available Earning can be requested again without being stranded.
CREATE UNIQUE INDEX "payout_allocations_earningId_key" ON "payout_allocations"("earningId") WHERE "releasedAt" IS NULL;

-- CreateIndex
CREATE INDEX "payout_allocations_partnerId_payoutId_idx" ON "payout_allocations"("partnerId", "payoutId");

-- CreateIndex
CREATE UNIQUE INDEX "payout_allocations_payoutId_earningId_key" ON "payout_allocations"("payoutId", "earningId");

-- CreateIndex
CREATE UNIQUE INDEX "payout_transitions_operationKey_key" ON "payout_transitions"("operationKey");

-- CreateIndex
CREATE INDEX "payout_transitions_payoutId_createdAt_idx" ON "payout_transitions"("payoutId", "createdAt");

-- CreateIndex
CREATE INDEX "payout_transitions_partnerId_toStatus_createdAt_idx" ON "payout_transitions"("partnerId", "toStatus", "createdAt");

-- CreateIndex
CREATE INDEX "payout_transitions_toStatus_createdAt_idx" ON "payout_transitions"("toStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "job_leases_name_key" ON "job_leases"("name");

-- CreateIndex
CREATE INDEX "job_leases_leaseUntil_idx" ON "job_leases"("leaseUntil");

-- CreateIndex
CREATE INDEX "job_leases_ownerId_leaseUntil_idx" ON "job_leases"("ownerId", "leaseUntil");

-- CreateIndex
CREATE INDEX "reconciliation_issues_partnerId_status_severity_detectedAt_idx" ON "reconciliation_issues"("partnerId", "status", "severity", "detectedAt");

-- CreateIndex
CREATE INDEX "reconciliation_issues_type_status_detectedAt_idx" ON "reconciliation_issues"("type", "status", "detectedAt");

-- CreateIndex
CREATE INDEX "reconciliation_issues_referenceId_status_idx" ON "reconciliation_issues"("referenceId", "status");

-- CreateIndex
CREATE INDEX "reconciliation_issues_status_detectedAt_idx" ON "reconciliation_issues"("status", "detectedAt");

-- AddForeignKey
ALTER TABLE "partner_members" ADD CONSTRAINT "partner_members_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_sessions" ADD CONSTRAINT "partner_sessions_memberId_partnerId_fkey" FOREIGN KEY ("memberId", "partnerId") REFERENCES "partner_members"("id", "partnerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_sessions" ADD CONSTRAINT "partner_sessions_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "one_time_tokens" ADD CONSTRAINT "one_time_tokens_memberId_partnerId_fkey" FOREIGN KEY ("memberId", "partnerId") REFERENCES "partner_members"("id", "partnerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "one_time_tokens" ADD CONSTRAINT "one_time_tokens_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_devices" ADD CONSTRAINT "partner_devices_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_deviceId_partnerId_fkey" FOREIGN KEY ("deviceId", "partnerId") REFERENCES "partner_devices"("id", "partnerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_configs" ADD CONSTRAINT "platform_configs_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "partner_admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_heartbeats" ADD CONSTRAINT "device_heartbeats_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "partner_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_numbers" ADD CONSTRAINT "partner_numbers_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_numbers" ADD CONSTRAINT "partner_numbers_deviceId_partnerId_fkey" FOREIGN KEY ("deviceId", "partnerId") REFERENCES "partner_devices"("id", "partnerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_numbers" ADD CONSTRAINT "partner_numbers_currentOrderId_fkey" FOREIGN KEY ("currentOrderId") REFERENCES "partner_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_state_history" ADD CONSTRAINT "number_state_history_numberId_fkey" FOREIGN KEY ("numberId") REFERENCES "partner_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_offers" ADD CONSTRAINT "partner_offers_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_orders" ADD CONSTRAINT "partner_orders_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_orders" ADD CONSTRAINT "partner_orders_numberId_partnerId_fkey" FOREIGN KEY ("numberId", "partnerId") REFERENCES "partner_numbers"("id", "partnerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_orders" ADD CONSTRAINT "partner_orders_offerId_partnerId_fkey" FOREIGN KEY ("offerId", "partnerId") REFERENCES "partner_offers"("id", "partnerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_snapshots" ADD CONSTRAINT "order_snapshots_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "partner_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_transitions" ADD CONSTRAINT "order_transitions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "partner_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_sms" ADD CONSTRAINT "partner_sms_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "partner_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_sms" ADD CONSTRAINT "partner_sms_numberId_fkey" FOREIGN KEY ("numberId") REFERENCES "partner_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_sms" ADD CONSTRAINT "partner_sms_matchedOrderId_fkey" FOREIGN KEY ("matchedOrderId") REFERENCES "partner_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_earnings" ADD CONSTRAINT "partner_earnings_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_earnings" ADD CONSTRAINT "partner_earnings_orderId_partnerId_fkey" FOREIGN KEY ("orderId", "partnerId") REFERENCES "partner_orders"("id", "partnerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transactionId_partnerId_fkey" FOREIGN KEY ("transactionId", "partnerId") REFERENCES "ledger_transactions"("id", "partnerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_destinations" ADD CONSTRAINT "payout_destinations_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_payouts" ADD CONSTRAINT "partner_payouts_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_payouts" ADD CONSTRAINT "partner_payouts_destinationId_partnerId_fkey" FOREIGN KEY ("destinationId", "partnerId") REFERENCES "payout_destinations"("id", "partnerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_payouts" ADD CONSTRAINT "partner_payouts_createdByMemberId_partnerId_fkey" FOREIGN KEY ("createdByMemberId", "partnerId") REFERENCES "partner_members"("id", "partnerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_payouts" ADD CONSTRAINT "partner_payouts_processedByAdminId_fkey" FOREIGN KEY ("processedByAdminId") REFERENCES "partner_admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_allocations" ADD CONSTRAINT "payout_allocations_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_allocations" ADD CONSTRAINT "payout_allocations_payoutId_partnerId_fkey" FOREIGN KEY ("payoutId", "partnerId") REFERENCES "partner_payouts"("id", "partnerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_allocations" ADD CONSTRAINT "payout_allocations_earningId_partnerId_fkey" FOREIGN KEY ("earningId", "partnerId") REFERENCES "partner_earnings"("id", "partnerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_transitions" ADD CONSTRAINT "payout_transitions_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_transitions" ADD CONSTRAINT "payout_transitions_payoutId_partnerId_fkey" FOREIGN KEY ("payoutId", "partnerId") REFERENCES "partner_payouts"("id", "partnerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_issues" ADD CONSTRAINT "reconciliation_issues_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_issues" ADD CONSTRAINT "reconciliation_issues_resolutionAuditId_fkey" FOREIGN KEY ("resolutionAuditId") REFERENCES "audit_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Partner-only invariants Prisma 6.19 cannot express.
ALTER TABLE "partner_members" ADD CONSTRAINT "partner_members_security_version_check" CHECK ("securityVersion" > 0);
ALTER TABLE "partner_sessions" ADD CONSTRAINT "partner_sessions_security_version_check" CHECK ("securityVersion" > 0), ADD CONSTRAINT "partner_sessions_expiry_check" CHECK ("expiresAt" > "createdAt" AND "idleExpiresAt" <= "expiresAt");
ALTER TABLE "one_time_tokens" ADD CONSTRAINT "one_time_tokens_expiry_check" CHECK ("expiresAt" > "createdAt");
ALTER TABLE "partner_admins" ADD CONSTRAINT "partner_admins_security_version_check" CHECK ("securityVersion" > 0);
ALTER TABLE "partner_devices" ADD CONSTRAINT "partner_devices_disabled_check" CHECK (("effectiveStatus" = 'disabled') = ("disabledAt" IS NOT NULL));
ALTER TABLE "platform_configs" ADD CONSTRAINT "platform_configs_policy_check" CHECK (
  "version" > 0 AND "minBasePriceIdr" >= 0 AND "maxBasePriceIdr" >= "minBasePriceIdr"
  AND "fixedFeeIdr" >= 0 AND "markupBps" >= 0 AND "roundToIdr" > 0
  AND "heartbeatIntervalSeconds" > 0 AND "heartbeatTimeoutSeconds" >= "heartbeatIntervalSeconds"
  AND "heartbeatSweepSeconds" > 0 AND "orderTimeoutSeconds" > "cancelMinimumSeconds"
  AND "cancelMinimumSeconds" >= 0 AND "reservationRecoverySeconds" > 0
  AND "earningHoldSeconds" >= 0 AND "minimumPayoutIdr" > 0
  AND "smsRawRetentionDays" > 0 AND "otpRetentionHours" > 0
  AND "heartbeatMetadataRetentionDays" > 0 AND "securityEventRetentionDays" > 0
  AND "auditRetentionDays" > 0 AND "financialRetentionDays" > 0
  AND jsonb_typeof("simulatorAllowlistJson") = 'object'
  AND ("retiredAt" IS NULL OR "retiredAt" > "activeFrom")
);
ALTER TABLE "partner_numbers" ADD CONSTRAINT "partner_numbers_active_canonical_check" CHECK (
  CASE WHEN "enabled" AND "status" <> 'disabled'
    THEN "activeCanonicalNumber" = "canonicalNumber"
    ELSE "activeCanonicalNumber" IS NULL END
);
ALTER TABLE "partner_offers" ADD CONSTRAINT "partner_offers_base_price_check" CHECK ("basePriceIdr" >= 0), ADD CONSTRAINT "partner_offers_active_dimension_check" CHECK (
  CASE WHEN "status" = 'active'
    THEN "activeDimensionKey" = "partnerId"::text || ':' || "serviceCode" || ':' || "countryCode" || ':' || "operatorCode"
    ELSE "activeDimensionKey" IS NULL END
);
ALTER TABLE "partner_orders" ADD CONSTRAINT "partner_orders_version_check" CHECK ("version" > 0), ADD CONSTRAINT "partner_orders_expiry_check" CHECK ("expiresAt" > "createdAt");
ALTER TABLE "order_snapshots" ADD CONSTRAINT "order_snapshots_financial_check" CHECK (
  "basePriceIdr" >= 0 AND "retailPriceIdr" >= 0 AND "payoutIdr" >= 0 AND "platformMarginIdr" >= 0
  AND "payoutIdr" = "basePriceIdr" AND "retailPriceIdr" = "payoutIdr" + "platformMarginIdr"
);
ALTER TABLE "partner_sms" ADD CONSTRAINT "partner_sms_key_version_check" CHECK ("keyVersion" > 0);
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_expiry_check" CHECK ("expiresAt" > "createdAt");
ALTER TABLE "replay_nonces" ADD CONSTRAINT "replay_nonces_expiry_check" CHECK ("expiresAt" > "createdAt");
ALTER TABLE "partner_earnings" ADD CONSTRAINT "partner_earnings_amount_check" CHECK ("amountIdr" > 0);
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_nonzero_check" CHECK ("amountIdrSigned" <> 0);
ALTER TABLE "payout_destinations" ADD CONSTRAINT "payout_destinations_key_check" CHECK ("keyVersion" > 0 AND "accountNumberLast4" ~ '^[0-9]{4}$');
ALTER TABLE "partner_payouts" ADD CONSTRAINT "partner_payouts_amount_check" CHECK ("amountIdr" > 0), ADD CONSTRAINT "partner_payouts_version_check" CHECK ("version" > 0), ADD CONSTRAINT "partner_payouts_paid_check" CHECK (
  "status" <> 'paid' OR ("paidAt" IS NOT NULL AND "processedByAdminId" IS NOT NULL AND "paymentMethod" = 'bank_transfer_manual' AND "paymentReference" IS NOT NULL)
);
ALTER TABLE "payout_allocations" ADD CONSTRAINT "payout_allocations_amount_check" CHECK ("amountIdr" > 0);
ALTER TABLE "reconciliation_issues" ADD CONSTRAINT "reconciliation_issues_resolution_check" CHECK (
  ("status" = 'open' AND "resolvedAt" IS NULL AND "resolutionAuditId" IS NULL)
  OR ("status" IN ('resolved', 'dismissed') AND "resolvedAt" IS NOT NULL AND "resolutionAuditId" IS NOT NULL)
);

CREATE UNIQUE INDEX "partner_orders_one_active_per_number_key"
  ON "partner_orders"("numberId") WHERE "status" IN ('created', 'reserved', 'waiting_sms');

CREATE FUNCTION partner_deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = TG_TABLE_NAME || ' is immutable/append-only';
  RETURN NULL;
END;
$$;
CREATE TRIGGER order_snapshots_immutable BEFORE UPDATE OR DELETE ON "order_snapshots" FOR EACH ROW EXECUTE FUNCTION partner_deny_mutation();
CREATE TRIGGER platform_configs_immutable BEFORE UPDATE OR DELETE ON "platform_configs" FOR EACH ROW EXECUTE FUNCTION partner_deny_mutation();
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON "ledger_transactions" FOR EACH ROW EXECUTE FUNCTION partner_deny_mutation();
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON "ledger_entries" FOR EACH ROW EXECUTE FUNCTION partner_deny_mutation();

CREATE FUNCTION partner_check_earning_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot_amount INTEGER;
BEGIN
  SELECT "payoutIdr" INTO snapshot_amount FROM "order_snapshots" WHERE "orderId" = NEW."orderId";
  IF snapshot_amount IS NULL OR snapshot_amount <> NEW."amountIdr" THEN
    RAISE EXCEPTION 'earning amount must equal order snapshot payout';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER partner_earnings_match_snapshot
  AFTER INSERT OR UPDATE OF "orderId", "amountIdr" ON "partner_earnings"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION partner_check_earning_snapshot();

CREATE FUNCTION partner_check_ledger_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id UUID; entry_count INTEGER; signed_total BIGINT;
BEGIN
  target_id := CASE WHEN TG_TABLE_NAME = 'ledger_transactions' THEN NEW."id" ELSE NEW."transactionId" END;
  SELECT COUNT(*), COALESCE(SUM("amountIdrSigned"), 0)
    INTO entry_count, signed_total FROM "ledger_entries" WHERE "transactionId" = target_id;
  IF entry_count < 2 OR signed_total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % must have at least two zero-sum entries', target_id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ledger_transactions_balanced AFTER INSERT ON "ledger_transactions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION partner_check_ledger_balance();
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION partner_check_ledger_balance();

CREATE FUNCTION partner_guard_allocation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id UUID; payout_status "PartnerPayoutStatus";
BEGIN
  target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."payoutId" ELSE NEW."payoutId" END;
  SELECT "status" INTO payout_status FROM "partner_payouts" WHERE "id" = target_id;
  -- While the payout is still `requested`, allocations are fully mutable.
  IF payout_status = 'requested' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  -- After `requested`, the ONLY permitted mutation is the one-way release of an
  -- allocation whose payout is rejected/failed: set releasedAt once with every
  -- other column unchanged. The row is kept for audit but leaves the partial
  -- unique index so the returned-to-available Earning can be requested again.
  IF TG_OP = 'UPDATE'
     AND payout_status IN ('rejected', 'failed')
     AND OLD."releasedAt" IS NULL
     AND NEW."releasedAt" IS NOT NULL
     AND NEW."id" = OLD."id"
     AND NEW."partnerId" = OLD."partnerId"
     AND NEW."payoutId" = OLD."payoutId"
     AND NEW."earningId" = OLD."earningId"
     AND NEW."amountIdr" = OLD."amountIdr"
     AND NEW."createdAt" = OLD."createdAt" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'payout allocations are immutable after requested state';
END;
$$;
CREATE TRIGGER payout_allocations_state_guard BEFORE INSERT OR UPDATE OR DELETE ON "payout_allocations"
  FOR EACH ROW EXECUTE FUNCTION partner_guard_allocation_mutation();

CREATE FUNCTION partner_check_payout_financials() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id UUID; payout_amount INTEGER; allocation_total BIGINT; invalid_allocations INTEGER;
BEGIN
  target_id := CASE WHEN TG_TABLE_NAME = 'partner_payouts' THEN NEW."id"
                    WHEN TG_OP = 'DELETE' THEN OLD."payoutId" ELSE NEW."payoutId" END;
  SELECT "amountIdr" INTO payout_amount FROM "partner_payouts" WHERE "id" = target_id;
  SELECT COALESCE(SUM(a."amountIdr"), 0), COUNT(*) FILTER (WHERE a."amountIdr" <> e."amountIdr")
    INTO allocation_total, invalid_allocations
    FROM "payout_allocations" a
    JOIN "partner_earnings" e ON e."id" = a."earningId" AND e."partnerId" = a."partnerId"
    WHERE a."payoutId" = target_id;
  IF invalid_allocations <> 0 OR allocation_total <> payout_amount THEN
    RAISE EXCEPTION 'payout % must equal whole-earning allocations', target_id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER partner_payouts_financial_consistency
  AFTER INSERT OR UPDATE OF "amountIdr" ON "partner_payouts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION partner_check_payout_financials();
CREATE CONSTRAINT TRIGGER payout_allocations_financial_consistency
  AFTER INSERT OR UPDATE OR DELETE ON "payout_allocations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION partner_check_payout_financials();

CREATE FUNCTION partner_guard_payout_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."destinationSnapshotJsonEncrypted" IS DISTINCT FROM OLD."destinationSnapshotJsonEncrypted"
     OR NEW."destinationId" IS DISTINCT FROM OLD."destinationId"
     OR NEW."partnerId" IS DISTINCT FROM OLD."partnerId" THEN
    RAISE EXCEPTION 'payout destination snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER partner_payouts_snapshot_immutable BEFORE UPDATE ON "partner_payouts"
  FOR EACH ROW EXECUTE FUNCTION partner_guard_payout_snapshot();

CREATE FUNCTION partner_check_reconciliation_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audit_partner UUID;
BEGIN
  IF NEW."resolutionAuditId" IS NOT NULL THEN
    SELECT "partnerId" INTO audit_partner FROM "audit_events" WHERE "id" = NEW."resolutionAuditId";
    IF audit_partner IS DISTINCT FROM NEW."partnerId" THEN
      RAISE EXCEPTION 'resolution audit must belong to reconciliation issue partner';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER reconciliation_resolution_same_partner
  AFTER INSERT OR UPDATE OF "partnerId", "resolutionAuditId" ON "reconciliation_issues"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION partner_check_reconciliation_audit();