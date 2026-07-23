import { describe, expect, it } from "vitest";

import type { BucketBalances } from "@application/ledger";
import { createTenantContext, type TenantContext } from "@infrastructure/database";

import { DashboardQueryService } from "./dashboard-query-service";
import type {
  BalanceReader,
  DashboardCounts,
  DashboardQueryGateway,
  PartnerSummary,
} from "./ports";

const TENANT = createTenantContext("11111111-1111-4111-8111-111111111111");

function balances(overrides: Partial<BucketBalances> = {}): BucketBalances {
  return Object.freeze({
    platform_partner_payable: 0,
    partner_pending: 0,
    partner_available: 0,
    partner_payout_locked: 0,
    partner_paid: 0,
    partner_reversed: 0,
    ...overrides,
  });
}

function counts(overrides: Partial<DashboardCounts> = {}): DashboardCounts {
  return {
    devicesOnline: 0,
    devicesTotal: 0,
    numbersAvailable: 0,
    ordersActive: 0,
    ordersTotal: 0,
    ordersSuccess: 0,
    payoutsOpen: 0,
    payoutsPaid: 0,
    ...overrides,
  };
}

class FakeGateway implements DashboardQueryGateway {
  constructor(
    private readonly partner: PartnerSummary | null,
    private readonly countsValue: DashboardCounts,
    private readonly seenTenants: TenantContext[] = [],
  ) {}

  async loadPartnerSummary(tenant: TenantContext): Promise<PartnerSummary | null> {
    this.seenTenants.push(tenant);
    return this.partner;
  }

  async loadCounts(tenant: TenantContext): Promise<DashboardCounts> {
    this.seenTenants.push(tenant);
    return this.countsValue;
  }

  get tenants(): readonly TenantContext[] {
    return this.seenTenants;
  }
}

class FakeBalances implements BalanceReader {
  public partnerIds: string[] = [];
  constructor(private readonly value: BucketBalances) {}
  async computeBucketBalances(partnerId: string): Promise<BucketBalances> {
    this.partnerIds.push(partnerId);
    return this.value;
  }
}

describe("DashboardQueryService", () => {
  it("assembles the tenant view from counts and ledger balances", async () => {
    const gateway = new FakeGateway(
      { displayName: "Acme", status: "approved", statusReason: null },
      counts({
        devicesOnline: 1,
        devicesTotal: 2,
        numbersAvailable: 3,
        ordersActive: 1,
        ordersTotal: 5,
        ordersSuccess: 4,
        payoutsOpen: 1,
        payoutsPaid: 2,
      }),
    );
    const balanceReader = new FakeBalances(
      balances({
        partner_pending: 1000,
        partner_available: 2000,
        partner_payout_locked: 500,
        partner_paid: 3000,
      }),
    );
    const service = new DashboardQueryService({ gateway, balances: balanceReader });

    const outcome = await service.load(TENANT);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.view).toEqual({
      partner: { displayName: "Acme", status: "approved", statusReason: null },
      devices: { online: 1, total: 2 },
      numbersAvailable: 3,
      orders: { active: 1, total: 5, success: 4 },
      earnings: { pendingIdr: 1000, availableIdr: 2000 },
      payout: { lockedIdr: 500, paidIdr: 3000, openCount: 1, paidCount: 2 },
    });
  });

  it("binds every read to the session tenant's partnerId", async () => {
    const gateway = new FakeGateway(
      { displayName: "Acme", status: "approved", statusReason: null },
      counts(),
    );
    const balanceReader = new FakeBalances(balances());
    const service = new DashboardQueryService({ gateway, balances: balanceReader });

    await service.load(TENANT);

    expect(balanceReader.partnerIds).toEqual([TENANT.partnerId]);
    for (const tenant of gateway.tenants) {
      expect(tenant.partnerId).toBe(TENANT.partnerId);
    }
  });

  it("reports partner_not_found when the tenant has no partner row", async () => {
    const gateway = new FakeGateway(null, counts());
    const service = new DashboardQueryService({
      gateway,
      balances: new FakeBalances(balances()),
    });

    const outcome = await service.load(TENANT);

    expect(outcome).toEqual({ ok: false, reason: "partner_not_found" });
  });
});
