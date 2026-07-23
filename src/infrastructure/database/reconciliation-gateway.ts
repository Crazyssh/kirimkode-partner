import { $Enums, type PrismaClient } from "@/generated/prisma";

import type {
  PartnerReconciliationState,
  PersistedFinding,
  ReconciliationGateway,
  ReconciliationRecordResult,
} from "@application/cron-jobs";
import type { IdGenerator } from "@application/ledger";
import type { LedgerBucket } from "@domain/task-5-6";

import { CryptoIdGenerator } from "@infrastructure/auth/system-clock";

import type { PartnerTransactionClient } from "./client";
import { LEDGER_BUCKET_FROM_DB } from "./ledger-enum-maps";
import { PrismaReconciliationIssueRepository } from "./reconciliation-issue-repository";

/** Persisted ledger event type → the string the reconciler surfaces in details. */
const LEDGER_EVENT_TYPE_FROM_DB: Readonly<Record<$Enums.LedgerEventType, string>> = {
  ORDER_SUCCESS: "order-success",
  HOLD_RELEASE: "hold-release",
  EARNING_REVERSAL: "earning-reversal",
  PAYOUT_LOCK: "payout-lock",
  PAYOUT_UNLOCK: "payout-unlock",
  PAYOUT_PAID: "payout-paid",
  MANUAL_ADJUSTMENT: "manual-adjustment",
};

const NUMBER_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerNumberStatus, string>> = {
  OFFLINE: "offline",
  AVAILABLE: "available",
  RESERVED: "reserved",
  BUSY: "busy",
  DISABLED: "disabled",
};

const ORDER_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerOrderStatus, string>> = {
  CREATED: "created",
  RESERVED: "reserved",
  WAITING_SMS: "waiting_sms",
  SUCCESS: "success",
  CANCELLED: "cancelled",
  TIMEOUT: "timeout",
  FAILED: "failed",
};

const DEVICE_STATUS_FROM_DB: Readonly<
  Record<$Enums.PartnerDeviceStatus, "online" | "offline" | "disabled">
> = {
  ONLINE: "online",
  OFFLINE: "offline",
  DISABLED: "disabled",
};

/**
 * The persisted `PartnerEarning` status → the ledger bucket its amount should
 * contribute to in the projection. Comparing the sum per bucket against the
 * ledger-derived bucket sums surfaces projection drift (design section 10). The
 * `platform_partner_payable` bucket is intentionally absent — the earning
 * projection does not track it, so it is left uncompared.
 */
const EARNING_STATUS_TO_BUCKET: Readonly<
  Record<$Enums.PartnerEarningStatus, LedgerBucket>
> = {
  PENDING: "partner_pending",
  AVAILABLE: "partner_available",
  REQUESTED: "partner_payout_locked",
  PAID: "partner_paid",
  REVERSED: "partner_reversed",
};

/** Active (number-holding) order statuses used to pair orders and numbers. */
const ACTIVE_ORDER_STATUSES: readonly $Enums.PartnerOrderStatus[] = [
  $Enums.PartnerOrderStatus.RESERVED,
  $Enums.PartnerOrderStatus.WAITING_SMS,
];

/**
 * Prisma-backed read + record gateway for the `reconcile` job (task 16.4).
 *
 * A job lease is platform-global (task 16.1), so this adapter binds to the raw
 * Prisma client rather than a `TenantContext` and scans every tenant. It pages
 * partners by id, assembles each tenant's financial + operational projection
 * for the pure {@link import("@domain/task-16-4").reconcilePartner} detector,
 * and persists the classified findings through the shared
 * {@link PrismaReconciliationIssueRepository}, whose open-issue dedupe makes a
 * re-run record nothing new (requirement 20.2). The reconciler only reads state
 * and records issues — it never repairs money (requirement 20.6). Raw Prisma
 * never leaves this module.
 */
export class PrismaReconciliationGateway implements ReconciliationGateway {
  private readonly client: PrismaClient;
  private readonly issues: PrismaReconciliationIssueRepository;
  private readonly idGenerator: IdGenerator;

  constructor(client: PrismaClient, idGenerator: IdGenerator = new CryptoIdGenerator()) {
    this.client = client;
    this.issues = new PrismaReconciliationIssueRepository();
    this.idGenerator = idGenerator;
  }

  async loadHeartbeatTimeoutSeconds(): Promise<number | null> {
    const config = await this.client.platformConfig.findFirst({
      where: { retiredAt: null, activeKey: { not: null } },
      orderBy: { version: "desc" },
      select: { heartbeatTimeoutSeconds: true },
    });
    return config?.heartbeatTimeoutSeconds ?? null;
  }

  async listPartnerIds(input: {
    readonly limit: number;
    readonly afterId: string | null;
  }): Promise<readonly string[]> {
    const partners = await this.client.partner.findMany({
      where: input.afterId === null ? {} : { id: { gt: input.afterId } },
      select: { id: true },
      orderBy: { id: "asc" },
      take: input.limit,
    });
    return partners.map((partner) => partner.id);
  }

