import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  calculateAuthoritativePricing,
  MVP_CATALOG,
  MVP_PRICING_CONFIG,
  type PricingConfig,
} from "@domain/task-5-2-device-inventory-pricing";
import type { OrderSnapshotData } from "@application/orders/ports";

// Feature: partner-platform, Property 11: Snapshot order immutable
//
// For all reservasi berhasil, snapshot sama dengan dimensi offer dan hasil
// pricing authoritative pada saat reservasi; perubahan offer/config setelahnya
// tidak mengubah snapshot/order lama dan hanya muncul pada reservasi baru.
//
// **Validates: Requirements 8.5, 9.5**
//
// Design references:
// - `OrderSnapshotData` immutable setelah reserve (Data Models, requirement 9.5):
//   snapshot mencakup service/country/operator/base/retail/payout + currency +
//   configVersion.
// - Keputusan Final MVP "Harga" + Components §2: perubahan aturan harga atau
//   base price hanya berlaku untuk reservasi berikutnya (requirement 8.5).
// - Reservation service (task 9.3) menyusun snapshot dari config dimensi + base
//   winner + `calculateAuthoritativePricing`. Test ini menargetkan implementasi
//   pure domain (pricing authoritative) yang menjadi sumber nilai snapshot.

const NUM_RUNS = 100;

/**
 * Pure reserve-time snapshot derivation, mirroring `ReservationService`
 * (`runReserveEffect`) exactly: authoritative pricing over the winner base
 * price plus the catalog dimensions and version from the config active at
 * reserve time. The returned object is frozen because a persisted snapshot is
 * immutable once the reservation commits.
 */
function deriveReserveSnapshot(
  config: PricingConfig,
  canonicalNumber: string,
  basePriceIdr: number,
): OrderSnapshotData {
  const pricing = calculateAuthoritativePricing({ basePriceIdr }, config);
  return Object.freeze({
    serviceCode: config.serviceCode,
    countryCode: config.countryCode,
    operatorCode: config.operatorCode,
    canonicalNumber,
    basePriceIdr,
    retailPriceIdr: pricing.retailPriceIdr,
    payoutIdr: pricing.payoutIdr,
    platformMarginIdr: pricing.platformMarginIdr,
    currency: config.currency,
    configVersion: config.version,
  });
}

// Independent re-implementation of the authoritative retail formula so the
// snapshot's derived money fields are verified against a second source rather
// than merely echoing the production path (requirement 9.5).
function expectedRetail(base: number, config: PricingConfig): number {
  const markup = Math.ceil((base * config.markupBps) / 10_000);
  const unrounded = base + config.fixedFeeIdr + markup;
  return Math.ceil(unrounded / config.roundToIdr) * config.roundToIdr;
}

// Config variations keep the MVP catalog dimensions and the Rp500–Rp5.000
// guardrail fixed (so any generated base stays valid across a config change)
// while sweeping version, fixed fee, markup, and rounding unit. These are the
// pricing rules an admin can change after a reservation exists.
const configArbitrary: fc.Arbitrary<PricingConfig> = fc
  .record({
    version: fc.integer({ min: 1, max: 100_000 }),
    fixedFeeIdr: fc.integer({ min: 0, max: 5_000 }),
    markupBps: fc.integer({ min: 0, max: 10_000 }),
    roundToIdr: fc.constantFrom(1, 5, 10, 25, 50, 100),
  })
  .map((overrides) => ({ ...MVP_PRICING_CONFIG, ...overrides }));

const baseArbitrary = fc.integer({ min: 500, max: 5_000 });
const canonicalNumberArbitrary = fc
  .tuple(fc.integer({ min: 1, max: 9 }), fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 8, maxLength: 11 }))
  .map(([first, rest]) => `+628${first}${rest.join("")}`);

