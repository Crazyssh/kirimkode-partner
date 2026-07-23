import { describe, expect, it } from "vitest";

import {
  MVP_CATALOG,
  MVP_HEARTBEAT_TIMEOUT_SECONDS,
  MVP_PRICING_CONFIG,
  Task52DomainError,
  assertDeviceOperationAllowed,
  assertNumberMoveOrDeleteAllowed,
  assertUniqueActiveNumber,
  calculateAuthoritativePricing,
  disableIdleNumber,
  effectiveDeviceStatus,
  isDeviceLive,
  isInventoryCandidateEligible,
  normalizeIndonesianNumber,
  parseDeviceCapabilities,
  reconcileNumberAvailability,
  recordServerHeartbeat,
  reenableNumber,
  sanitizeHeartbeatMetadata,
  selectEligibleInventory,
  validateOffer,
  validatePricingConfig,
  type DeviceCapabilities,
  type DeviceState,
  type InventoryCandidate,
} from "@domain/task-5-2-device-inventory-pricing";

const NOW = new Date("2026-07-22T10:00:00.000Z");
const SMS_CAPABILITIES: DeviceCapabilities = Object.freeze({
  sms: true,
  notification: false,
  resend: false,
  operator: false,
  slots: 1,
});

function onlineDevice(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    type: "simulator",
    status: "online",
    lastSeenAt: new Date(NOW.getTime() - 30_000),
    capabilities: SMS_CAPABILITIES,
    ...overrides,
  };
}

function candidate(
  numberId: string,
  overrides: {
    partnerStatus?: InventoryCandidate["partnerStatus"];
    device?: DeviceState;
    number?: Partial<InventoryCandidate["number"]>;
    offer?: Partial<InventoryCandidate["offer"]>;
  } = {},
): InventoryCandidate {
  return {
    numberId,
    partnerStatus: overrides.partnerStatus ?? "approved",
    device: overrides.device ?? onlineDevice(),
    number: {
      status: "available",
      enabled: true,
      countryCode: "ID",
      operatorCode: "any",
      ...overrides.number,
    },
    offer: {
      serviceCode: "wa",
      countryCode: "ID",
      operatorCode: "any",
      basePriceIdr: 1_000,
      status: "active",
      ...overrides.offer,
    },
  };
}

function expectDomainCode(action: () => unknown, code: Task52DomainError["code"]): void {
  try {
    action();
    throw new Error("Expected a Task52DomainError");
  } catch (error) {
    expect(error).toBeInstanceOf(Task52DomainError);
    expect((error as Task52DomainError).code).toBe(code);
  }
}

// **Validates: Requirements 5.4, 5.6, 6.1–6.4, 21.3, 21.5**
describe("Task 5.2 device capabilities and heartbeat", () => {
  it("parses explicit capabilities fail-closed and enforces operation support", () => {
    expect(parseDeviceCapabilities({ sms: true, slots: 2 })).toEqual({
      sms: true,
      notification: false,
      resend: false,
      operator: false,
      slots: 2,
    });
    expectDomainCode(
      () => parseDeviceCapabilities({ sms: "yes" }),
      "INVALID_DEVICE_CAPABILITIES",
    );
    expect(() => assertDeviceOperationAllowed(onlineDevice(), "sms")).not.toThrow();
    expectDomainCode(
      () => assertDeviceOperationAllowed(onlineDevice(), "notification"),
      "UNSUPPORTED_CAPABILITY",
    );
    expectDomainCode(
      () =>
        assertDeviceOperationAllowed(
          onlineDevice({ status: "disabled" }),
          "inventory",
        ),
      "DEVICE_DISABLED",
    );
  });

  it("uses server receipt time monotonically and keeps metadata non-authoritative", () => {
    const initial = onlineDevice({
      status: "offline",
      lastSeenAt: new Date("2026-07-22T10:00:05.000Z"),
    });
    const result = recordServerHeartbeat(initial, NOW, {
      metadata: {
        agentVersion: "1.2.3",
        signal: -75,
        operator: "Telkomsel",
        health: { battery: 80 },
        partnerId: "forged-partner",
        status: "disabled",
      },
    });

    expect(result.status).toBe("online");
    expect(result.lastSeenAt?.toISOString()).toBe("2026-07-22T10:00:05.000Z");
    expect(result.heartbeatMetadata).toEqual({
      agentVersion: "1.2.3",
      signal: -75,
      operator: "Telkomsel",
      health: { battery: 80 },
    });
    expect(result).not.toHaveProperty("partnerId");
    expect(recordServerHeartbeat(onlineDevice({ status: "disabled" }), NOW).status).toBe(
      "disabled",
    );
  });

  it("treats exactly 90 seconds as live and anything later as offline", () => {
    const boundary = onlineDevice({
      lastSeenAt: new Date(NOW.getTime() - MVP_HEARTBEAT_TIMEOUT_SECONDS * 1_000),
    });
    expect(isDeviceLive(boundary, NOW)).toBe(true);
    expect(effectiveDeviceStatus(boundary, NOW)).toBe("online");
    expect(
      isDeviceLive(
        onlineDevice({ lastSeenAt: new Date(NOW.getTime() - 90_001) }),
        NOW,
      ),
    ).toBe(false);
    expect(effectiveDeviceStatus(onlineDevice({ status: "disabled" }), NOW)).toBe(
      "disabled",
    );
  });

  it("accepts only allowlisted heartbeat metadata shapes", () => {
    expect(sanitizeHeartbeatMetadata(undefined)).toEqual({});
    expectDomainCode(
      () => sanitizeHeartbeatMetadata({ signal: 1.5 }),
      "INVALID_HEARTBEAT",
    );
    expectDomainCode(
      () => sanitizeHeartbeatMetadata({ health: { value: Number.NaN } }),
      "INVALID_HEARTBEAT",
    );
  });
});

