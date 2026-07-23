import { $Enums, Prisma, type PrismaClient } from "@/generated/prisma";

import type {
  PromoteReservationInput,
  ReleaseReservationInput,
  ReservationRecoveryGateway,
  ReservationRecoveryTransaction,
  StuckReservationContext,
} from "@application/cron-jobs";
import type {
  DeviceEffectiveStatus,
  NumberStatus,
} from "@domain/order-state-machine";

import { hashActorRef } from "./audit-event-repository";
import type { PartnerTransactionClient } from "./client";

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

/** The CAS terminal/promotion write matched no row (a concurrent change). */
class ReservationRecoveryContentionError extends Error {
  constructor() {
    super("A stuck reservation changed state during recovery");
    this.name = "ReservationRecoveryContentionError";
  }
}

/**
 * Prisma-backed persistence for the `reservation-recovery` job (task 16.2).
 *
 * A job lease is platform-global (task 16.1), so this adapter binds to the raw
 * Prisma client rather than a `TenantContext`; recovery spans every tenant's
 * stranded reservations. Raw Prisma never leaves this module.
 *
 * Stuck reservations are row-locked with `SELECT ... FOR UPDATE SKIP LOCKED`,
 * and the promotion/release writes are compare-and-set on the order version +
 * source statuses, so the recovery is idempotent under a crash re-run and can
 * never relocate an active order (requirements 12.5, 20.2). Both the order
 * transition and the paired number transition, plus their history rows, commit
 * atomically per item.
 */
export class PrismaReservationRecoveryGateway
  implements ReservationRecoveryGateway
{
  private readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  async loadReservationRecoverySeconds(): Promise<number | null> {
    const config = await this.client.platformConfig.findFirst({
      where: { retiredAt: null, activeKey: { not: null } },
      orderBy: { version: "desc" },
      select: { reservationRecoverySeconds: true },
    });
    return config?.reservationRecoverySeconds ?? null;
  }

  async loadHeartbeatTimeoutSeconds(): Promise<number | null> {
    const config = await this.client.platformConfig.findFirst({
      where: { retiredAt: null, activeKey: { not: null } },
      orderBy: { version: "desc" },
      select: { heartbeatTimeoutSeconds: true },
    });
    return config?.heartbeatTimeoutSeconds ?? null;
  }

  runInTransaction<T>(
    work: (tx: ReservationRecoveryTransaction) => Promise<T>,
  ): Promise<T> {
    return this.client.$transaction((tx) =>
      work(new PrismaReservationRecoveryTransaction(tx)),
    );
  }
}

