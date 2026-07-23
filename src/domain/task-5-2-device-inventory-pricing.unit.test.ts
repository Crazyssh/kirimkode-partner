import { describe, expect, it } from "vitest";

import {
  MVP_PRICING_CONFIG,
  Task52DomainError,
  assertBasePriceWithinGuardrail,
  assertNumberMoveOrDeleteAllowed,
  assertUniqueActiveNumber,
  assertDeviceOperationAllowed,
  calculateAuthoritativePricing,
  effectiveDeviceStatus,
  isDeviceLive,
  normalizeIndonesianNumber,
  parseDeviceCapabilities,
  reconcileNumberAvailability,
  recordServerHeartbeat,
  sanitizeHeartbeatMetadata,
  selectEligibleInventory,
  validateOffer,
  validatePricingConfig,
  type DeviceState,
  type ExistingNumberIdentity,
  type InventoryCandidate,
  type InventoryFilter,
  type OfferInput,
} from "./task-5-2-device-inventory-pricing";

const NOW = new Date("2026-05-01T00:00:00.000Z");

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Task52DomainError);
    expect((error as Task52DomainError).code).toBe(code);
    return;
  }
  throw new Error(`Expected function to throw Task52DomainError(${code})`);
}

function device(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    type: "simulator",
    status: "online",
    lastSeenAt: new Date(NOW.getTime() - 30_000),
    capabilities: parseDeviceCapabilities({ sms: true, slots: 1 }),
    ...overrides,
  };
}

// **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.6**
describe("authoritative pricing", () => {
  it("derives the documented base Rp1.000 -> retail Rp1.400 / payout Rp1.000", () => {
    const result = calculateAuthoritativePricing({ basePriceIdr: 1_000 });
    expect(result).toEqual({
      retailPriceIdr: 1_400,
      payoutIdr: 1_000,
      platformMarginIdr: 400,
    });
  });

  it("rounds retail up to the nearest Rp50 unit", () => {
    // base 777 => 777 + 250 + ceil(777*1500/10000=116.55 -> 117) = 1144 -> ceil50 = 1150
    const result = calculateAuthoritativePricing({ basePriceIdr: 777 });
    expect(result.retailPriceIdr).toBe(1_150);
    expect(result.payoutIdr).toBe(777);
    expect(result.platformMarginIdr).toBe(373);
  });

  it("keeps payout equal to base at both guardrail boundaries", () => {
    expect(calculateAuthoritativePricing({ basePriceIdr: 500 }).payoutIdr).toBe(500);
    expect(calculateAuthoritativePricing({ basePriceIdr: 5_000 }).payoutIdr).toBe(5_000);
  });

  it("rejects base prices outside the Rp500-Rp5.000 guardrail", () => {
    expectCode(() => assertBasePriceWithinGuardrail(499), "PRICE_OUT_OF_GUARDRAIL");
    expectCode(() => assertBasePriceWithinGuardrail(5_001), "PRICE_OUT_OF_GUARDRAIL");
    expectCode(() => calculateAuthoritativePricing({ basePriceIdr: 5_001 }), "PRICE_OUT_OF_GUARDRAIL");
  });

  it("validates config invariants", () => {
    expect(validatePricingConfig(MVP_PRICING_CONFIG)).toBe(MVP_PRICING_CONFIG);
    expect(() =>
      validatePricingConfig({ ...MVP_PRICING_CONFIG, minBasePriceIdr: 6_000 }),
    ).toThrowError(Task52DomainError);
  });
});

// **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5**
describe("Indonesian number canonicalization and guards", () => {
  it("normalizes equivalent representations to a single +62 canonical form", () => {
    const canonical = "+628123456789";
    for (const variant of [
      "08123456789",
      "628123456789",
      "+62 812-3456-789",
      "0062 8123456789",
      "+62 (812) 3456789",
    ]) {
      expect(normalizeIndonesianNumber(variant)).toBe(canonical);
    }
  });

  it("rejects malformed numbers", () => {
    expect(() => normalizeIndonesianNumber("")).toThrowError(Task52DomainError);
    expect(() => normalizeIndonesianNumber("+1202555")).toThrowError(/INVALID_PHONE_NUMBER|E\.164/i);
    expect(() => normalizeIndonesianNumber("0812abc")).toThrowError(Task52DomainError);
  });

  it("detects duplicate active numbers ignoring disabled and excluded entries", () => {
    const existing: ExistingNumberIdentity[] = [
      { id: "n1", canonicalNumber: "+628123456789", status: "available" },
      { id: "n2", canonicalNumber: "+628990000000", status: "disabled" },
    ];
    expectCode(() => assertUniqueActiveNumber("08123456789", existing), "DUPLICATE_ACTIVE_NUMBER");
    // disabled duplicate is allowed
    expect(assertUniqueActiveNumber("08990000000", existing)).toBe("+628990000000");
    // excluding the owning record allows an update
    expect(assertUniqueActiveNumber("08123456789", existing, "n1")).toBe("+628123456789");
  });

  it("guards move/delete while reserved or busy", () => {
    expectCode(() => assertNumberMoveOrDeleteAllowed("reserved"), "NUMBER_STATE_GUARD");
    expectCode(() => assertNumberMoveOrDeleteAllowed("busy"), "NUMBER_STATE_GUARD");
    expect(assertNumberMoveOrDeleteAllowed("available")).toBeUndefined();
    expect(assertNumberMoveOrDeleteAllowed("offline")).toBeUndefined();
  });
});

