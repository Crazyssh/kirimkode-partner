/**
 * Portal operational read service (task 15.2).
 *
 * Assembles the read views for the Devices, Numbers, Offers, Orders, Earnings,
 * Payouts, Members, and API-key pages (requirement 15.2). Every method is bound
 * to the session's tenant scope; the service never sees a client-supplied
 * partnerId. The only business logic here is the authoritative offer pricing,
 * which is recomputed from the active {@link PortalConfigView} using the pure
 * task 5.2 pricing domain rather than trusting any stored retail column — the
 * ledger and the pricing domain remain the single sources of truth (design
 * section 11). All monetary figures are integers in whole IDR; the transport
 * layer formats them with the domain formatter (requirement 15.4).
 */
import {
  calculateAuthoritativePricing,
  Task52DomainError,
  type PartnerStatus,
} from "@domain/task-5-2-device-inventory-pricing";

import type { TenantContext } from "@infrastructure/database";

import type {
  ApiKeyListItem,
  DestinationListItem,
  DeviceListItem,
  DeviceOption,
  EarningListItem,
  MemberListItem,
  NumberListItem,
  OfferListItem,
  OfferRow,
  OperationalQueryGateway,
  OrderListItem,
  PayoutListItem,
  PortalConfigView,
} from "./operational-ports";

export interface OperationalQueryServiceDeps {
  readonly gateway: OperationalQueryGateway;
}

/** How many terminal orders the history page shows by default. */
export const ORDER_HISTORY_LIMIT = 50;

/** The aggregated Earnings view: the rows plus pending/available totals. */
export interface EarningsView {
  readonly earnings: readonly EarningListItem[];
  readonly pendingIdr: number;
  readonly availableIdr: number;
}

/** The aggregated Payouts view: history, destinations, and request context. */
export interface PayoutsView {
  readonly payouts: readonly PayoutListItem[];
  readonly destinations: readonly DestinationListItem[];
  /** Earnings that are `available` (unlocked) and thus payable right now. */
  readonly availableEarnings: readonly EarningListItem[];
  readonly availableIdr: number;
  readonly minimumPayoutIdr: number;
}

export class OperationalQueryService {
  private readonly deps: OperationalQueryServiceDeps;

  constructor(deps: OperationalQueryServiceDeps) {
    this.deps = deps;
  }

  async partnerStatus(tenant: TenantContext): Promise<PartnerStatus | null> {
    return this.deps.gateway.loadPartnerStatus(tenant);
  }

  async config(): Promise<PortalConfigView | null> {
    return this.deps.gateway.loadConfig();
  }

  async devices(tenant: TenantContext): Promise<readonly DeviceListItem[]> {
    return this.deps.gateway.listDevices(tenant);
  }

  async deviceOptions(tenant: TenantContext): Promise<readonly DeviceOption[]> {
    return this.deps.gateway.listDeviceOptions(tenant);
  }

  async numbers(
    tenant: TenantContext,
  ): Promise<{ numbers: readonly NumberListItem[]; devices: readonly DeviceOption[] }> {
    const [numbers, devices] = await Promise.all([
      this.deps.gateway.listNumbers(tenant),
      this.deps.gateway.listDeviceOptions(tenant),
    ]);
    return { numbers, devices };
  }

  /**
   * Offers with authoritative pricing recomputed from the active config. When
   * no active config exists, or a stored base price falls outside the current
   * guardrail, retail/margin are reported as null rather than fabricated.
   */
  async offers(
    tenant: TenantContext,
  ): Promise<{ offers: readonly OfferListItem[]; config: PortalConfigView | null }> {
    const [rows, config] = await Promise.all([
      this.deps.gateway.listOffers(tenant),
      this.deps.gateway.loadConfig(),
    ]);
    const offers = rows.map((row) => this.toOfferView(row, config));
    return { offers, config };
  }

  async activeOrders(tenant: TenantContext): Promise<readonly OrderListItem[]> {
    return this.deps.gateway.listActiveOrders(tenant);
  }

  async orderHistory(
    tenant: TenantContext,
    limit: number = ORDER_HISTORY_LIMIT,
  ): Promise<readonly OrderListItem[]> {
    return this.deps.gateway.listOrderHistory(tenant, limit);
  }

  async earnings(tenant: TenantContext): Promise<EarningsView> {
    const earnings = await this.deps.gateway.listEarnings(tenant);
    const pendingIdr = sumBy(earnings, (e) => (e.status === "pending" ? e.amountIdr : 0));
    const availableIdr = sumBy(earnings, (e) => (e.status === "available" ? e.amountIdr : 0));
    return { earnings, pendingIdr, availableIdr };
  }

  async payouts(tenant: TenantContext): Promise<PayoutsView> {
    const [payouts, destinations, earnings, config] = await Promise.all([
      this.deps.gateway.listPayouts(tenant),
      this.deps.gateway.listDestinations(tenant),
      this.deps.gateway.listEarnings(tenant),
      this.deps.gateway.loadConfig(),
    ]);
    const availableEarnings = earnings.filter((e) => e.status === "available");
    const availableIdr = sumBy(availableEarnings, (e) => e.amountIdr);
    return {
      payouts,
      destinations,
      availableEarnings,
      availableIdr,
      minimumPayoutIdr: config?.minimumPayoutIdr ?? 0,
    };
  }

  async members(tenant: TenantContext): Promise<readonly MemberListItem[]> {
    return this.deps.gateway.listMembers(tenant);
  }

  async apiKeys(tenant: TenantContext): Promise<readonly ApiKeyListItem[]> {
    return this.deps.gateway.listApiKeys(tenant);
  }

  private toOfferView(row: OfferRow, config: PortalConfigView | null): OfferListItem {
    let retailPriceIdr: number | null = null;
    let platformMarginIdr: number | null = null;
    const currency = config?.currency ?? "IDR";

    if (config !== null) {
      try {
        const pricing = calculateAuthoritativePricing(
          { basePriceIdr: row.basePriceIdr },
          {
            version: config.version,
            serviceCode: row.serviceCode,
            countryCode: row.countryCode,
            operatorCode: row.operatorCode,
            currency: config.currency,
            minBasePriceIdr: config.minBasePriceIdr,
            maxBasePriceIdr: config.maxBasePriceIdr,
            fixedFeeIdr: config.fixedFeeIdr,
            markupBps: config.markupBps,
            roundToIdr: config.roundToIdr,
          },
        );
        retailPriceIdr = pricing.retailPriceIdr;
        platformMarginIdr = pricing.platformMarginIdr;
      } catch (error) {
        // A base price outside the current guardrail cannot be priced; report
        // null rather than throwing so the rest of the page still renders.
        if (!(error instanceof Task52DomainError)) throw error;
      }
    }

    return {
      id: row.id,
      serviceCode: row.serviceCode,
      countryCode: row.countryCode,
      operatorCode: row.operatorCode,
      basePriceIdr: row.basePriceIdr,
      status: row.status,
      configVersion: row.configVersion,
      retailPriceIdr,
      payoutIdr: row.basePriceIdr,
      platformMarginIdr,
      currency,
    };
  }
}

function sumBy<T>(items: readonly T[], project: (item: T) => number): number {
  return items.reduce((total, item) => total + project(item), 0);
}
