import { describe, expect, it } from "vitest";

import {
  MVP_PRICING_CONFIG,
  Task52DomainError,
  assertBasePriceWithinGuardrail,
  assertNumberMoveOrDeleteAllowed,
  assertUniqueActiveNumber,
  assertDeviceOperationAllowed,
  calculateAuthoritativePricing,
  describeDimensionOverrides,
  effectiveDeviceStatus,
  isDeviceLive,
  normalizeIndonesianNumber,
  parseDeviceCapabilities,
  reconcileNumberAvailability,
  recordServerHeartbeat,
  sanitizeHeartbeatMetadata,
  resolveDimensionPricing,
  resolveServedCatalog,
  resolveServedDimension,
  selectEligibleInventory,
  validateDimensionDeclaration,
  validateOffer,
  validatePricingConfig,
  type CatalogDimension,
  type DimensionDeclarationInput,
  type DeviceState,
  type ExistingNumberIdentity,
  type InventoryCandidate,
  type InventoryFilter,
  type OfferInput,
} from "./task-5-2-device-inventory-pricing";

const NOW = new Date("2026-05-01T00:00:00.000Z");

/** The MVP dimension as a declared, enabled catalog row with no overrides. */
const MVP_CATALOG_DIMENSION: CatalogDimension = Object.freeze({
  serviceCode: "wa",
  countryCode: "ID",
  operatorCode: "any",
  enabled: true,
});

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

  // The platform serves a SET of dimensions, so an offer's dimension is checked
  // by MEMBERSHIP of the enabled catalog rather than equality with the config's
  // own dimension. Before this, a partner could not create a Telegram offer at
  // all, because the only acceptable dimension was the config row's.
  describe("catalog dimension membership", () => {
    const telegram: OfferInput = { ...offer, serviceCode: "tg" };

    /** The MVP dimension plus a second one, both enabled, no overrides. */
    const bothEnabled: readonly CatalogDimension[] = Object.freeze([
      { serviceCode: "wa", countryCode: "ID", operatorCode: "any", enabled: true },
      { serviceCode: "tg", countryCode: "ID", operatorCode: "any", enabled: true },
    ]);

    it("accepts an offer on any ENABLED dimension, not just the config's own", () => {
      const validated = validateOffer("approved", telegram, MVP_PRICING_CONFIG, bothEnabled);
      expect(validated.serviceCode).toBe("tg");
      // With no override the dimension inherits the global formula exactly.
      expect(validated.pricing.retailPriceIdr).toBe(1_400);
      expect(validated.pricing.payoutIdr).toBe(1_000);
      // The snapshot version stays the GLOBAL config version.
      expect(validated.configVersion).toBe(MVP_PRICING_CONFIG.version);
    });

    it("rejects a DISABLED dimension with the existing error code", () => {
      const disabled: readonly CatalogDimension[] = [
        { serviceCode: "wa", countryCode: "ID", operatorCode: "any", enabled: true },
        { serviceCode: "tg", countryCode: "ID", operatorCode: "any", enabled: false },
      ];
      expectCode(
        () => validateOffer("approved", telegram, MVP_PRICING_CONFIG, disabled),
        "INVALID_OFFER_CATALOG",
      );
    });

    it("rejects an UNKNOWN dimension with the existing error code", () => {
      expectCode(
        () => validateOffer("approved", telegram, MVP_PRICING_CONFIG, bothEnabled.slice(0, 1)),
        "INVALID_OFFER_CATALOG",
      );
      // An empty catalog serves nothing at all.
      expectCode(
        () => validateOffer("approved", offer, MVP_PRICING_CONFIG, []),
        "INVALID_OFFER_CATALOG",
      );
    });

    it("still gates on partner approval before looking at the catalog", () => {
      expectCode(
        () => validateOffer("suspended", telegram, MVP_PRICING_CONFIG, bothEnabled),
        "PARTNER_NOT_APPROVED",
      );
    });

    it("defaults to the config's own dimension when no catalog is supplied", () => {
      // Backwards compatibility: the previous single-dimension behaviour.
      expect(validateOffer("approved", offer).pricing.retailPriceIdr).toBe(1_400);
      expectCode(() => validateOffer("approved", telegram), "INVALID_OFFER_CATALOG");
    });
  });

  // An UNDECLARED catalog (no dimension rows at all) must serve the config's own
  // dimension. This is not cosmetic: the documented deploy order runs the
  // migration BEFORE the config seed, so a fresh install briefly has a config
  // with an empty dimension table. Reading that as "nothing is served" would
  // leave the platform unable to sell anything at all.
  describe("undeclared catalog fallback", () => {
    const empty = { dimensions: [] as const, declared: false };

    it("serves the config's own dimension when nothing has been declared", () => {
      expect(resolveServedCatalog(empty, MVP_PRICING_CONFIG)).toEqual([
        { serviceCode: "wa", countryCode: "ID", operatorCode: "any", enabled: true },
      ]);
      const resolved = resolveServedDimension(
        { dimension: null, declared: false },
        MVP_PRICING_CONFIG,
        { serviceCode: "wa", countryCode: "ID", operatorCode: "any" },
      );
      expect(resolved?.serviceCode).toBe("wa");
      expect(resolved?.enabled).toBe(true);
    });

    it("still refuses a dimension the config does not describe", () => {
      expect(
        resolveServedDimension({ dimension: null, declared: false }, MVP_PRICING_CONFIG, {
          serviceCode: "tg",
          countryCode: "ID",
          operatorCode: "any",
        }),
      ).toBeNull();
    });

    it("treats a DECLARED catalog as authoritative, never falling back", () => {
      // Every dimension disabled means the platform serves nothing — the
      // opposite of an undeclared catalog, and it must not be overridden.
      const allDisabled = {
        dimensions: [] as const,
        declared: true,
      };
      expect(resolveServedCatalog(allDisabled, MVP_PRICING_CONFIG)).toEqual([]);
      expect(
        resolveServedDimension(
          {
            dimension: { ...MVP_CATALOG_DIMENSION, enabled: false },
            declared: true,
          },
          MVP_PRICING_CONFIG,
          { serviceCode: "wa", countryCode: "ID", operatorCode: "any" },
        ),
      ).toBeNull();
    });

    it("resolves a declared, enabled dimension to itself", () => {
      expect(
        resolveServedDimension(
          { dimension: MVP_CATALOG_DIMENSION, declared: true },
          MVP_PRICING_CONFIG,
          { serviceCode: "wa", countryCode: "ID", operatorCode: "any" },
        ),
      ).toBe(MVP_CATALOG_DIMENSION);
    });
  });

  // A dimension may override the pricing inputs `calculateAuthoritativePricing`
  // consumes; every unset override falls back to the global config, so the
  // config row stays the single source for the platform-wide values.
  describe("per-dimension pricing overrides", () => {
    it("prices an offer by the dimension's overrides when it carries them", () => {
      const dimensions: readonly CatalogDimension[] = [
        {
          serviceCode: "tg",
          countryCode: "ID",
          operatorCode: "any",
          enabled: true,
          fixedFeeIdr: 500,
          markupBps: 3_000,
          roundToIdr: 100,
        },
      ];
      const validated = validateOffer(
        "approved",
        { ...offer, serviceCode: "tg" },
        MVP_PRICING_CONFIG,
        dimensions,
      );
      // 1000 + 500 fee + ceil(1000*3000/10000)=300 -> 1800, ceilTo(1800,100)=1800.
      expect(validated.pricing.retailPriceIdr).toBe(1_800);
      expect(validated.pricing.payoutIdr).toBe(1_000);
      expect(validated.pricing.platformMarginIdr).toBe(800);
    });

    it("falls back to the global config for every unset override", () => {
      const partial: CatalogDimension = {
        serviceCode: "wa",
        countryCode: "ID",
        operatorCode: "any",
        enabled: true,
        // Only the fee is overridden; markup and rounding stay global.
        fixedFeeIdr: 350,
      };
      const resolved = resolveDimensionPricing(partial, MVP_PRICING_CONFIG);
      expect(resolved.fixedFeeIdr).toBe(350);
      expect(resolved.markupBps).toBe(MVP_PRICING_CONFIG.markupBps);
      expect(resolved.roundToIdr).toBe(MVP_PRICING_CONFIG.roundToIdr);
      expect(resolved.minBasePriceIdr).toBe(MVP_PRICING_CONFIG.minBasePriceIdr);
      expect(resolved.maxBasePriceIdr).toBe(MVP_PRICING_CONFIG.maxBasePriceIdr);
      // The global values are never overridable per dimension.
      expect(resolved.currency).toBe(MVP_PRICING_CONFIG.currency);
      expect(resolved.version).toBe(MVP_PRICING_CONFIG.version);

      // 1000 + 350 + 150 = 1500 -> ceilTo(1500, 50) = 1500.
      const validated = validateOffer("approved", offer, MVP_PRICING_CONFIG, [partial]);
      expect(validated.pricing.retailPriceIdr).toBe(1_500);
    });

    it("applies an overridden guardrail to the base price", () => {
      const dearer: readonly CatalogDimension[] = [
        {
          serviceCode: "tg",
          countryCode: "ID",
          operatorCode: "any",
          enabled: true,
          minBasePriceIdr: 2_000,
          maxBasePriceIdr: 9_000,
        },
      ];
      // 1000 is fine globally (500..5000) but below THIS dimension's minimum.
      expectCode(
        () => validateOffer("approved", { ...offer, serviceCode: "tg" }, MVP_PRICING_CONFIG, dearer),
        "PRICE_OUT_OF_GUARDRAIL",
      );
      // 8000 exceeds the global maximum but is inside this dimension's range.
      const validated = validateOffer(
        "approved",
        { ...offer, serviceCode: "tg", basePriceIdr: 8_000 },
        MVP_PRICING_CONFIG,
        dearer,
      );
      expect(validated.pricing.payoutIdr).toBe(8_000);
    });
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

/**
 * Validation for the admin declare path.
 *
 * Declaring a dimension used to mean running raw `INSERT` SQL against the live
 * database. These rules are the pure half of the admin command that replaces it:
 * every rejection here mirrors something `catalog_dimensions` would refuse
 * anyway — the VARCHAR(32)/CHAR(2) widths, `catalog_dimensions_code_check`, and
 * the per-column bounds of `catalog_dimensions_pricing_check` — so an operator
 * gets a named field and a stable code instead of a constraint crash.
 *
 * **Validates: Requirements 16.5, 19.1**
 */
describe("catalog dimension declaration validation", () => {
  const VALID: DimensionDeclarationInput = {
    serviceCode: "tg",
    countryCode: "ID",
    operatorCode: "any",
    enabled: true,
  };

  /** The violation codes for one input, so a case can assert exactly what failed. */
  function codesFor(input: DimensionDeclarationInput): readonly string[] {
    const result = validateDimensionDeclaration(input);
    return result.valid ? [] : result.violations.map((violation) => violation.code);
  }

  it("accepts a minimal dimension and normalises it to the stored row", () => {
    const result = validateDimensionDeclaration(VALID);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("expected a valid declaration");
    // Every unset override becomes an explicit null: "inherit the global config".
    expect(result.declaration).toEqual({
      serviceCode: "tg",
      countryCode: "ID",
      operatorCode: "any",
      enabled: true,
      minBasePriceIdr: null,
      maxBasePriceIdr: null,
      fixedFeeIdr: null,
      markupBps: null,
      roundToIdr: null,
      note: null,
    });
    // Frozen, as every returned literal in this module is.
    expect(Object.isFrozen(result.declaration)).toBe(true);
  });

  it("trims whitespace and upper-cases the country code", () => {
    const result = validateDimensionDeclaration({
      ...VALID,
      serviceCode: "  tg  ",
      // `id` and `ID` are unambiguously the same country, and the CHECK stores
      // the upper form, so this is normalised rather than refused.
      countryCode: " id ",
      operatorCode: " any ",
      note: "  permintaan klien  ",
    });
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("expected a valid declaration");
    expect(result.declaration.serviceCode).toBe("tg");
    expect(result.declaration.countryCode).toBe("ID");
    expect(result.declaration.operatorCode).toBe("any");
    expect(result.declaration.note).toBe("permintaan klien");
  });

  it("keeps a withheld dimension withheld", () => {
    const result = validateDimensionDeclaration({ ...VALID, enabled: false });
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("expected a valid declaration");
    expect(result.declaration.enabled).toBe(false);
  });

  it("rejects an empty, over-long, or malformed service code", () => {
    expect(codesFor({ ...VALID, serviceCode: "" })).toEqual(["INVALID_SERVICE_CODE"]);
    expect(codesFor({ ...VALID, serviceCode: "   " })).toEqual(["INVALID_SERVICE_CODE"]);
    // VARCHAR(32): 32 fits, 33 does not.
    expect(codesFor({ ...VALID, serviceCode: "a".repeat(32) })).toEqual([]);
    expect(codesFor({ ...VALID, serviceCode: "a".repeat(33) })).toEqual(["INVALID_SERVICE_CODE"]);
    // A code is a machine identifier that reaches URLs, quote filters, and order
    // snapshots, so mixed case and inner whitespace are refused rather than
    // normalised — two codes that look identical would be a real hazard.
    expect(codesFor({ ...VALID, serviceCode: "WA" })).toEqual(["INVALID_SERVICE_CODE"]);
    expect(codesFor({ ...VALID, serviceCode: "wa tg" })).toEqual(["INVALID_SERVICE_CODE"]);
    expect(codesFor({ ...VALID, serviceCode: "-wa" })).toEqual(["INVALID_SERVICE_CODE"]);
    // `_` and `-` inside a code are fine; they already appear in operator codes.
    expect(codesFor({ ...VALID, serviceCode: "wa_biz-2" })).toEqual([]);
  });

  it("rejects a country code that is not ISO-2", () => {
    expect(codesFor({ ...VALID, countryCode: "IDN" })).toEqual(["INVALID_COUNTRY_CODE"]);
    expect(codesFor({ ...VALID, countryCode: "I" })).toEqual(["INVALID_COUNTRY_CODE"]);
    expect(codesFor({ ...VALID, countryCode: "" })).toEqual(["INVALID_COUNTRY_CODE"]);
    expect(codesFor({ ...VALID, countryCode: "1D" })).toEqual(["INVALID_COUNTRY_CODE"]);
  });

  it("rejects an empty or malformed operator code", () => {
    expect(codesFor({ ...VALID, operatorCode: "" })).toEqual(["INVALID_OPERATOR_CODE"]);
    expect(codesFor({ ...VALID, operatorCode: "ANY" })).toEqual(["INVALID_OPERATOR_CODE"]);
    expect(codesFor({ ...VALID, operatorCode: "a".repeat(33) })).toEqual(["INVALID_OPERATOR_CODE"]);
  });

  it("collects every violation instead of stopping at the first", () => {
    expect(codesFor({ serviceCode: "", countryCode: "XYZ", operatorCode: "", enabled: true })).toEqual([
      "INVALID_SERVICE_CODE",
      "INVALID_COUNTRY_CODE",
      "INVALID_OPERATOR_CODE",
    ]);
  });

  // These bounds are exactly `catalog_dimensions_pricing_check`, which in turn
  // mirrors the global `platform_configs_policy_check`.
  it("accepts the price-override guardrail boundaries", () => {
    // Zero is a valid fee/markup/guardrail; `roundToIdr` is a divisor in the
    // pricing formula, so its floor is 1 rather than 0.
    expect(
      codesFor({
        ...VALID,
        minBasePriceIdr: 0,
        maxBasePriceIdr: 0,
        fixedFeeIdr: 0,
        markupBps: 0,
        roundToIdr: 1,
      }),
    ).toEqual([]);
  });

  it("rejects a negative, fractional, or non-finite price override", () => {
    expect(codesFor({ ...VALID, fixedFeeIdr: -1 })).toEqual(["INVALID_PRICE_OVERRIDE"]);
    expect(codesFor({ ...VALID, markupBps: -1 })).toEqual(["INVALID_PRICE_OVERRIDE"]);
    expect(codesFor({ ...VALID, minBasePriceIdr: -1 })).toEqual(["INVALID_PRICE_OVERRIDE"]);
    expect(codesFor({ ...VALID, roundToIdr: 0 })).toEqual(["INVALID_PRICE_OVERRIDE"]);
    expect(codesFor({ ...VALID, roundToIdr: -50 })).toEqual(["INVALID_PRICE_OVERRIDE"]);
    expect(codesFor({ ...VALID, fixedFeeIdr: 12.5 })).toEqual(["INVALID_PRICE_OVERRIDE"]);
    expect(codesFor({ ...VALID, fixedFeeIdr: Number.NaN })).toEqual(["INVALID_PRICE_OVERRIDE"]);
    expect(codesFor({ ...VALID, fixedFeeIdr: Number.POSITIVE_INFINITY })).toEqual([
      "INVALID_PRICE_OVERRIDE",
    ]);
    expect(codesFor({ ...VALID, fixedFeeIdr: Number.MAX_SAFE_INTEGER + 2 })).toEqual([
      "INVALID_PRICE_OVERRIDE",
    ]);
  });

  // The columns are INTEGER, so anything past int4 cannot be stored even though
  // it satisfies every CHECK expression. The driver rejects the parameter before
  // the statement runs and Prisma reports a codeless
  // `PrismaClientUnknownRequestError`, which the admin action can only render as
  // a 500 — so the bound has to be caught here, as a named field violation.
  it("rejects an override past the INTEGER column limit", () => {
    const int4Max = 2_147_483_647;
    expect(codesFor({ ...VALID, fixedFeeIdr: int4Max })).toEqual([]);
    expect(codesFor({ ...VALID, fixedFeeIdr: int4Max + 1 })).toEqual(["INVALID_PRICE_OVERRIDE"]);
    expect(codesFor({ ...VALID, markupBps: 3_000_000_000 })).toEqual(["INVALID_PRICE_OVERRIDE"]);
    expect(codesFor({ ...VALID, roundToIdr: int4Max + 1 })).toEqual(["INVALID_PRICE_OVERRIDE"]);
    // Both guardrail bounds at the ceiling stay a valid, correctly-ordered pair.
    expect(codesFor({ ...VALID, minBasePriceIdr: int4Max, maxBasePriceIdr: int4Max })).toEqual([]);
  });

  it("treats null and undefined overrides alike as inherit-the-global", () => {
    const nulled = validateDimensionDeclaration({
      ...VALID,
      minBasePriceIdr: null,
      maxBasePriceIdr: undefined,
      fixedFeeIdr: null,
      markupBps: undefined,
      roundToIdr: null,
    });
    expect(nulled.valid).toBe(true);
    if (!nulled.valid) throw new Error("expected a valid declaration");
    expect(nulled.declaration.minBasePriceIdr).toBeNull();
    expect(nulled.declaration.maxBasePriceIdr).toBeNull();
    expect(nulled.declaration.markupBps).toBeNull();
  });

  it("rejects an inverted guardrail only when BOTH bounds are overridden", () => {
    expect(codesFor({ ...VALID, minBasePriceIdr: 5_000, maxBasePriceIdr: 1_000 })).toEqual([
      "INVALID_PRICE_GUARDRAIL_ORDER",
    ]);
    // Equal bounds are a valid single-price dimension.
    expect(codesFor({ ...VALID, minBasePriceIdr: 1_000, maxBasePriceIdr: 1_000 })).toEqual([]);
    // A half-override inherits the other bound from the global config, which is
    // already internally consistent, so there is nothing to compare.
    expect(codesFor({ ...VALID, minBasePriceIdr: 5_000 })).toEqual([]);
    expect(codesFor({ ...VALID, maxBasePriceIdr: 100 })).toEqual([]);
  });

  it("rejects a note longer than the column", () => {
    // VARCHAR(500): 500 fits, 501 does not.
    expect(codesFor({ ...VALID, note: "n".repeat(500) })).toEqual([]);
    expect(codesFor({ ...VALID, note: "n".repeat(501) })).toEqual(["INVALID_NOTE"]);
  });

  it("normalises a blank note to null rather than an empty string", () => {
    const result = validateDimensionDeclaration({ ...VALID, note: "   " });
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("expected a valid declaration");
    expect(result.declaration.note).toBeNull();
  });
});

/**
 * The read view's override/inherited summary, so an operator can see what a
 * dimension actually charges without re-deriving the `?? config` fallback.
 *
 * **Validates: Requirements 16.5**
 */
describe("describeDimensionOverrides", () => {
  it("reports every pricing input as inherited when none is overridden", () => {
    expect(describeDimensionOverrides(MVP_CATALOG_DIMENSION)).toEqual({
      minBasePriceIdr: false,
      maxBasePriceIdr: false,
      fixedFeeIdr: false,
      markupBps: false,
      roundToIdr: false,
    });
  });

  it("distinguishes an overridden input from an inherited one", () => {
    const described = describeDimensionOverrides({
      ...MVP_CATALOG_DIMENSION,
      fixedFeeIdr: 500,
      markupBps: 3_000,
      // An explicit null is an inherit, exactly like an absent field.
      roundToIdr: null,
    });
    expect(described).toEqual({
      minBasePriceIdr: false,
      maxBasePriceIdr: false,
      fixedFeeIdr: true,
      markupBps: true,
      roundToIdr: false,
    });
    expect(Object.isFrozen(described)).toBe(true);
  });

  it("treats a zero override as overridden, not inherited", () => {
    // Zero is a meaningful fee: "this dimension charges no fixed fee", which is
    // NOT the same as inheriting the global fee.
    const described = describeDimensionOverrides({ ...MVP_CATALOG_DIMENSION, fixedFeeIdr: 0 });
    expect(described.fixedFeeIdr).toBe(true);
  });
});
