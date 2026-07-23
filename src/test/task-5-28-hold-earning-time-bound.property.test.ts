import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeBucketBalances,
  decideEarningReversal,
  decideHoldRelease,
  type EarningState,
  holdReleaseEventKey,
} from "@domain/task-5-6";

import { type FakeClock, installFakeClock, restoreFakeClock } from "./fake-clock";

// Feature: partner-platform, Property 21: Hold Earning berbatas waktu
//
// For all Earning pending dan waktu observasi, Earning berubah ke available
// tepat ketika `now>=availableAt` dan tidak ada dispute/reversal; sebelum itu
// status dan ledger tetap pending.
//
// **Validates: Requirements 13.2, 13.4**
//
// Design references:
// - "Setelah 24 jam tanpa dispute, `pending->available`" dan reversal valid
//   mengubah pending/available->reversed; earning yang sudah reversed tidak dapat
//   dirilis lagi (Components §9 "Earning dan Payout", Req 13.2/13.4).
// - Hold-release memindah `partner_pending -> partner_available` sebesar amount
//   dengan `eventKey` unik `hold-release:{earningId}`, sehingga retry release
//   menjadi no-op deterministik tanpa ledger event tambahan (Components §10).
// - Waktu observasi memakai fake clock harness; seluruh waktu disimpan UTC
//   (Testing Strategy §Property-Based Testing, Keputusan Final "Waktu").
// - Pure domain test tidak memakai DB/network (Testing Strategy).
// - Hold-release adalah transisi state-machine Earning, salah satu target
//   500-run pada nightly CI (Testing Strategy §Property-Based Testing).

const NUM_RUNS = 500;

// Keep availableAt comfortably above the epoch so that a negative observation
// offset still yields a valid, non-negative instant for the fake clock.
const MIN_AVAILABLE_AT_MS = 90 * 24 * 60 * 60 * 1000; // ~90 days after epoch
const MAX_AVAILABLE_AT_MS = 4_102_444_800_000; // year 2100
const MAX_OFFSET_MS = 30 * 24 * 60 * 60 * 1000; // +/-30 days around availableAt

interface HoldScenario {
  readonly earningId: string;
  readonly amountIdr: number;
  readonly availableAtMs: number;
  // Observation time expressed as an offset from availableAt so the boundary
  // (offset === 0) and both sides are exercised densely.
  readonly offsetMs: number;
  readonly hasActiveDispute: boolean;
  readonly reverseFirst: boolean;
  readonly releaseRetries: number;
}

const scenarioArbitrary: fc.Arbitrary<HoldScenario> = fc.record({
  earningId: fc.uuid(),
  amountIdr: fc.integer({ min: 1, max: 1_000_000_000 }),
  availableAtMs: fc.integer({ min: MIN_AVAILABLE_AT_MS, max: MAX_AVAILABLE_AT_MS }),
  offsetMs: fc.integer({ min: -MAX_OFFSET_MS, max: MAX_OFFSET_MS }),
  hasActiveDispute: fc.boolean(),
  reverseFirst: fc.boolean(),
  releaseRetries: fc.integer({ min: 0, max: 3 }),
});

let clock: FakeClock;

describe("Property 21: Hold Earning berbatas waktu", () => {
  beforeEach(() => {
    clock = installFakeClock();
  });

  afterEach(() => {
    restoreFakeClock();
  });

  it("releases pending earnings exactly when now>=availableAt without dispute/reversal, and keeps them pending otherwise", () => {
    fc.assert(
      fc.property(scenarioArbitrary, (scenario) => {
        const pending: EarningState = Object.freeze({
          id: scenario.earningId,
          orderId: `order-${scenario.earningId}`,
          amountIdr: scenario.amountIdr,
          status: "pending",
          availableAt: new Date(scenario.availableAtMs),
        });

        // Observation time sourced from the fake clock (harness), not Date.now
        // directly, so the domain stays pure while the test controls "now".
        const nowMs = scenario.availableAtMs + scenario.offsetMs;
        clock.set(new Date(nowMs));
        const now = clock.now();
        expect(now.getTime()).toBe(nowMs);

        const holdElapsed = now.getTime() >= pending.availableAt.getTime();
        const eventKey = holdReleaseEventKey(pending.id);

        // ---------------------------------------------------------------
        // Reversal path: a reversed earning can never be released (Req 13.5),
        // regardless of the observation time.
        // ---------------------------------------------------------------
        if (scenario.reverseFirst) {
          const reversal = decideEarningReversal({
            earning: pending,
            reason: "refund",
          });
          expect(reversal.kind).toBe("reverse");
          if (reversal.kind !== "reverse") return;

          const reversed: EarningState = { ...pending, status: "reversed" };
          const afterReversal = decideHoldRelease({
            earning: reversed,
            now,
            hasActiveDispute: scenario.hasActiveDispute,
          });

          // No release, no ledger transfer to available: invalid state.
          expect(afterReversal.kind).toBe("reject");
          if (afterReversal.kind === "reject") {
            expect(afterReversal.code).toBe("invalid_state");
          }
          expect("transaction" in afterReversal).toBe(false);
          return;
        }

        const decision = decideHoldRelease({
          earning: pending,
          now,
          hasActiveDispute: scenario.hasActiveDispute,
        });

        if (scenario.hasActiveDispute) {
          // Dispute blocks release even after the hold elapses: stays pending.
          expect(decision.kind).toBe("reject");
          if (decision.kind === "reject") {
            expect(decision.code).toBe("dispute_active");
          }
          expect("transaction" in decision).toBe(false);
          return;
        }

        if (!holdElapsed) {
          // Before availableAt: no release, no ledger movement, still pending.
          expect(decision.kind).toBe("reject");
          if (decision.kind === "reject") {
            expect(decision.code).toBe("hold_not_elapsed");
          }
          expect("transaction" in decision).toBe(false);
          return;
        }

        // now >= availableAt and no dispute/reversal => release exactly once.
        expect(decision.kind).toBe("release");
        if (decision.kind !== "release") return;
        expect(decision.nextStatus).toBe("available");
        expect(decision.eventKey).toBe(eventKey);

        // The hold-release ledger event is zero-sum and moves the full amount
        // from partner_pending to partner_available.
        const balances = computeBucketBalances([...decision.transaction.entries]);
        expect(balances.partner_pending).toBe(-scenario.amountIdr);
        expect(balances.partner_available).toBe(scenario.amountIdr);
        expect(
          decision.transaction.entries.reduce(
            (sum, entry) => sum + entry.amountIdrSigned,
            0,
          ),
        ).toBe(0);

        // Retrying release on the now-available earning is a deterministic
        // no-op: no additional ledger event is produced (append-only).
        const available: EarningState = { ...pending, status: "available" };
        for (let r = 0; r < scenario.releaseRetries; r++) {
          const retry = decideHoldRelease({
            earning: available,
            // Retries may observe a later clock without changing the outcome.
            now: new Date(now.getTime() + r + 1),
            hasActiveDispute: false,
          });
          expect(retry.kind).toBe("no_change");
          if (retry.kind === "no_change") {
            expect(retry.reason).toBe("already_available");
          }
          expect("transaction" in retry).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
