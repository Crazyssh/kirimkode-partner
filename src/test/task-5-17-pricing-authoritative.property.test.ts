import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  calculateAuthoritativePricing,
  MVP_CATALOG,
  MVP_PRICING_CONFIG,
  OfferInput,
  PartnerStatus,
  PricingConfig,
  Task52DomainError,
  validateOffer,
} from "@domain/task-5-2-device-inventory-pricing";

// Feature: partner-platform, Property 10: Pricing, guardrail, dan server authority
//
// For all integer base price dan config valid, offer diterima tepat ketika
// Rp500<=base<=Rp5.000, `retail=ceilTo(base+250+ceil(base*1500/10000),50)`,
// payout=base, margin=retail-payout, dan field retail/payout dari client tidak
// pernah memengaruhi hasil.
//
// **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.6**
//
// Design references:
// - Pricing formula & guardrail (Components §2, Keputusan Final MVP "Harga").
// - Client hanya mengirim base; retail/payout selalu dihitung server (8.6).
// - Testing Strategy: pricing ditargetkan 500 run di CI malam.

const NUM_RUNS = 500;
const CONFIG: PricingConfig = MVP_PRICING_CONFIG;

// Independent reference re-implementation of the authoritative formula so the
// test does not merely echo the production code path.
function expectedRetail(base: number, config: PricingConfig): number {
  const markup = Math.ceil((base * config.markupBps) / 10_000);
  const unrounded = base + config.fixedFeeIdr + markup;
  return Math.ceil(unrounded / config.roundToIdr) * config.roundToIdr;
}

function isWithinGuardrail(base: number, config: PricingConfig): boolean {
  return (
    Number.isSafeInteger(base) &&
    base >= config.minBasePriceIdr &&
    base <= config.maxBasePriceIdr
  );
}

// Base price generator sweeping the safe integer domain: exact guardrail edges,
// dense in-range values, wide out-of-range integers (negative + very large),
// and non-integer/degenerate inputs that must all be rejected fail-closed.
const basePriceArbitrary = fc.oneof(
  fc.constantFrom(
    0,
    -1,
    499,
    500,
    501,
    1_000,
    4_999,
    5_000,
    5_001,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
  ),
  fc.integer({ min: 500, max: 5_000 }),
  fc.integer({ min: -100_000, max: 100_000 }),
  fc.integer({ min: 5_001, max: Number.MAX_SAFE_INTEGER }),
  fc.double({ min: 500, max: 5_000, noNaN: true }),
);

// Garbage the client might try to smuggle in to influence retail/payout. The
// domain contract only reads basePriceIdr, so these must never change output.
const clientOverrideArbitrary = fc.record({
  retailPriceIdr: fc.integer({ min: -1_000_000, max: 1_000_000 }),
  payoutIdr: fc.integer({ min: -1_000_000, max: 1_000_000 }),
  platformMarginIdr: fc.integer({ min: -1_000_000, max: 1_000_000 }),
});

const partnerStatusArbitrary = fc.constantFrom<PartnerStatus>(
  "pending",
  "approved",
  "suspended",
  "rejected",
);

describe("Property 10: pricing, guardrail, and server authority", () => {
  it("accepts base exactly within guardrail, computes authoritative retail/payout, and ignores client fields", () => {
    fc.assert(
      fc.property(
        basePriceArbitrary,
        clientOverrideArbitrary,
        partnerStatusArbitrary,
        (base, clientOverride, partnerStatus) => {
          const withinGuardrail = isWithinGuardrail(base, CONFIG);

          if (withinGuardrail) {
            // Requirement 8.4: authoritative retail follows the exact formula and
            // payout equals base; margin is derived, not client supplied.
            const result = calculateAuthoritativePricing({ basePriceIdr: base }, CONFIG);
            const retail = expectedRetail(base, CONFIG);
            expect(result.retailPriceIdr).toBe(retail);
            expect(result.payoutIdr).toBe(base);
            expect(result.platformMarginIdr).toBe(retail - base);
            // Rounding invariant: retail is always a multiple of roundToIdr.
            expect(result.retailPriceIdr % CONFIG.roundToIdr).toBe(0);
            // Margin covers at least the fixed fee, so it is strictly positive.
            expect(result.platformMarginIdr).toBeGreaterThanOrEqual(CONFIG.fixedFeeIdr);

            // Requirement 8.6: extra client-controlled fields on the input object
            // never influence the authoritative result.
            const polluted = { basePriceIdr: base, ...clientOverride } as {
              readonly basePriceIdr: number;
            };
            const pollutedResult = calculateAuthoritativePricing(polluted, CONFIG);
            expect(pollutedResult).toEqual(result);
          } else {
            // Requirements 8.2/8.3: base outside the guardrail (including non-safe
            // integers, negatives, and overflow candidates) is always rejected.
            expect(() => calculateAuthoritativePricing({ basePriceIdr: base }, CONFIG)).toThrow(
              Task52DomainError,
            );
            try {
              calculateAuthoritativePricing({ basePriceIdr: base }, CONFIG);
            } catch (error) {
              expect((error as Task52DomainError).code).toBe("PRICE_OUT_OF_GUARDRAIL");
            }
          }

          // Requirement 8.1: an approved partner offer matching the catalog is
          // associated with service/country/operator/base/status plus the
          // server-derived pricing snapshot and config version. Client-supplied
          // retail/payout on the offer payload are ignored (8.6).
          const offerPayload = {
            serviceCode: MVP_CATALOG.serviceCode,
            countryCode: MVP_CATALOG.countryCode,
            operatorCode: MVP_CATALOG.operatorCode,
            basePriceIdr: base,
            status: "active" as const,
            ...clientOverride,
          } as OfferInput;

          if (partnerStatus !== "approved") {
            // Requirement 8.1 gate: only approved partners create offers.
            expect(() => validateOffer(partnerStatus, offerPayload, CONFIG)).toThrow(
              Task52DomainError,
            );
          } else if (withinGuardrail) {
            const offer = validateOffer(partnerStatus, offerPayload, CONFIG);
            expect(offer.serviceCode).toBe(MVP_CATALOG.serviceCode);
            expect(offer.countryCode).toBe(MVP_CATALOG.countryCode);
            expect(offer.operatorCode).toBe(MVP_CATALOG.operatorCode);
            expect(offer.basePriceIdr).toBe(base);
            expect(offer.status).toBe("active");
            expect(offer.configVersion).toBe(CONFIG.version);
            // Pricing is recomputed authoritatively regardless of client fields.
            expect(offer.pricing).toEqual(calculateAuthoritativePricing({ basePriceIdr: base }, CONFIG));
          } else {
            // Requirement 8.3: offer with out-of-guardrail base is rejected.
            expect(() => validateOffer(partnerStatus, offerPayload, CONFIG)).toThrow(
              Task52DomainError,
            );
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