class PrismaReservationRecoveryTransaction
  implements ReservationRecoveryTransaction
{
  private readonly tx: PartnerTransactionClient;

  constructor(tx: PartnerTransactionClient) {
    this.tx = tx;
  }

  async lockStuckReservations(input: {
    readonly staleBeforeEpochMs: number;
    readonly limit: number;
    readonly afterId: string | null;
  }): Promise<readonly StuckReservationContext[]> {
    const staleBefore = new Date(input.staleBeforeEpochMs);
    const afterFilter =
      input.afterId === null
        ? Prisma.empty
        : Prisma.sql`AND "id" > ${input.afterId}::uuid`;

    // Row-lock the stranded reservations; SKIP LOCKED avoids contending with a
    // concurrent Internal API cancel/timeout on the same order.
    const locked = await this.tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id"
      FROM partner_orders
      WHERE "status"::text = 'reserved'
        AND "reservedAt" IS NOT NULL
        AND "reservedAt" <= ${staleBefore}
        ${afterFilter}
      ORDER BY "id" ASC
      LIMIT ${input.limit}
      FOR UPDATE SKIP LOCKED
    `);
    if (locked.length === 0) return [];
    const lockedIds = locked.map((row) => row.id);

    const orders = await this.tx.partnerOrder.findMany({
      where: { id: { in: lockedIds }, status: $Enums.PartnerOrderStatus.RESERVED },
      select: {
        id: true,
        partnerId: true,
        numberId: true,
        version: true,
        offer: { select: { status: true } },
        number: {
          select: {
            status: true,
            enabled: true,
            currentOrderId: true,
            device: { select: { effectiveStatus: true, lastSeenAt: true } },
          },
        },
      },
      orderBy: { id: "asc" },
    });

    return orders.map((order) => ({
      orderId: order.id,
      partnerId: order.partnerId,
      numberId: order.numberId,
      version: order.version,
      numberStatus: NUMBER_STATUS_FROM_DB[order.number.status],
      numberBound: order.number.currentOrderId === order.id,
      numberEnabled: order.number.enabled,
      hasActiveOffer: order.offer.status === $Enums.PartnerOfferStatus.ACTIVE,
      deviceStatus: DEVICE_STATUS_FROM_DB[order.number.device.effectiveStatus],
      deviceLastSeenAtEpochMs:
        order.number.device.lastSeenAt === null
          ? null
          : order.number.device.lastSeenAt.getTime(),
    }));
  }

  async promote(input: PromoteReservationInput): Promise<void> {
    const now = new Date(input.nowEpochMs);

    const order = await this.tx.partnerOrder.updateMany({
      where: {
        id: input.orderId,
        partnerId: input.partnerId,
        version: input.expectedVersion,
        status: $Enums.PartnerOrderStatus.RESERVED,
      },
      data: {
        status: $Enums.PartnerOrderStatus.WAITING_SMS,
        waitingAt: now,
        version: { increment: 1 },
      },
    });
    if (order.count !== 1) throw new ReservationRecoveryContentionError();

    const number = await this.tx.partnerNumber.updateMany({
      where: {
        id: input.numberId,
        partnerId: input.partnerId,
        status: $Enums.PartnerNumberStatus.RESERVED,
        currentOrderId: input.orderId,
      },
      data: { status: $Enums.PartnerNumberStatus.BUSY },
    });
    if (number.count !== 1) throw new ReservationRecoveryContentionError();

    await this.writeHistory(input, {
      fromOrder: $Enums.PartnerOrderStatus.RESERVED,
      toOrder: $Enums.PartnerOrderStatus.WAITING_SMS,
      fromNumber: $Enums.PartnerNumberStatus.RESERVED,
      toNumber: $Enums.PartnerNumberStatus.BUSY,
      numberChanged: true,
    });
  }

  async release(input: ReleaseReservationInput): Promise<void> {
    const now = new Date(input.nowEpochMs);

    const order = await this.tx.partnerOrder.updateMany({
      where: {
        id: input.orderId,
        partnerId: input.partnerId,
        version: input.expectedVersion,
        status: $Enums.PartnerOrderStatus.RESERVED,
      },
      data: {
        status: $Enums.PartnerOrderStatus.CANCELLED,
        terminalReason: input.reason,
        terminalAt: now,
        version: { increment: 1 },
      },
    });
    if (order.count !== 1) throw new ReservationRecoveryContentionError();

    if (input.numberChanged) {
      const released = await this.tx.partnerNumber.updateMany({
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
      if (released.count !== 1) throw new ReservationRecoveryContentionError();
    }

    await this.writeHistory(
      { ...input },
      {
        fromOrder: $Enums.PartnerOrderStatus.RESERVED,
        toOrder: $Enums.PartnerOrderStatus.CANCELLED,
        fromNumber: NUMBER_STATUS_TO_DB[input.fromNumberStatus],
        toNumber: NUMBER_STATUS_TO_DB[input.toNumberStatus],
        numberChanged: input.numberChanged,
      },
    );
  }

  /** Append the order + (optional) number state history for one recovery. */
  private async writeHistory(
    input: {
      readonly orderId: string;
      readonly numberId: string;
      readonly actorRef: string;
      readonly reason: string;
      readonly operationKey: string;
    },
    steps: {
      readonly fromOrder: $Enums.PartnerOrderStatus;
      readonly toOrder: $Enums.PartnerOrderStatus;
      readonly fromNumber: $Enums.PartnerNumberStatus;
      readonly toNumber: $Enums.PartnerNumberStatus;
      readonly numberChanged: boolean;
    },
  ): Promise<void> {
    const actorRefHash = hashActorRef(input.actorRef);
    await this.tx.orderTransition.create({
      data: {
        orderId: input.orderId,
        fromStatus: steps.fromOrder,
        toStatus: steps.toOrder,
        actorType: $Enums.AuditActorType.CRON,
        actorRefHash,
        reason: input.reason,
        operationKey: input.operationKey,
      },
    });
    if (!steps.numberChanged) return;
    await this.tx.numberStateHistory.create({
      data: {
        numberId: input.numberId,
        fromStatus: steps.fromNumber,
        toStatus: steps.toNumber,
        actorType: $Enums.AuditActorType.CRON,
        actorRefHash,
        reason: input.reason,
        operationKey: `${input.operationKey}:number`,
      },
    });
  }
}
