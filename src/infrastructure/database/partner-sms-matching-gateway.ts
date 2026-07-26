import { $Enums } from "@/generated/prisma";

import type {
  ApplySmsRepeatOtpInput,
  ApplySmsSuccessInput,
  OrderRepeatOtpContext,
  OrderSuccessContext,
  SmsAuditMatchStatus,
  SmsMatchingConfig,
  SmsMatchingGateway,
  SmsOrderCandidateRow,
  SmsOwnershipContext,
} from "@application/sms";
import { SmsSuccessContentionError } from "@application/sms";
import type {
  DeviceEffectiveStatus,
  NumberStatus,
  OrderStatus,
} from "@domain/order-state-machine";

import { hashActorRef } from "./audit-event-repository";
import type { PartnerTransactionClient } from "./client";
import { LEDGER_BUCKET_TO_DB, LEDGER_EVENT_TYPE_TO_DB } from "./ledger-enum-maps";
import { createTenantContext } from "./tenant-context";
import { scopedIdWhere } from "./tenant-scoping";

/**
 * Prisma-backed {@link SmsMatchingGateway} for the SMS ingestion pipeline
 * (task 12.2). Every method runs on the caller-provided transaction handle —
 * the same interactive transaction the task 12.1 SMS insert writes through — so
 * ownership resolution, matching, the `waiting_sms → success` transition, the
 * paired number release, the history rows, the SMS status update, the single
 * pending Earning, and the zero-sum `order-success` ledger event all commit
 * atomically (design section 8; task 13.3). Raw Prisma never leaves this adapter and the
 * raw SMS/OTP plaintext is never read here (only ciphertext is written).
 *
 * Tenant isolation is defense-in-depth: the ownership lookup folds the trusted
 * `partnerId` into its predicate and confirms the number belongs to the device,
 * so a cross-tenant or mismatched pairing is indistinguishable from a missing
 * one (`null`). The success write is a compare-and-set on the order version +
 * source status and the number's `busy` + `currentOrderId` binding, so a
 * concurrent success/timeout is detected and surfaced as
 * {@link SmsSuccessContentionError}.
 */
const ORDER_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerOrderStatus, OrderStatus>> = {
  CREATED: "created",
  RESERVED: "reserved",
  WAITING_SMS: "waiting_sms",
  SUCCESS: "success",
  CANCELLED: "cancelled",
  TIMEOUT: "timeout",
  FAILED: "failed",
};

const NUMBER_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerNumberStatus, NumberStatus>> = {
  OFFLINE: "offline",
  AVAILABLE: "available",
  RESERVED: "reserved",
  BUSY: "busy",
  DISABLED: "disabled",
};

const NUMBER_STATUS_TO_DB: Readonly<Record<NumberStatus, $Enums.PartnerNumberStatus>> = {
  offline: $Enums.PartnerNumberStatus.OFFLINE,
  available: $Enums.PartnerNumberStatus.AVAILABLE,
  reserved: $Enums.PartnerNumberStatus.RESERVED,
  busy: $Enums.PartnerNumberStatus.BUSY,
  disabled: $Enums.PartnerNumberStatus.DISABLED,
};

const DEVICE_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerDeviceStatus, DeviceEffectiveStatus>> = {
  OFFLINE: "offline",
  ONLINE: "online",
  DISABLED: "disabled",
};

const SMS_AUDIT_STATUS_TO_DB: Readonly<Record<SmsAuditMatchStatus, $Enums.SmsMatchStatus>> = {
  unmatched: $Enums.SmsMatchStatus.UNMATCHED,
  ambiguous: $Enums.SmsMatchStatus.AMBIGUOUS,
};

function epochMsOrNull(value: Date | null): number | null {
  return value === null ? null : value.getTime();
}