// **Validates: Requirements 6.1, 6.2, 6.4, 21.3**
describe("device heartbeat liveness on server time", () => {
  it("keeps lastSeenAt monotonic across server heartbeats", () => {
    const base = device({ lastSeenAt: new Date(NOW.getTime()) });
    const stale = recordServerHeartbeat(base, new Date(NOW.getTime() - 10_000));
    expect(stale.lastSeenAt?.getTime()).toBe(NOW.getTime());
    expect(stale.status).toBe("online");
    const forward = recordServerHeartbeat(base, new Date(NOW.getTime() + 10_000));
    expect(forward.lastSeenAt?.getTime()).toBe(NOW.getTime() + 10_000);
  });

  it("treats disabled devices as fail-closed even after heartbeat", () => {
    const disabled = recordServerHeartbeat(device({ status: "disabled" }), NOW);
    expect(disabled.status).toBe("disabled");
    expect(effectiveDeviceStatus(disabled, NOW)).toBe("disabled");
  });

  it("uses the inclusive 90 second offline threshold", () => {
    const atBoundary = device({ lastSeenAt: new Date(NOW.getTime() - 90_000) });
    expect(isDeviceLive(atBoundary, NOW)).toBe(true);
    const overBoundary = device({ lastSeenAt: new Date(NOW.getTime() - 90_001) });
    expect(isDeviceLive(overBoundary, NOW)).toBe(false);
    expect(effectiveDeviceStatus(overBoundary, NOW)).toBe("offline");
  });

  it("sanitizes heartbeat metadata as non-authoritative", () => {
    const metadata = sanitizeHeartbeatMetadata({ agentVersion: "1.0.0", signal: -70, operator: "TSEL" });
    expect(metadata).toEqual({ agentVersion: "1.0.0", signal: -70, operator: "TSEL" });
    expect(() => sanitizeHeartbeatMetadata({ signal: 1.5 })).toThrowError(Task52DomainError);
  });

  it("enforces capability and disabled fail-closed for operations", () => {
    expect(() => assertDeviceOperationAllowed(device(), "inventory")).not.toThrow();
    expectCode(() => assertDeviceOperationAllowed(device({ status: "disabled" }), "sms"), "DEVICE_DISABLED");
    expectCode(
      () => assertDeviceOperationAllowed(device({ capabilities: parseDeviceCapabilities({ slots: 1 }) }), "sms"),
      "UNSUPPORTED_CAPABILITY",
    );
  });
});

// **Validates: Requirements 6.3**
describe("number availability reconciliation", () => {
  it("goes offline when the device is not live", () => {
    const status = reconcileNumberAvailability({
      status: "available",
      enabled: true,
      hasActiveOrder: false,
      hasActiveOffer: true,
      device: device({ lastSeenAt: new Date(NOW.getTime() - 200_000) }),
      nowServer: NOW,
    });
    expect(status).toBe("offline");
  });

  it("becomes available only with a live device, active offer and no active order", () => {
    expect(
      reconcileNumberAvailability({
        status: "available",
        enabled: true,
        hasActiveOrder: false,
        hasActiveOffer: true,
        device: device(),
        nowServer: NOW,
      }),
    ).toBe("available");
  });

  it("never downgrades reserved or busy numbers", () => {
    for (const held of ["reserved", "busy"] as const) {
      expect(
        reconcileNumberAvailability({
          status: held,
          enabled: true,
          hasActiveOrder: true,
          hasActiveOffer: true,
          device: device({ lastSeenAt: new Date(NOW.getTime() - 200_000) }),
          nowServer: NOW,
        }),
      ).toBe(held);
    }
  });
});

// **Validates: Requirements 8.1, 9.1, 9.4, 21.5**
describe("offer validation and deterministic inventory selection", () => {
  const offer: OfferInput = {
    serviceCode: "wa",
    countryCode: "ID",
    operatorCode: "any",
    basePriceIdr: 1_000,
    status: "active",
  };

  it("rejects offers from non-approved partners or off-catalog dimensions", () => {
    expectCode(() => validateOffer("pending", offer), "PARTNER_NOT_APPROVED");
    expectCode(() => validateOffer("approved", { ...offer, serviceCode: "sms" }), "INVALID_OFFER_CATALOG");
  });

  it("computes authoritative pricing for a valid offer", () => {
    const validated = validateOffer("approved", offer);
    expect(validated.pricing.retailPriceIdr).toBe(1_400);
    expect(validated.pricing.payoutIdr).toBe(1_000);
    expect(validated.configVersion).toBe(MVP_PRICING_CONFIG.version);
  });

  const filter: InventoryFilter = { serviceCode: "wa", countryCode: "ID", operatorCode: "any" };

  function candidate(numberId: string, overrides: Partial<InventoryCandidate> = {}): InventoryCandidate {
    return {
      numberId,
      partnerStatus: "approved",
      device: device(),
      number: {
        status: "available",
        enabled: true,
        countryCode: "ID",
        operatorCode: "any",
        hasActiveOrder: false,
      },
      offer,
      ...overrides,
    };
  }

  it("selects the deterministic first eligible candidate by numberId ASC", () => {
    const selected = selectEligibleInventory(
      [candidate("n3"), candidate("n1"), candidate("n2")],
      filter,
      NOW,
    );
    expect(selected?.numberId).toBe("n1");
  });

  it("excludes ineligible candidates and returns null on stockout", () => {
    const selected = selectEligibleInventory(
      [
        candidate("n1", { partnerStatus: "suspended" }),
        candidate("n2", { device: device({ lastSeenAt: new Date(NOW.getTime() - 200_000) }) }),
        candidate("n3", { number: { status: "busy", enabled: true, countryCode: "ID", operatorCode: "any" } }),
        candidate("n4", { offer: { ...offer, status: "inactive" } }),
      ],
      filter,
      NOW,
    );
    expect(selected).toBeNull();
  });
});
