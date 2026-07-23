import { describe, expect, it } from "vitest";

import { createTenantContext, type TenantContext } from "@infrastructure/database";

import { OperationalQueryService } from "./operational-query-service";
import type {
  ApiKeyListItem,
  DestinationListItem,
  DeviceListItem,
  DeviceOption,
  EarningListItem,
  MemberListItem,
  NumberListItem,
  OfferRow,
  OperationalQueryGateway,
  OrderListItem,
  PayoutListItem,
  PortalConfigView,
} from "./operational-ports";

const TENANT = createTenantContext("22222222-2222-4222-8222-222222222222");

/** The seeded MVP config (guardrail Rp500–Rp5.000, fee Rp250, markup 1500bps). */
const CONFIG: PortalConfigView = {
  version: 1,
  currency: "IDR",
  minBasePriceIdr: 500,
  maxBasePriceIdr: 5000,
  fixedFeeIdr: 250,
  markupBps: 1500,
  roundToIdr: 50,
  minimumPayoutIdr: 1000,
};

interface FakeData {
  config?: PortalConfigView | null;
  offers?: readonly OfferRow[];
  earnings?: readonly EarningListItem[];
  destinations?: readonly DestinationListItem[];
  payouts?: readonly PayoutListItem[];
}

class FakeGateway implements OperationalQueryGateway {
  public seenTenants: TenantContext[] = [];
  constructor(private readonly data: FakeData) {}

  async loadPartnerStatus(tenant: TenantContext) {
    this.seenTenants.push(tenant);
    return "approved" as const;
  }
  async loadConfig() {
    return this.data.config === undefined ? CONFIG : this.data.config;
  }
  async listDevices(tenant: TenantContext): Promise<readonly DeviceListItem[]> {
    this.seenTenants.push(tenant);
    return [];
  }
  async listDeviceOptions(): Promise<readonly DeviceOption[]> {
    return [];
  }
  async listNumbers(): Promise<readonly NumberListItem[]> {
    return [];
  }
  async listOffers(tenant: TenantContext): Promise<readonly OfferRow[]> {
    this.seenTenants.push(tenant);
    return this.data.offers ?? [];
  }
  async listActiveOrders(): Promise<readonly OrderListItem[]> {
    return [];
  }
  async listOrderHistory(): Promise<readonly OrderListItem[]> {
    return [];
  }
  async listEarnings(tenant: TenantContext): Promise<readonly EarningListItem[]> {
    this.seenTenants.push(tenant);
    return this.data.earnings ?? [];
  }
  async listDestinations(): Promise<readonly DestinationListItem[]> {
    return this.data.destinations ?? [];
  }
  async listPayouts(): Promise<readonly PayoutListItem[]> {
    return this.data.payouts ?? [];
  }
  async listMembers(): Promise<readonly MemberListItem[]> {
    return [];
  }
  async listApiKeys(): Promise<readonly ApiKeyListItem[]> {
    return [];
  }
}

function offer(overrides: Partial<OfferRow> = {}): OfferRow {
  return {
    id: "offer-1",
    serviceCode: "wa",
    countryCode: "ID",
    operatorCode: "any",
    basePriceIdr: 1000,
    status: "active",
    configVersion: 1,
    ...overrides,
  };
}

function earning(overrides: Partial<EarningListItem> = {}): EarningListItem {
  return {
    id: "earn-1",
    orderId: "order-1",
    amountIdr: 1000,
    status: "available",
    availableAtEpochMs: 0,
    createdAtEpochMs: 0,
    ...overrides,
  };
}

describe("OperationalQueryService", () => {
  it("recomputes authoritative offer pricing from the active config", async () => {
    const service = new OperationalQueryService({
      gateway: new FakeGateway({ offers: [offer({ basePriceIdr: 1000 })] }),
    });

    const { offers } = await service.offers(TENANT);

    expect(offers).toHaveLength(1);
    // base 1000 + fee 250 + markup ceil(1000*1500/10000)=150 = 1400, round 50 = 1400
    expect(offers[0]).toMatchObject({
      basePriceIdr: 1000,
      retailPriceIdr: 1400,
      payoutIdr: 1000,
      platformMarginIdr: 400,
      currency: "IDR",
    });
  });

  it("reports null retail for a base price outside the current guardrail", async () => {
    const service = new OperationalQueryService({
      gateway: new FakeGateway({ offers: [offer({ basePriceIdr: 100 })] }),
    });

    const { offers } = await service.offers(TENANT);

    expect(offers[0].retailPriceIdr).toBeNull();
    expect(offers[0].platformMarginIdr).toBeNull();
    // Payout always mirrors the stored base price.
    expect(offers[0].payoutIdr).toBe(100);
  });

  it("reports null retail and IDR currency when no active config exists", async () => {
    const service = new OperationalQueryService({
      gateway: new FakeGateway({ config: null, offers: [offer()] }),
    });

    const { offers, config } = await service.offers(TENANT);

    expect(config).toBeNull();
    expect(offers[0].retailPriceIdr).toBeNull();
    expect(offers[0].currency).toBe("IDR");
  });

  it("aggregates pending and available earning totals", async () => {
    const service = new OperationalQueryService({
      gateway: new FakeGateway({
        earnings: [
          earning({ id: "a", status: "pending", amountIdr: 1000 }),
          earning({ id: "b", status: "available", amountIdr: 2000 }),
          earning({ id: "c", status: "available", amountIdr: 500 }),
          earning({ id: "d", status: "paid", amountIdr: 9000 }),
        ],
      }),
    });

    const view = await service.earnings(TENANT);

    expect(view.pendingIdr).toBe(1000);
    expect(view.availableIdr).toBe(2500);
    expect(view.earnings).toHaveLength(4);
  });

  it("exposes only available earnings and the minimum for the payout view", async () => {
    const service = new OperationalQueryService({
      gateway: new FakeGateway({
        earnings: [
          earning({ id: "a", status: "available", amountIdr: 2000 }),
          earning({ id: "b", status: "pending", amountIdr: 1000 }),
        ],
        destinations: [
          { id: "d1", bankCode: "BCA", accountNumberLast4: "1234", accountHolderName: "A", status: "active" },
        ],
      }),
    });

    const view = await service.payouts(TENANT);

    expect(view.availableEarnings.map((e) => e.id)).toEqual(["a"]);
    expect(view.availableIdr).toBe(2000);
    expect(view.minimumPayoutIdr).toBe(1000);
    expect(view.destinations).toHaveLength(1);
  });

  it("binds every read to the session tenant's partnerId", async () => {
    const gateway = new FakeGateway({ offers: [offer()] });
    const service = new OperationalQueryService({ gateway });

    await service.offers(TENANT);
    await service.earnings(TENANT);

    for (const tenant of gateway.seenTenants) {
      expect(tenant.partnerId).toBe(TENANT.partnerId);
    }
  });
});