export class PrismaPartnerSmsMatchingGateway
  implements SmsMatchingGateway<PartnerTransactionClient>
{
  async loadOwnershipContext(
    tx: PartnerTransactionClient,
    partnerId: string,
    deviceId: string,
    numberId: string,
  ): Promise<SmsOwnershipContext | null> {
    const tenant = createTenantContext(partnerId);
    // The number must belong to the trusted tenant *and* the authenticated
    // device; the pure `decideSmsIngress` policy re-checks the same ownership,
    // so a mismatched pairing is opaque here (null).
    const number = await tx.partnerNumber.findFirst({
      where: { ...scopedIdWhere(tenant, numberId), deviceId },
      select: { id: true, partnerId: true, deviceId: true },
    });
    if (number === null) return null;

    const device = await tx.partnerDevice.findFirst({
      where: scopedIdWhere(tenant, deviceId),
      select: { id: true, partnerId: true },
    });
    if (device === null) return null;

    return {
      device: { id: device.id, partnerId: device.partnerId },
      number: { id: number.id, partnerId: number.partnerId, deviceId: number.deviceId },
    };
  }

  async loadActiveConfig(
    tx: PartnerTransactionClient,
  ): Promise<SmsMatchingConfig | null> {
    const config = await tx.platformConfig.findFirst({
      where: { retiredAt: null, activeKey: { not: null } },
      orderBy: { version: "desc" },
      select: { heartbeatTimeoutSeconds: true, earningHoldSeconds: true },
    });
    if (config === null) return null;
    return {
      heartbeatTimeoutSeconds: config.heartbeatTimeoutSeconds,
      earningHoldSeconds: config.earningHoldSeconds,
    };
  }

  async loadActiveOrderCandidates(
    tx: PartnerTransactionClient,
    partnerId: string,
    numberId: string,
  ): Promise<readonly SmsOrderCandidateRow[]> {
    const orders = await tx.partnerOrder.findMany({
      where: {
        partnerId,
        numberId,
        // Orders that still hold this number: one awaiting its first code, or one
        // that already succeeded and has not released its hold yet (listening for
        // a repeat OTP). The pure matcher re-checks the window, so expiry is
        // decided there rather than duplicated in SQL.
        OR: [
          { status: $Enums.PartnerOrderStatus.WAITING_SMS },
          { status: $Enums.PartnerOrderStatus.SUCCESS, completedAt: null },
        ],
      },
      select: {
        id: true,
        numberId: true,
        status: true,
        waitingAt: true,
        createdAt: true,
        expiresAt: true,
        completedAt: true,
        snapshot: { select: { serviceCode: true } },
      },
    });

    return orders.map((order) => ({
      id: order.id,
      numberId: order.numberId,
      status: ORDER_STATUS_FROM_DB[order.status],
      // The `waiting_sms` window opens when the order was activated (waitingAt);
      // a missing activation timestamp falls back to creation. It closes at the
      // order's timeout expiry.
      windowStartsAtMs: (order.waitingAt ?? order.createdAt).getTime(),
      windowEndsAtMs: order.expiresAt.getTime(),
      completedAtMs: epochMsOrNull(order.completedAt),
      serviceCode: order.snapshot?.serviceCode ?? "",
    }));
  }

  async loadSuccessContext(
    tx: PartnerTransactionClient,
    orderId: string,
  ): Promise<OrderSuccessContext | null> {
    const order = await tx.partnerOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        partnerId: true,
        numberId: true,
        version: true,
        status: true,
        otpKeyVersion: true,
        // The authoritative payout is the immutable snapshot value locked at
        // reserve time; it is the exact Earning + ledger amount (task 13.3).
        snapshot: { select: { payoutIdr: true } },
        // Dedupe guard for a retried success: an Earning row already existing
        // means the order was already succeeded (requirement 13.7).
        earning: { select: { id: true } },
        number: {
          select: {
            status: true,
            enabled: true,
            device: { select: { effectiveStatus: true, lastSeenAt: true } },
          },
        },
      },
    });
    if (order === null) return null;
    return {
      orderId: order.id,
      partnerId: order.partnerId,
      numberId: order.numberId,
      version: order.version,
      orderStatus: ORDER_STATUS_FROM_DB[order.status],
      numberStatus: NUMBER_STATUS_FROM_DB[order.number.status],
      // An OTP has been extracted for the order iff its key version is set.
      otpReceived: order.otpKeyVersion !== null,
      numberEnabled: order.number.enabled,
      deviceStatus: DEVICE_STATUS_FROM_DB[order.number.device.effectiveStatus],
      deviceLastSeenAtEpochMs: epochMsOrNull(order.number.device.lastSeenAt),
      payoutIdr: order.snapshot?.payoutIdr ?? 0,
      earningExistsForOrder: order.earning !== null,
    };
  }

  async applySuccess(
    tx: PartnerTransactionClient,
    input: ApplySmsSuccessInput,
  ): Promise<void> {
    const now = new Date(input.nowEpochMs);

    // 1. Store the encrypted OTP and flip the order to SUCCESS, guarded by a
    //    compare-and-set on the version and the WAITING_SMS source status so a
    //    concurrent success/timeout is detected.
    const updatedOrder = await tx.partnerOrder.updateMany({
      where: {
        id: input.orderId,
        partnerId: input.partnerId,
        version: input.expectedOrderVersion,
        status: $Enums.PartnerOrderStatus.WAITING_SMS,
        otpKeyVersion: null,
      },
      data: {
        status: $Enums.PartnerOrderStatus.SUCCESS,
        otpCiphertext: Buffer.from(input.otpCiphertext),
        otpKeyVersion: input.otpKeyVersion,
        otpFingerprint: input.otpFingerprint,
        succeededAt: now,
        // A success is a terminal disposition, so stamp `terminalAt` here the
        // same way `applyTerminalTransition` does for cancel/timeout/fail. The
        // OTP retention job filters terminal orders by `terminalAt <= cutoff`;
        // without this stamp a SUCCESS order would never match and its OTP would
        // persist decrypted past the 24h window (requirement 19.5).
        terminalAt: now,
        version: { increment: 1 },
      },
    });
    if (updatedOrder.count !== 1) throw new SmsSuccessContentionError();

    // 2. Record the order transition (unique operation key keeps it single).
    await tx.orderTransition.create({
      data: {
        orderId: input.orderId,
        fromStatus: $Enums.PartnerOrderStatus.WAITING_SMS,
        toStatus: $Enums.PartnerOrderStatus.SUCCESS,
        actorType: $Enums.AuditActorType.SYSTEM,
        actorRefHash: hashActorRef(input.actorRef),
        reason: "sms_otp_matched",
        operationKey: input.operationKey,
      },
    });

    // 3. Associate the SMS to the order (matched, no re-delivery possible).
    const matchedSms = await tx.partnerSms.updateMany({
      where: { id: input.smsId, matchStatus: $Enums.SmsMatchStatus.PENDING },
      data: {
        matchStatus: $Enums.SmsMatchStatus.MATCHED,
        matchedOrderId: input.orderId,
        extractedAt: now,
      },
    });
    if (matchedSms.count !== 1) throw new SmsSuccessContentionError();

    // 4. Create the single pending Earning and append the zero-sum
    //    `order-success` ledger transaction (payable -> pending) in this same
    //    unit (task 13.3; design section 10). The `orderId` and `eventKey`
    //    unique constraints make a retried success a deterministic no-op rather
    //    than a second Earning / duplicate ledger entries (requirement 13.7).
    await tx.partnerEarning.create({
      data: {
        id: input.earning.id,
        partnerId: input.partnerId,
        orderId: input.orderId,
        amountIdr: input.earning.amountIdr,
        status: $Enums.PartnerEarningStatus.PENDING,
        availableAt: new Date(input.earning.availableAtEpochMs),
      },
    });

    await tx.ledgerTransaction.create({
      data: {
        partnerId: input.partnerId,
        eventType: LEDGER_EVENT_TYPE_TO_DB[input.ledger.eventType],
        eventKey: input.ledger.eventKey,
        referenceType: input.ledger.referenceType,
        referenceId: input.ledger.referenceId,
        entries: {
          // partnerId is derived from the parent transaction's composite
          // relation (fields: [transactionId, partnerId]); passing it here is
          // rejected by Prisma at runtime (see ledger-repository.appendTransaction).
          create: input.ledger.entries.map((entry) => ({
            bucket: LEDGER_BUCKET_TO_DB[entry.bucket],
            amountIdrSigned: entry.amountIdrSigned,
          })),
        },
      },
    });

    if (!input.numberChanged) return;

    // 5. Release the number (busy -> available|offline) and unbind it from the
    //    order, then record the number state history.
    const released = await tx.partnerNumber.updateMany({
      where: {
        id: input.numberId,
        partnerId: input.partnerId,
        status: NUMBER_STATUS_TO_DB[input.fromNumberStatus],
        currentOrderId: input.orderId,
      },
      data: {
        status: NUMBER_STATUS_TO_DB[input.toNumberStatus],
        currentOrderId: null,
      },
    });
    if (released.count !== 1) throw new SmsSuccessContentionError();

    await tx.numberStateHistory.create({
      data: {
        numberId: input.numberId,
        fromStatus: NUMBER_STATUS_TO_DB[input.fromNumberStatus],
        toStatus: NUMBER_STATUS_TO_DB[input.toNumberStatus],
        actorType: $Enums.AuditActorType.SYSTEM,
        actorRefHash: hashActorRef(input.actorRef),
        reason: "sms_otp_matched",
        operationKey: `${input.operationKey}:number`,
      },
    });
  }

  async loadRepeatOtpContext(
    tx: PartnerTransactionClient,
    orderId: string,
  ): Promise<OrderRepeatOtpContext | null> {
    const order = await tx.partnerOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        partnerId: true,
        numberId: true,
        version: true,
        status: true,
        completedAt: true,
        expiresAt: true,
      },
    });
    if (order === null) return null;
    return {
      orderId: order.id,
      partnerId: order.partnerId,
      numberId: order.numberId,
      version: order.version,
      orderStatus: ORDER_STATUS_FROM_DB[order.status],
      completedAtEpochMs: epochMsOrNull(order.completedAt),
      expiresAtEpochMs: order.expiresAt.getTime(),
    };
  }

  async applyRepeatOtp(
    tx: PartnerTransactionClient,
    input: ApplySmsRepeatOtpInput,
  ): Promise<void> {
    const now = new Date(input.nowEpochMs);

    // 1. Overwrite the order's OTP with the newer code. The compare-and-set pins
    //    the version AND the listening predicate (still SUCCESS, hold not yet
    //    released), so a concurrent completion or expiry sweep wins the race and
    //    this repeat is rejected rather than reviving a closed window. The
    //    previous code stays recoverable: every SMS row keeps its own ciphertext.
    const updatedOrder = await tx.partnerOrder.updateMany({
      where: {
        id: input.orderId,
        partnerId: input.partnerId,
        version: input.expectedOrderVersion,
        status: $Enums.PartnerOrderStatus.SUCCESS,
        completedAt: null,
      },
      data: {
        otpCiphertext: Buffer.from(input.otpCiphertext),
        otpKeyVersion: input.otpKeyVersion,
        otpFingerprint: input.otpFingerprint,
        version: { increment: 1 },
      },
    });
    if (updatedOrder.count !== 1) throw new SmsSuccessContentionError();

    // 2. Associate this SMS with the same order. No order transition row is
    //    written: the order's status did not change, and `order_transitions` is
    //    keyed on a status edge.
    const matchedSms = await tx.partnerSms.updateMany({
      where: { id: input.smsId, matchStatus: $Enums.SmsMatchStatus.PENDING },
      data: {
        matchStatus: $Enums.SmsMatchStatus.MATCHED,
        matchedOrderId: input.orderId,
        extractedAt: now,
      },
    });
    if (matchedSms.count !== 1) throw new SmsSuccessContentionError();
  }

  async markSmsAudited(
    tx: PartnerTransactionClient,
    input: Readonly<{ smsId: string; matchStatus: SmsAuditMatchStatus; nowEpochMs: number }>,
  ): Promise<void> {
    // Audit-only status change: never associates an OTP with any order
    // (requirement 11.5). Guarded to the PENDING row so it is applied once.
    await tx.partnerSms.updateMany({
      where: { id: input.smsId, matchStatus: $Enums.SmsMatchStatus.PENDING },
      data: { matchStatus: SMS_AUDIT_STATUS_TO_DB[input.matchStatus] },
    });
  }
}
