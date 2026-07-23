import { beforeEach, describe, expect, it } from "vitest";

import type {
  DeviceCapabilities,
  InventoryCandidate,
  InventoryFilter,
} from "@domain/task-5-2-device-inventory-pricing";

import { InventoryQueryService, QUOTE_TTL_MS } from "./inventory-query-service";
import type { InventoryQueryGateway, PlatformConfigSnapshot } from "./ports";

const NOW = 1_700_000_000_000;

const CONFIG: PlatformConfigSnapshot = Object.freeze({
  version: 1,
  serviceCode: "wa",
  countryCode: "ID",
  operatorCode: "any",
  currency: "IDR",
  minBasePriceIdr: 500,
  maxBasePriceIdr: 5_000,
  fixedFeeIdr: 250,
  markupBps: 1_500,
  roundToIdr: 50,
  heartbeatTimeoutSeconds: 90,
});

const FILTER: InventoryFilter = Object.freeze({
  serviceCode: "wa",
  countryCode: "ID",
  operatorCode: "any",
});

const SMS_CAPS: DeviceCapabilities = Object.freeze({
  sms: true,
  notification: false,
  resend: false,
  operator: false,
  slots: 1,
});

class FakeClock {
  constructor(public value = NOW) {}
  nowEpochMs(): number {
    return this.value;
  }
}

class FakeInventoryGateway implements InventoryQueryGateway {
  config: PlatformConfigSnapshot | null = CONFIG;
  candidates: InventoryCandidate[] = [];

  async loadActiveConfig(): Promise<PlatformConfigSnapshot | null> {
    return this.config;
  }
  async loadCandidates(): Promise<readonly InventoryCandidate[]> {
    return this.candidates;
  }
}

function eligibleCandidate(overrides: {
  numberId: string;
  basePriceIdr: number;
}): InventoryCandidate {
  return {
    numberId: overrides.numberId,
    partnerStatus: "approved",
    device: {
      type: "simulator",
      status: "online",
      lastSeenAt: new Date(NOW),
      capabilities: SMS_CAPS,
    },
    number: {
      status: "available",
      enabled: true,
      countryCode: "ID",
      operatorCode: "any",
      hasActiveOrder: false,
    },
    offer: {
      serviceCode: "wa",
      countryCode: "ID",
      operatorCode: "any",
      basePriceIdr: overrides.basePriceIdr,
      status: "active",
    },
  };
}

describe("InventoryQueryService", () => {
  let gateway: FakeInventoryGateway;
  let service: InventoryQueryService;

  beforeEach(() => {
    gateway = new FakeInventoryGateway();
    service = new InventoryQueryService({ gateway, clock: new FakeClock() });
  });

  it("quotes the server-computed retail price for the number.id-ASC candidate", async () => {
    // Two eligible candidates with different base prices; the deterministic
    // selector must pick the smaller numberId, so the quote reflects its price.
    gateway.candidates = [
      eligibleCandidate({ numberId: "number-b", basePriceIdr: 2_000 }),
      eligibleCandidate({ numberId: "number-a", basePriceIdr: 1_000 }),
    ];

    const result = await service.queryInventory({ filter: FILTER });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.available).toBe(true);
    // number-a base 1000 => retail 1400.
    expect(result.quote.retailPriceIdr).toBe(1_400);
    expect(result.quote.currency).toBe("IDR");
    expect(result.quote.quoteVersion).toBe(1);
    expect(result.quote.expiresAtEpochMs).toBe(NOW + QUOTE_TTL_MS);
  });

  it("returns a stockout quote (no partial state) when nothing is eligible", async () => {
    gateway.candidates = [];
    const result = await service.queryInventory({ filter: FILTER });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.available).toBe(false);
    expect(result.quote.retailPriceIdr).toBeNull();
    expect(result.quote.quoteVersion).toBe(1);
    expect(result.quote.expiresAtEpochMs).toBe(NOW + QUOTE_TTL_MS);
  });

  it("excludes candidates failing the eligibility conjunction", async () => {
    const disabledDevice = eligibleCandidate({ numberId: "n1", basePriceIdr: 1_000 });
    const staleHeartbeat = eligibleCandidate({ numberId: "n2", basePriceIdr: 1_000 });
    const notApproved = eligibleCandidate({ numberId: "n3", basePriceIdr: 1_000 });
    const inactiveOffer = eligibleCandidate({ numberId: "n4", basePriceIdr: 1_000 });

    gateway.candidates = [
      { ...disabledDevice, device: { ...disabledDevice.device, status: "disabled" } },
      {
        ...staleHeartbeat,
        device: { ...staleHeartbeat.device, lastSeenAt: new Date(NOW - 200_000) },
      },
      { ...notApproved, partnerStatus: "suspended" },
      { ...inactiveOffer, offer: { ...inactiveOffer.offer, status: "inactive" } },
    ];

    const result = await service.queryInventory({ filter: FILTER });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.available).toBe(false);
  });

  it("returns config_unavailable when no active config exists", async () => {
    gateway.config = null;
    const result = await service.queryInventory({ filter: FILTER });
    expect(result).toEqual({ ok: false, reason: "config_unavailable" });
  });

  it("rejects a filter outside the configured catalog", async () => {
    const result = await service.queryInventory({
      filter: { serviceCode: "tg", countryCode: "ID", operatorCode: "any" },
    });
    expect(result).toEqual({ ok: false, reason: "catalog_mismatch" });
  });

  it("honours a custom quote TTL", async () => {
    const custom = new InventoryQueryService({
      gateway,
      clock: new FakeClock(),
      quoteTtlMs: 30_000,
    });
    gateway.candidates = [eligibleCandidate({ numberId: "n1", basePriceIdr: 1_000 })];
    const result = await custom.queryInventory({ filter: FILTER });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.expiresAtEpochMs).toBe(NOW + 30_000);
  });
});
