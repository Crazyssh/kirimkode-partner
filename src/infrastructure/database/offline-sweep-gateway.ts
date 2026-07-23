import { $Enums, Prisma, type PrismaClient } from "@/generated/prisma";

import type {
  IdleNumberRow,
  NumberOfflineChange,
  OfflineSweepGateway,
  OfflineSweepTransaction,
  StaleDeviceRow,
} from "@application/cron-jobs";
import type { NumberStatus } from "@domain/order-state-machine";

import { hashActorRef } from "./audit-event-repository";
import type { PartnerTransactionClient } from "./client";

const NUMBER_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerNumberStatus, NumberStatus>> = {
  OFFLINE: "offline",
  AVAILABLE: "available",
  RESERVED: "reserved",
  BUSY: "busy",
  DISABLED: "disabled",
};

/**
 * Prisma-backed persistence for the `offline-sweep` job (task 16.2).
 *
 * A job lease is platform-global (task 16.1), so — like the reservation and
 * order-operations gateways — this adapter binds to the raw Prisma client
 * rather than a `TenantContext`; the sweep intentionally spans every tenant's
 * stale devices. Raw Prisma never leaves this module.
 *
 * Stale devices are row-locked with `SELECT ... FOR UPDATE SKIP LOCKED` so the
 * sweep never contends with a concurrent heartbeat, and every write is a
 * compare-and-set on the source status: the device flip matches only while it
 * is still `online`, and each number flip matches only while it is still
 * `available`. A re-run after a crash therefore finds the work already done and
 * is a no-op (requirement 20.2). Only `available` numbers are propagated, so a
 * `reserved`/`busy` number backing an active order is never touched
 * (requirement 12.5).
 */
export class PrismaOfflineSweepGateway implements OfflineSweepGateway {
  private readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
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
    work: (tx: OfflineSweepTransaction) => Promise<T>,
  ): Promise<T> {
    return this.client.$transaction((tx) =>
      work(new PrismaOfflineSweepTransaction(tx)),
    );
  }
}

class PrismaOfflineSweepTransaction implements OfflineSweepTransaction {
  private readonly tx: PartnerTransactionClient;

  constructor(tx: PartnerTransactionClient) {
    this.tx = tx;
  }

  async lockStaleOnlineDevices(input: {
    readonly nowEpochMs: number;
    readonly timeoutMs: number;
    readonly limit: number;
    readonly afterId: string | null;
  }): Promise<readonly StaleDeviceRow[]> {
    const staleBefore = new Date(input.nowEpochMs - input.timeoutMs);
    const afterFilter =
      input.afterId === null
        ? Prisma.empty
        : Prisma.sql`AND "id" > ${input.afterId}::uuid`;

    const rows = await this.tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id"
      FROM partner_devices
      WHERE "effectiveStatus"::text = 'online'
        AND ("lastSeenAt" IS NULL OR "lastSeenAt" <= ${staleBefore})
        ${afterFilter}
      ORDER BY "id" ASC
      LIMIT ${input.limit}
      FOR UPDATE SKIP LOCKED
    `);
    return rows.map((row) => ({ id: row.id }));
  }

  async markDeviceOffline(deviceId: string): Promise<boolean> {
    const updated = await this.tx.partnerDevice.updateMany({
      where: { id: deviceId, effectiveStatus: $Enums.PartnerDeviceStatus.ONLINE },
      data: { effectiveStatus: $Enums.PartnerDeviceStatus.OFFLINE },
    });
    return updated.count === 1;
  }

  async listIdleAvailableNumbers(deviceId: string): Promise<readonly IdleNumberRow[]> {
    const numbers = await this.tx.partnerNumber.findMany({
      where: { deviceId, status: $Enums.PartnerNumberStatus.AVAILABLE },
      select: { id: true, status: true },
    });
    return numbers.map((number) => ({
      id: number.id,
      status: NUMBER_STATUS_FROM_DB[number.status],
    }));
  }

  async applyNumberOffline(change: NumberOfflineChange): Promise<boolean> {
    // Compare-and-set `available → offline`: only an idle number is taken
    // offline, and only once (a re-run finds it already offline).
    const released = await this.tx.partnerNumber.updateMany({
      where: { id: change.numberId, status: $Enums.PartnerNumberStatus.AVAILABLE },
      data: { status: $Enums.PartnerNumberStatus.OFFLINE },
    });
    if (released.count !== 1) return false;

    await this.tx.numberStateHistory.create({
      data: {
        id: change.historyId,
        numberId: change.numberId,
        fromStatus: $Enums.PartnerNumberStatus.AVAILABLE,
        toStatus: $Enums.PartnerNumberStatus.OFFLINE,
        actorType: $Enums.AuditActorType.CRON,
        actorRefHash: hashActorRef(change.actorRef),
        reason: change.reason,
        createdAt: new Date(change.occurredAtEpochMs),
      },
    });
    return true;
  }
}
