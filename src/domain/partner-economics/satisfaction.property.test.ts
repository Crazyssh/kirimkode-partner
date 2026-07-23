import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { PartnerEconomicsError } from "./errors";
import {
  bandForPercent,
  computeSatisfaction,
  GREEN_THRESHOLD_PERCENT,
  RED_THRESHOLD_PERCENT,
  type SatisfactionResult,
} from "./satisfaction";

// Roadmap item 4 — Overall satisfaction metric (HeroSMS Partners study).
// Properties: ratio ∈ [0,1]; band consistent with the >60/30–60/<30 thresholds;
// totalRequests === 0 → null; successfullyIssued > totalRequests → throw.

const NUM_RUNS = 100;

// A well-formed window: total >= 1 with success bounded by total, so the metric
// is always defined and the ratio is genuinely in [0, 1].
const definedWindow = fc
  .integer({ min: 1, max: 1_000_000 })
  .chain((totalRequests) =>
    fc.record({
      totalRequests: fc.constant(totalRequests),
      successfullyIssued: fc.integer({ min: 0, max: totalRequests }),
    }),
  );

describe("computeSatisfaction properties", () => {
  it("keeps ratio in [0,1] and percent in [0,100] for any defined window", () => {
    fc.assert(
      fc.property(definedWindow, ({ successfullyIssued, totalRequests }) => {
        const result = computeSatisfaction({
          successfullyIssued,
          totalRequests,
        });
        expect(result).not.toBeNull();
        const r = result as SatisfactionResult;

        expect(r.ratio).toBeGreaterThanOrEqual(0);
        expect(r.ratio).toBeLessThanOrEqual(1);
        expect(r.ratio).toBe(successfullyIssued / totalRequests);

        expect(r.percent).toBeGreaterThanOrEqual(0);
        expect(r.percent).toBeLessThanOrEqual(100);
        // percent is the ratio as a 1-decimal percentage.
        expect(r.percent).toBe(Math.round(r.ratio * 1000) / 10);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("agrees with bandForPercent and the >60 / 30–60 / <30 thresholds", () => {
    fc.assert(
      fc.property(definedWindow, ({ successfullyIssued, totalRequests }) => {
        const r = computeSatisfaction({
          successfullyIssued,
          totalRequests,
        }) as SatisfactionResult;

        // The reported band is exactly the band of the reported percent.
        expect(r.band).toBe(bandForPercent(r.percent));

        // ...and that band obeys the HeroSMS colour rule.
        if (r.percent > GREEN_THRESHOLD_PERCENT) {
          expect(r.band).toBe("green");
        } else if (r.percent < RED_THRESHOLD_PERCENT) {
          expect(r.band).toBe("red");
        } else {
          expect(r.band).toBe("yellow");
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("is monotonic: more successes for the same total never lowers the ratio", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 1_000_000 })
          .chain((totalRequests) =>
            fc.record({
              totalRequests: fc.constant(totalRequests),
              a: fc.integer({ min: 0, max: totalRequests }),
              b: fc.integer({ min: 0, max: totalRequests }),
            }),
          ),
        ({ totalRequests, a, b }) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const rLo = computeSatisfaction({
            successfullyIssued: lo,
            totalRequests,
          }) as SatisfactionResult;
          const rHi = computeSatisfaction({
            successfullyIssued: hi,
            totalRequests,
          }) as SatisfactionResult;
          expect(rHi.ratio).toBeGreaterThanOrEqual(rLo.ratio);
          expect(rHi.percent).toBeGreaterThanOrEqual(rLo.percent);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("returns null exactly when there is no demand", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (totalRequests) => {
        // successfullyIssued is bounded by total to stay a valid window.
        const successfullyIssued =
          totalRequests === 0 ? 0 : totalRequests % (totalRequests + 1);
        const result = computeSatisfaction({
          successfullyIssued,
          totalRequests,
        });
        if (totalRequests === 0) {
          expect(result).toBeNull();
        } else {
          expect(result).not.toBeNull();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("throws INVALID_RATIO whenever successes exceed requests", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (totalRequests, excess) => {
          const successfullyIssued = totalRequests + excess;
          try {
            computeSatisfaction({ successfullyIssued, totalRequests });
            expect.unreachable("should have thrown");
          } catch (error) {
            expect(error).toBeInstanceOf(PartnerEconomicsError);
            expect((error as PartnerEconomicsError).code).toBe("INVALID_RATIO");
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
