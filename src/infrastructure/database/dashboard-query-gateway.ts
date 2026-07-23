import { $Enums } from "@/generated/prisma";

import type {
  DashboardCounts,
  DashboardQueryGateway,
  PartnerStatus,
  PartnerSummary,
} from "@application/portal";

import type { PartnerDatabaseExecutor } from "./client";
import { assertTenantContext, type TenantContext } from "./tenant-context";

const PARTNER_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerStatus, PartnerStatus>> = {
  PENDING: "pending",
  APPROVED: "approved",
  SUSPENDED: "suspended",
  REJECTED: "rejected",
};

/**
 * Prisma-backed read model for the Partner portal dashboard (task 15.1).
 *
 * Every query folds in the trusted `partnerId` from the {@link TenantContext}
 * for defense-in-depth isolation (requirement 4.2), so a cross-tenant row is
 * indistinguishable from a missing one. Counts use `count`/`groupBy`
 * aggregates rather than loading rows. Monetary balances are NOT read here;
 * they come from the ledger SUM (task 14.1) via the balance reader, keeping the
 * ledger the single source of monetary truth. Raw Prisma never leaves this
 * adapter.
 */
export class PrismaDashboardQueryGateway implements DashboardQueryGateway {
  private readonly executor: PartnerDatabaseExecutor;

  constructor(executor: PartnerDatabaseExecutor) {
    this.executor = executor;
  }

  async loadPartnerSummary(tenant: TenantContext): Promise<PartnerSummary | null> {
    assertTenantContext(tenant);
    const partner = await this.executor.partner.findUnique({
      where: { id: tenant.partnerId },
      select: { displayName: true, status: true, statusReason: true },
    });
    if (partner === null) return null;
    return {
      displayName: partner.displayName,
      status: PARTNER_STATUS_FROM_DB[partner.status],
      statusReason: partner.statusReason,
    };
  }

  async loadCounts(tenant: TenantContext): Promise<DashboardCounts> {
    assertTenantContext(tenant);
    const partnerId = tenant.partnerId;

    const [
      devicesOnline,
      devicesTotal,
      numbersAvailable,
      ordersActive,
      ordersTotal,
      ordersSuccess,
      payoutsOpen,
      payoutsPaid,
    ] = await Promise.all([
      this.executor.partnerDevice.count({
        where: { partnerId, effectiveStatus: $Enums.PartnerDeviceStatus.ONLINE },
      }),
      this.executor.partnerDevice.count({ where: { partnerId } }),
      this.executor.partnerNumber.count({
        where: {
          partnerId,
          status: $Enums.PartnerNumberStatus.AVAILABLE,
          enabled: true,
        },
      }),
      this.executor.partnerOrder.count({
        where: {
          partnerId,
          status: {
            in: [
              $Enums.PartnerOrderStatus.RESERVED,
              $Enums.PartnerOrderStatus.WAITING_SMS,
            ],
          },
        },
      }),
      this.executor.partnerOrder.count({ where: { partnerId } }),
      this.executor.partnerOrder.count({
        where: { partnerId, status: $Enums.PartnerOrderStatus.SUCCESS },
      }),
      this.executor.partnerPayout.count({
        where: {
          partnerId,
          status: {
            in: [
              $Enums.PartnerPayoutStatus.REQUESTED,
              $Enums.PartnerPayoutStatus.APPROVED,
              $Enums.PartnerPayoutStatus.PROCESSING,
            ],
          },
        },
      }),
      this.executor.partnerPayout.count({
        where: { partnerId, status: $Enums.PartnerPayoutStatus.PAID },
      }),
    ]);

    return {
      devicesOnline,
      devicesTotal,
      numbersAvailable,
      ordersActive,
      ordersTotal,
      ordersSuccess,
      payoutsOpen,
      payoutsPaid,
    };
  }
}