describe("Property 11: snapshot order immutable", () => {
  it("freezes the reserve-time snapshot and applies offer/config changes only to new reservations", () => {
    fc.assert(
      fc.property(
        // Reservation A: config + base + number captured at reserve time.
        configArbitrary,
        baseArbitrary,
        canonicalNumberArbitrary,
        // Reservation B: the offer/config as changed AFTER reservation A.
        configArbitrary,
        baseArbitrary,
        (config1Seed, base1, canonicalNumber, config2Seed, base2) => {
          // Mutable copies so we can prove a later edit cannot reach back into
          // an already-derived snapshot. A locally-writable view of the
          // (readonly) PricingConfig lets us mutate the reserve-time inputs
          // after the snapshot is derived; a mutable value stays assignable to
          // the readonly parameter of deriveReserveSnapshot/expectedRetail.
          const config1: { -readonly [K in keyof PricingConfig]: PricingConfig[K] } = {
            ...config1Seed,
          };
          const offer1 = {
            serviceCode: MVP_CATALOG.serviceCode,
            countryCode: MVP_CATALOG.countryCode,
            operatorCode: MVP_CATALOG.operatorCode,
            basePriceIdr: base1,
          };

          // Reservation A commits: derive + persist the immutable snapshot.
          const snapshotA = deriveReserveSnapshot(config1, canonicalNumber, offer1.basePriceIdr);
          const snapshotAFrozenCopy = structuredClone(snapshotA);

          // Requirement 9.5: snapshot carries the offer dimensions and the
          // authoritative pricing (verified against the independent formula),
          // plus currency and the config version active at reserve time.
          const retail1 = expectedRetail(base1, config1);
          expect(snapshotA.serviceCode).toBe(MVP_CATALOG.serviceCode);
          expect(snapshotA.countryCode).toBe(MVP_CATALOG.countryCode);
          expect(snapshotA.operatorCode).toBe(MVP_CATALOG.operatorCode);
          expect(snapshotA.canonicalNumber).toBe(canonicalNumber);
          expect(snapshotA.basePriceIdr).toBe(base1);
          expect(snapshotA.retailPriceIdr).toBe(retail1);
          expect(snapshotA.payoutIdr).toBe(base1);
          expect(snapshotA.platformMarginIdr).toBe(retail1 - base1);
          expect(snapshotA.currency).toBe(config1.currency);
          expect(snapshotA.configVersion).toBe(config1Seed.version);
          // A committed snapshot is immutable.
          expect(Object.isFrozen(snapshotA)).toBe(true);

          // Requirement 8.5: the offer base price and the platform pricing rules
          // change AFTER reservation A. This must not touch reservation A.
          offer1.basePriceIdr = base2;
          config1.version = config1Seed.version + 1;
          config1.fixedFeeIdr = (config1.fixedFeeIdr + 137) % 5_001;
          config1.markupBps = (config1.markupBps + 251) % 10_001;

          // Reservation B (a NEW reservation) uses the changed config/base.
          const config2: PricingConfig = { ...config2Seed };
          const snapshotB = deriveReserveSnapshot(config2, canonicalNumber, base2);

          // The old snapshot is byte-for-byte what it was at reserve time: the
          // later edits to offer1/config1 and deriving B did not mutate it.
          expect(snapshotA).toEqual(snapshotAFrozenCopy);
          // And it still equals a fresh derivation from the pristine reserve-time
          // inputs — the change is invisible to the existing order.
          expect(snapshotA).toEqual(
            deriveReserveSnapshot(config1Seed, canonicalNumber, base1),
          );

          // The new reservation reflects the changed inputs (requirement 9.5 for B).
          const retail2 = expectedRetail(base2, config2);
          expect(snapshotB.basePriceIdr).toBe(base2);
          expect(snapshotB.retailPriceIdr).toBe(retail2);
          expect(snapshotB.payoutIdr).toBe(base2);
          expect(snapshotB.platformMarginIdr).toBe(retail2 - base2);
          expect(snapshotB.configVersion).toBe(config2Seed.version);

          // When the pricing inputs actually differ, the change surfaces ONLY on
          // the new reservation: B differs from A while A is unchanged.
          const pricingInputsDiffer =
            base1 !== base2 ||
            config1Seed.version !== config2Seed.version ||
            retail1 !== retail2;
          if (pricingInputsDiffer) {
            expect(snapshotB).not.toEqual(snapshotA);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