// **Validates: Requirements 7.1–7.5**
describe("Task 5.2 Indonesian number domain", () => {
  it("normalizes equivalent Indonesian mobile representations idempotently", () => {
    const expected = "+6281234567890";
    for (const input of [
      "+62 812-3456-7890",
      "0062 (812) 3456 7890",
      "6281234567890",
      "0812.3456.7890",
      "81234567890",
      expected,
    ]) {
      expect(normalizeIndonesianNumber(input)).toBe(expected);
    }
    expect(normalizeIndonesianNumber(expected)).toBe(expected);
    expectDomainCode(() => normalizeIndonesianNumber("+621234567890"), "INVALID_PHONE_NUMBER");
    expectDomainCode(
      () => normalizeIndonesianNumber("+62 812 CALL NOW"),
      "INVALID_PHONE_NUMBER",
    );
  });

  it("rejects active canonical duplicates but permits disabled records and self updates", () => {
    const existing = [
      {
        id: "number-a",
        canonicalNumber: "+6281234567890",
        status: "available" as const,
      },
    ];
    expectDomainCode(
      () => assertUniqueActiveNumber("081234567890", existing),
      "DUPLICATE_ACTIVE_NUMBER",
    );
    expect(assertUniqueActiveNumber("081234567890", existing, "number-a")).toBe(
      "+6281234567890",
    );
    expect(
      assertUniqueActiveNumber("081234567890", [
        { ...existing[0], status: "disabled" },
      ]),
    ).toBe("+6281234567890");
  });

  it("guards move/delete and disable while reserved or busy", () => {
    for (const status of ["reserved", "busy"] as const) {
      expectDomainCode(() => assertNumberMoveOrDeleteAllowed(status), "NUMBER_STATE_GUARD");
      expectDomainCode(() => disableIdleNumber(status), "NUMBER_STATE_GUARD");
    }
    expect(() => assertNumberMoveOrDeleteAllowed("available")).not.toThrow();
    expect(disableIdleNumber("offline")).toBe("disabled");
    expect(reenableNumber()).toBe("offline");
  });

  it("preserves active-order states and recovers idle numbers only when fully ready", () => {
    const common = {
      enabled: true,
      hasActiveOrder: false,
      hasActiveOffer: true,
      device: onlineDevice(),
      nowServer: NOW,
    };
    expect(reconcileNumberAvailability({ status: "offline", ...common })).toBe(
      "available",
    );
    expect(
      reconcileNumberAvailability({
        status: "available",
        ...common,
        device: onlineDevice({ lastSeenAt: new Date(NOW.getTime() - 90_001) }),
      }),
    ).toBe("offline");
    expect(
      reconcileNumberAvailability({ status: "offline", ...common, hasActiveOrder: true }),
    ).toBe("offline");
    expect(
      reconcileNumberAvailability({ status: "offline", ...common, hasActiveOffer: false }),
    ).toBe("offline");
    expect(reconcileNumberAvailability({ status: "reserved", ...common })).toBe(
      "reserved",
    );
    expect(reconcileNumberAvailability({ status: "busy", ...common })).toBe("busy");
    expect(
      reconcileNumberAvailability({ status: "available", ...common, enabled: false }),
    ).toBe("disabled");
  });
});

