import { $Enums } from "@/generated/prisma";

import type {
  ApplyListeningHoldReleaseInput,
  ApplyTerminalTransitionInput,
  OrderDetail,
  OrderOperationsConfig,
  OrderReconciliationGateway,
  OrderStatusGateway,
  OrderTransitionContext,
  OrderTransitionGateway,
  ReconciliationStatusEntry,
} from "@application/orders";
import { TerminalTransitionContentionError } from "@application/orders";
import type {
  DeviceEffectiveStatus,
  NumberStatus,
  OrderStatus,
} from "@domain/order-state-machine";

import { hashActorRef } from "./audit-event-repository";
import type { PartnerDatabaseExecutor, PartnerTransactionClient } from "./client";

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

const TERMINAL_ORDER_STATUS_TO_DB: Readonly<
  Record<"cancelled" | "timeout" | "failed", $Enums.PartnerOrderStatus>
> = {
  cancelled: $Enums.PartnerOrderStatus.CANCELLED,
  timeout: $Enums.PartnerOrderStatus.TIMEOUT,
  failed: $Enums.PartnerOrderStatus.FAILED,
};

const ORDER_STATUS_TO_DB: Readonly<Record<OrderStatus, $Enums.PartnerOrderStatus>> = {
  created: $Enums.PartnerOrderStatus.CREATED,
  reserved: $Enums.PartnerOrderStatus.RESERVED,
  waiting_sms: $Enums.PartnerOrderStatus.WAITING_SMS,
  success: $Enums.PartnerOrderStatus.SUCCESS,
  cancelled: $Enums.PartnerOrderStatus.CANCELLED,
  timeout: $Enums.PartnerOrderStatus.TIMEOUT,
  failed: $Enums.PartnerOrderStatus.FAILED,
};

function epochMsOrNull(value: Date | null): number | null {
  return value === null ? null : value.getTime();
}

/**
 * Prisma-backed persistence for the Internal API v1 order operations built in
 * task 9.4: status/OTP lookup, cancel/timeout terminal transitions, and batch
 * reconciliation. Unlike the tenant-scoped repositories (task 7.1), the
 * Internal API is authenticated by a service principal (the Main Platform), so
 * an order is resolved by its opaque UUID across all partners — exactly like
 * the task 9.3 reservation gateway. Raw Prisma never leaves this adapter, and
 * the raw SMS ciphertext is never read by any of these methods (only the
 * order's own encrypted OTP is loaded, for the status endpoint).
 *
 * The transition methods run on the caller-provided transaction handle — the
 * same interactive transaction the task 9.2 idempotency engine uses — so the
 * terminal order write, the paired number release, the history rows, and the
 * idempotency record all commit atomically (design section 4).
 */