  async loadPartnerState(partnerId: string): Promise<PartnerReconciliationState> {
    const [
      ledgerRows,
      earningRows,
      snapshotRows,
      payoutRows,
      numberRows,
      activeOrderRows,
      deviceRows,
    ] = await Promise.all([
      this.client.ledgerTransaction.findMany({
        where: { partnerId },
        select: {
          eventType: true,
          eventKey: true,
          referenceType: true,
          referenceId: true,
          entries: { select: { bucket: true, amountIdrSigned: true } },
        },
      }),
      this.client.partnerEarning.findMany({
        where: { partnerId },
        select: { id: true, orderId: true, amountIdr: true, status: true },
      }),
      this.client.orderSnapshot.findMany({
        where: { order: { partnerId } },
        select: { orderId: true, payoutIdr: true },
      }),
      this.client.partnerPayout.findMany({
        where: { partnerId },
        select: {
          id: true,
          amountIdr: true,
          allocations: { select: { earningId: true, amountIdr: true } },
        },
      }),
      this.client.partnerNumber.findMany({
        where: { partnerId },
        select: { id: true, status: true },
      }),
      this.client.partnerOrder.findMany({
        where: { partnerId, status: { in: [...ACTIVE_ORDER_STATUSES] } },
        select: { id: true, numberId: true, status: true },
      }),
      this.client.partnerDevice.findMany({
        where: { partnerId },
        select: { id: true, effectiveStatus: true, lastSeenAt: true },
      }),
    ]);

    // Group active orders by the number they hold, for both the number-centric
    // checks and the order/number pairing check.
    const activeByNumber = new Map<string, string[]>();
    for (const order of activeOrderRows) {
      const list = activeByNumber.get(order.numberId) ?? [];
      list.push(order.id);
      activeByNumber.set(order.numberId, list);
    }
    const numberStatusById = new Map<string, string>();
    for (const number of numberRows) {
      numberStatusById.set(number.id, NUMBER_STATUS_FROM_DB[number.status]);
    }

    // Projection bucket sums derived from the Earning projection statuses.
    const projectionBalances: Partial<Record<LedgerBucket, number>> = {
      partner_pending: 0,
      partner_available: 0,
      partner_payout_locked: 0,
      partner_paid: 0,
      partner_reversed: 0,
    };
    for (const earning of earningRows) {
      const bucket = EARNING_STATUS_TO_BUCKET[earning.status];
      projectionBalances[bucket] = (projectionBalances[bucket] ?? 0) + earning.amountIdr;
    }

    return {
      ledgerTransactions: ledgerRows.map((row) => ({
        eventType: LEDGER_EVENT_TYPE_FROM_DB[row.eventType],
        eventKey: row.eventKey,
        referenceType: row.referenceType,
        referenceId: row.referenceId,
        entries: row.entries.map((entry) => ({
          bucket: LEDGER_BUCKET_FROM_DB[entry.bucket],
          amountIdrSigned: entry.amountIdrSigned,
        })),
      })),
      earnings: earningRows.map((earning) => ({
        id: earning.id,
        orderId: earning.orderId,
        amountIdr: earning.amountIdr,
        status: earning.status.toLowerCase(),
      })),
      orderSnapshots: snapshotRows.map((snapshot) => ({
        orderId: snapshot.orderId,
        payoutIdr: snapshot.payoutIdr,
      })),
      payouts: payoutRows.map((payout) => ({
        id: payout.id,
        amountIdr: payout.amountIdr,
        allocations: payout.allocations.map((allocation) => ({
          earningId: allocation.earningId,
          amountIdr: allocation.amountIdr,
        })),
      })),
      projectionBalances,
      orderNumberPairs: activeOrderRows.map((order) => ({
        orderId: order.id,
        orderStatus: ORDER_STATUS_FROM_DB[order.status],
        numberId: order.numberId,
        numberStatus: numberStatusById.get(order.numberId) ?? "offline",
      })),
      numbers: numberRows.map((number) => ({
        numberId: number.id,
        status: NUMBER_STATUS_FROM_DB[number.status],
        activeOrderIds: activeByNumber.get(number.id) ?? [],
      })),
      devices: deviceRows.map((device) => ({
        id: device.id,
        effectiveStatus: DEVICE_STATUS_FROM_DB[device.effectiveStatus],
        lastSeenAtEpochMs: device.lastSeenAt?.getTime() ?? 0,
      })),
    };
  }

  async recordIssues(input: {
    readonly partnerId: string;
    readonly findings: readonly PersistedFinding[];
  }): Promise<ReconciliationRecordResult> {
    if (input.findings.length === 0) {
      return { recorded: 0, duplicates: 0 };
    }

    return this.client.$transaction(async (tx: PartnerTransactionClient) => {
      let recorded = 0;
      let duplicates = 0;
      for (const finding of input.findings) {
        const result = await this.issues.recordIssue(tx, {
          id: this.idGenerator.uuid(),
          partnerId: input.partnerId,
          type: finding.type,
          referenceId: finding.referenceId,
          severity: finding.severity,
          detailsSafeJson: finding.detailsSafeJson,
        });
        if (result.outcome === "recorded") {
          recorded += 1;
        } else {
          duplicates += 1;
        }
      }
      return { recorded, duplicates };
    });
  }
}