// **Validates: Requirements 8.1–8.4, 8.6**
describe("Task 5.2 offer and authoritative pricing", () => {
  it("uses the exact MVP guardrail and authoritative pricing formula", () => {
    expect(calculateAuthoritativePricing({ basePriceIdr: 1_000 })).toEqual({
      retailPriceIdr: 1_400,
      payoutIdr: 1_000,
      platformMarginIdr: 400,
    });
    expect(calculateAuthoritativePricing({ basePriceIdr: 500 })).toEqual({
      retailPriceIdr: 850,
      payoutIdr: 500,
      platformMarginIdr: 350,
    });
    expect(calculateAuthoritativePricing({ basePriceIdr: 5_000 })).toEqual({
      retailPriceIdr: 6_000,
      payoutIdr: 5_000,
      platformMarginIdr: 1_000,
    });
    expectDomainCode(
      () => calculateAuthoritativePricing({ basePriceIdr: 499 }),
      "PRICE_OUT_OF_GUARDRAIL",
    );
    expectDomainCode(
      () => calculateAuthoritativePricing({ basePriceIdr: 5_001 }),
      "PRICE_OUT_OF_GUARDRAIL",
    );
  });

  it("ignores attempted client retail and payout fields", () => {
    const maliciousInput = {
      basePriceIdr: 1_000,
      retailPriceIdr: 1,
      payoutIdr: 999_999,
    };
    expect(calculateAuthoritativePricing(maliciousInput)).toEqual({
      retailPriceIdr: 1_400,
      payoutIdr: 1_000,
      platformMarginIdr: 400,
    });
  });

  it("validates pricing config and offer approval/catalog dimensions", () => {
    expect(validatePricingConfig(MVP_PRICING_CONFIG)).toBe(MVP_PRICING_CONFIG);
    expectDomainCode(
      () =>
        validatePricingConfig({
          ...MVP_PRICING_CONFIG,
          minBasePriceIdr: 5_001,
          maxBasePriceIdr: 5_000,
        }),
      "INVALID_CONFIG",
    );
    expectDomainCode(
      () => validatePricingConfig({ ...MVP_PRICING_CONFIG, roundToIdr: 0 }),
      "INVALID_CONFIG",
    );

    const validOffer = validateOffer("approved", {
      serviceCode: "wa",
      countryCode: "ID",
      operatorCode: "any",
      basePriceIdr: 1_000,
      status: "active",
    });
    expect(validOffer.configVersion).toBe(1);
    expect(validOffer.pricing.retailPriceIdr).toBe(1_400);
    expectDomainCode(
      () => validateOffer("suspended", validOffer),
      "PARTNER_NOT_APPROVED",
    );
    expectDomainCode(
      () => validateOffer("approved", { ...validOffer, serviceCode: "telegram" }),
      "INVALID_OFFER_CATALOG",
    );
  });
});

// **Validates: Requirements 6.3, 9.1, 9.4, 21.5**
describe("Task 5.2 deterministic eligible inventory", () => {
  const filter = {
    serviceCode: MVP_CATALOG.serviceCode,
    countryCode: MVP_CATALOG.countryCode,
    operatorCode: MVP_CATALOG.operatorCode,
  };

  it("requires every partner, device, number, offer, catalog, and SMS condition", () => {
    expect(isInventoryCandidateEligible(candidate("eligible"), filter, NOW)).toBe(true);

    const ineligible: InventoryCandidate[] = [
      candidate("partner", { partnerStatus: "suspended" }),
      candidate("device-status", { device: onlineDevice({ status: "disabled" }) }),
      candidate("stale", {
        device: onlineDevice({ lastSeenAt: new Date(NOW.getTime() - 90_001) }),
      }),
      candidate("capability", {
        device: onlineDevice({
          capabilities: { ...SMS_CAPABILITIES, sms: false },
        }),
      }),
      candidate("number-state", { number: { status: "reserved" } }),
      candidate("number-enabled", { number: { enabled: false } }),
      candidate("active-order", { number: { hasActiveOrder: true } }),
      candidate("offer-status", { offer: { status: "inactive" } }),
      candidate("offer-catalog", { offer: { serviceCode: "telegram" } }),
      candidate("number-country", { number: { countryCode: "SG" } }),
      candidate("number-operator", { number: { operatorCode: "telkomsel" } }),
    ];

    for (const item of ineligible) {
      expect(isInventoryCandidateEligible(item, filter, NOW), item.numberId).toBe(false);
    }
  });

  it("selects number.id ASC without mutating candidate order", () => {
    const candidates = [
      candidate("number-c", { partnerStatus: "pending" }),
      candidate("number-b"),
      candidate("number-a"),
    ];
    const originalOrder = candidates.map((item) => item.numberId);

    expect(selectEligibleInventory(candidates, filter, NOW)?.numberId).toBe("number-a");
    expect(candidates.map((item) => item.numberId)).toEqual(originalOrder);
  });

  it("returns deterministic stockout without changing input", () => {
    const candidates = Object.freeze([
      candidate("disabled", { device: onlineDevice({ status: "disabled" }) }),
      candidate("offline", { device: onlineDevice({ status: "offline" }) }),
    ]);
    const before = JSON.stringify(candidates);

    expect(selectEligibleInventory(candidates, filter, NOW)).toBeNull();
    expect(JSON.stringify(candidates)).toBe(before);
  });
});