export class PrismaOrderOperationsGateway
  implements
    OrderStatusGateway,
    OrderTransitionGateway<PartnerTransactionClient>,
    OrderReconciliationGateway<PartnerTransactionClient>
{
  private readonly executor: PartnerDatabaseExecutor;

  constructor(executor: PartnerDatabaseExecutor) {
    this.executor = executor;
  }

  async loadOrderDetail(orderId: string): Promise<OrderDetail | null> {
    const order = await this.executor.partnerOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        terminalReason: true,
        otpCiphertext: true,
        otpKeyVersion: true,
        createdAt: true,
        reservedAt: true,
        waitingAt: true,
        succeededAt: true,
        terminalAt: true,
        expiresAt: true,
      },
    });
    if (order === null) return null;
    return {
      orderId: order.id,
      status: ORDER_STATUS_FROM_DB[order.status],
      terminalReason: order.terminalReason,
      otpCiphertext:
        order.otpCiphertext === null ? null : Uint8Array.from(order.otpCiphertext),
      otpKeyVersion: order.otpKeyVersion,
      createdAtEpochMs: order.createdAt.getTime(),
      reservedAtEpochMs: epochMsOrNull(order.reservedAt),
      waitingAtEpochMs: epochMsOrNull(order.waitingAt),
      succeededAtEpochMs: epochMsOrNull(order.succeededAt),
      terminalAtEpochMs: epochMsOrNull(order.terminalAt),
      expiresAtEpochMs: order.expiresAt.getTime(),
    };
  }

  async loadActiveConfig(
    tx: PartnerTransactionClient,
  ): Promise<OrderOperationsConfig | null> {
    const config = await tx.platformConfig.findFirst({
      where: { retiredAt: null, activeKey: { not: null } },
      orderBy: { version: "desc" },
      select: { heartbeatTimeoutSeconds: true, cancelMinimumSeconds: true },
    });
    if (config === null) return null;
    return {
      heartbeatTimeoutSeconds: config.heartbeatTimeoutSeconds,
      cancelMinimumSeconds: config.cancelMinimumSeconds,
    };
  }

  async loadTransitionContext(
    tx: PartnerTransactionClient,
    orderId: string,
  ): Promise<OrderTransitionContext | null> {
    const order = await tx.partnerOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        partnerId: true,
        numberId: true,
        version: true,
        status: true,
        otpKeyVersion: true,
        createdAt: true,
        expiresAt: true,
        completedAt: true,
        number: {
          select: {
            status: true,
            enabled: true,
            currentOrderId: true,
            device: {
              select: { effectiveStatus: true, lastSeenAt: true },
            },
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
      createdAtEpochMs: order.createdAt.getTime(),
      expiresAtEpochMs: order.expiresAt.getTime(),
      numberEnabled: order.number.enabled,
      deviceStatus: DEVICE_STATUS_FROM_DB[order.number.device.effectiveStatus],
      deviceLastSeenAtEpochMs: epochMsOrNull(order.number.device.lastSeenAt),
      completedAtEpochMs: epochMsOrNull(order.completedAt),
      numberCurrentOrderId: order.number.currentOrderId,
    };
  }

  async applyTerminalTransition(
    tx: PartnerTransactionClient,
    input: ApplyTerminalTransitionInput,
  ): Promise<void> {
    const now = new Date(input.nowEpochMs);

    // 1. Terminal order write, guarded by a compare-and-set on the version and
    //    the expected source status so a concurrent change is detected. The
    //    source may be `reserved`/`waiting_sms` (cancel/timeout) or, for a
    //    `failed` disposition, `created`/`waiting_sms`.
    const fromOrderStatusDb = ORDER_STATUS_TO_DB[input.fromOrderStatus];
    const updated = await tx.partnerOrder.updateMany({
      where: {
        id: input.orderId,
        partnerId: input.partnerId,
        version: input.expectedVersion,
        status: { equals: fromOrderStatusDb },
      },
      data: {
        status: TERMINAL_ORDER_STATUS_TO_DB[input.toOrderStatus],
        terminalReason: input.terminalReason,
        terminalAt: now,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new TerminalTransitionContentionError();

    // 2. Record the order transition (unique operation key keeps it single).
    await tx.orderTransition.create({
      data: {
        orderId: input.orderId,
        fromStatus: fromOrderStatusDb,
        toStatus: TERMINAL_ORDER_STATUS_TO_DB[input.toOrderStatus],
        actorType: $Enums.AuditActorType.SYSTEM,
        actorRefHash: hashActorRef(input.actorRef),
        reason: input.terminalReason,
        operationKey: input.operationKey,
      },
    });

    if (!input.numberChanged) return;

    // 3. Release the number (busy/reserved -> available|offline) and unbind it
    //    from the order, then record the number state history.
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
    if (released.count !== 1) throw new TerminalTransitionContentionError();

    await tx.numberStateHistory.create({
      data: {
        numberId: input.numberId,
        fromStatus: NUMBER_STATUS_TO_DB[input.fromNumberStatus],
        toStatus: NUMBER_STATUS_TO_DB[input.toNumberStatus],
        actorType: $Enums.AuditActorType.SYSTEM,
        actorRefHash: hashActorRef(input.actorRef),
        reason: input.terminalReason,
        operationKey: `${input.operationKey}:number`,
      },
    });
  }

  async applyListeningHoldRelease(
    tx: PartnerTransactionClient,
    input: ApplyListeningHoldReleaseInput,
  ): Promise<void> {
    const completedAt = new Date(input.completedAtEpochMs);

    // 1. Stamp the completion, guarded by a compare-and-set on the version and on
    //    the hold still being unreleased. The order's status is NOT touched: it
    //    already settled as `success` and completion moves no money.
    const updated = await tx.partnerOrder.updateMany({
      where: {
        id: input.orderId,
        partnerId: input.partnerId,
        version: input.expectedVersion,
        status: $Enums.PartnerOrderStatus.SUCCESS,
        completedAt: null,
      },
      data: { completedAt, version: { increment: 1 } },
    });
    if (updated.count !== 1) throw new TerminalTransitionContentionError();

    // No order transition row: `order_transitions` records a status edge, and
    // completion deliberately leaves the status alone. The number history below
    // is the audit trail for the release itself.
    if (!input.numberChanged) return;

    // 2. Release the number and unbind it. Pinning `currentOrderId` to this order
    //    means a number already handed to another order is never stolen back.
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
    if (released.count !== 1) throw new TerminalTransitionContentionError();

    await tx.numberStateHistory.create({
      data: {
        numberId: input.numberId,
        fromStatus: NUMBER_STATUS_TO_DB[input.fromNumberStatus],
        toStatus: NUMBER_STATUS_TO_DB[input.toNumberStatus],
        actorType: $Enums.AuditActorType.SYSTEM,
        actorRefHash: hashActorRef(input.actorRef),
        reason: input.reason,
        operationKey: `${input.operationKey}:number`,
      },
    });
  }

  async loadOrderStatuses(
    tx: PartnerTransactionClient,
    refs: readonly string[],
  ): Promise<readonly ReconciliationStatusEntry[]> {
    // Only well-formed UUIDs can match a partner order id; anything else is a
    // deterministic "not found" rather than a query error.
    const validRefs = refs.filter(isUuid);
    const orders =
      validRefs.length === 0
        ? []
        : await tx.partnerOrder.findMany({
            where: { id: { in: [...validRefs] } },
            select: { id: true, status: true, terminalReason: true },
          });
    const byId = new Map(orders.map((order) => [order.id, order]));

    return refs.map((ref) => {
      const order = byId.get(ref);
      if (order === undefined) {
        return { ref, found: false, status: null, terminalReason: null };
      }
      return {
        ref,
        found: true,
        status: ORDER_STATUS_FROM_DB[order.status],
        terminalReason: order.terminalReason,
      };
    });
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
