import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  describeTenure,
  resolveEarningHoldMs,
} from "./payout-tenure";

// Feature: partner-economics roadmap Item 1 — tenure-based earning HOLD.
//
// Encodes the HeroSMS tenure rule (see .agents/RESEARCH-HEROSMS-PARTNERS.md §4):
// immature partners (no sale yet, or < maturity window since the first sale)
// are held longer; matured partners get the shorter hold. Pure domain: time is
// injected as Date parameters. These properties assert:
//   - the resolved hold is ALWAYS exactly one of the two configured hold values;
//   - maturity is a monotone step at the maturity boundary — strictly before it
//     the partner is immature, at or after it the partner is matured;
//   - a partner never regresses from matured back to immature as `now` advances.

const NUM_RUNS = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const configArb = fc.record({
  maturityDays: fc.integer({ min: 1, max: 365 }),
  immatureHoldMs: fc.integer({ min: 1, max: 1_000_000_000 }),
  matureHoldMs: fc.integer({ min: 1, max: 1_000_000_000 }),
});

// A first-sale epoch small enough that adding up to ~400 days stays a safe int.
const firstSaleMsArb = fc.integer({ min: 0, max: 1_000_000_000_000 });
const elapsedMsArb = fc.integer({ min: 0, max: 400 * MS_PER_DAY });

describe("resolveEarningHoldMs — property", () => {
  it("always returns exactly one of the two configured hold values", () => {
    fc.assert(
      fc.property(
        fc.option(firstSaleMsArb, { nil: null }),
        elapsedMsArb,
        configArb,
        (firstSaleMs, elapsedMs, config) => {
          const nowMs = (firstSaleMs ?? 0) + elapsedMs;
          const hold = resolveEarningHoldMs({
            firstSuccessfulSaleAt:
              firstSaleMs === null ? null : new Date(firstSaleMs),
            now: new Date(nowMs),
            ...config,
          });
          expect([config.immatureHoldMs, config.matureHoldMs]).toContain(hold);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("is always immature when there is no successful sale", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000_000 }), configArb, (nowMs, config) => {
        const hold = resolveEarningHoldMs({
          firstSuccessfulSaleAt: null,
          now: new Date(nowMs),
          ...config,
        });
        expect(hold).toBe(config.immatureHoldMs);
        expect(
          describeTenure({
            firstSuccessfulSaleAt: null,
            now: new Date(nowMs),
            ...config,
          }),
        ).toEqual({ matured: false, tenureDays: 0 });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("maps elapsed tenure to the correct hold on each side of the boundary", () => {
    fc.assert(
      fc.property(
        firstSaleMsArb,
        elapsedMsArb,
        configArb,
        (firstSaleMs, elapsedMs, config) => {
          const input = {
            firstSuccessfulSaleAt: new Date(firstSaleMs),
            now: new Date(firstSaleMs + elapsedMs),
            ...config,
          };
          const maturityMs = config.maturityDays * MS_PER_DAY;
          const hold = resolveEarningHoldMs(input);
          const view = describeTenure(input);
          if (elapsedMs < maturityMs) {
            expect(hold).toBe(config.immatureHoldMs);
            expect(view.matured).toBe(false);
          } else {
            expect(hold).toBe(config.matureHoldMs);
            expect(view.matured).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("flips to matured exactly at the boundary (immature at boundary-1ms)", () => {
    fc.assert(
      fc.property(
        firstSaleMsArb,
        fc.integer({ min: 1, max: 365 }),
        (firstSaleMs, maturityDays) => {
          const maturityMs = maturityDays * MS_PER_DAY;
          const firstSale = new Date(firstSaleMs);
          expect(
            describeTenure({
              firstSuccessfulSaleAt: firstSale,
              now: new Date(firstSaleMs + maturityMs),
              maturityDays,
            }).matured,
          ).toBe(true);
          expect(
            describeTenure({
              firstSuccessfulSaleAt: firstSale,
              now: new Date(firstSaleMs + maturityMs - 1),
              maturityDays,
            }).matured,
          ).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("never regresses from matured to immature as now advances", () => {
    fc.assert(
      fc.property(
        firstSaleMsArb,
        elapsedMsArb,
        elapsedMsArb,
        configArb,
        (firstSaleMs, a, b, config) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const early = describeTenure({
            firstSuccessfulSaleAt: new Date(firstSaleMs),
            now: new Date(firstSaleMs + lo),
            ...config,
          });
          const late = describeTenure({
            firstSuccessfulSaleAt: new Date(firstSaleMs),
            now: new Date(firstSaleMs + hi),
            ...config,
          });
          // Once matured, stays matured; tenure is non-decreasing in `now`.
          if (early.matured) {
            expect(late.matured).toBe(true);
          }
          expect(late.tenureDays).toBeGreaterThanOrEqual(early.tenureDays);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
