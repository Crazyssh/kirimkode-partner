import { describe, expect, it } from "vitest";

import {
  evaluateAlertSignals,
  ERROR_RATE_THRESHOLD,
  ORDER_STUCK_GRACE_MS,
  PAYOUT_PROCESSING_MS,
  READINESS_FAILING_MS,
  STALE_HEARTBEAT_MS,
  type AlertSignalType,
} from "./alert-signals";

function firingTypes(...args: Parameters<typeof evaluateAlertSignals>): AlertSignalType[] {
  return evaluateAlertSignals(...args).map((signal) => signal.type);
}

// **Validates: Requirements 20.3, 20.4**
describe("task 16.5 alert signals", () => {
  it("fires nothing when every input is within threshold", () => {
    expect(
      evaluateAlertSignals({
        readinessFailingForMs: null,
        requestWindowTotal: 100,
        requestWindow5xx: 1,
        simulatorHeartbeatAgeMs: 10_000,
        activeOrders: [{ orderId: "o-1", ageMs: 1000, timeoutMs: 20 * 60 * 1000 }],
        ledgerImbalance: 0,
        processingPayouts: [{ payoutId: "p-1", processingMs: 60_000 }],
      }),
    ).toEqual([]);
  });

  it("fires readiness_failing at exactly 2 minutes and not just below", () => {
    expect(firingTypes({ readinessFailingForMs: READINESS_FAILING_MS })).toContain(
      "readiness_failing",
    );
    expect(firingTypes({ readinessFailingForMs: READINESS_FAILING_MS - 1 })).not.toContain(
      "readiness_failing",
    );
  });

  it("fires high_5xx_error_rate strictly above 5% only", () => {
    // 6/100 = 6% > 5% fires.
    expect(firingTypes({ requestWindowTotal: 100, requestWindow5xx: 6 })).toContain(
      "high_5xx_error_rate",
    );
    // Exactly 5% does not fire (threshold is strict `>`).
    expect(firingTypes({ requestWindowTotal: 100, requestWindow5xx: 5 })).not.toContain(
      "high_5xx_error_rate",
    );
    // An idle window never raises a false alarm.
    expect(firingTypes({ requestWindowTotal: 0, requestWindow5xx: 0 })).not.toContain(
      "high_5xx_error_rate",
    );
  });

  it("reports the observed error rate on the fired signal", () => {
    const [signal] = evaluateAlertSignals({ requestWindowTotal: 200, requestWindow5xx: 20 });
    expect(signal.type).toBe("high_5xx_error_rate");
    expect(signal.observed).toBeCloseTo(0.1);
    expect(signal.threshold).toBe(ERROR_RATE_THRESHOLD);
  });

  it("fires stale_simulator_heartbeat strictly above 90 seconds", () => {
    expect(firingTypes({ simulatorHeartbeatAgeMs: STALE_HEARTBEAT_MS + 1 })).toContain(
      "stale_simulator_heartbeat",
    );
    expect(firingTypes({ simulatorHeartbeatAgeMs: STALE_HEARTBEAT_MS })).not.toContain(
      "stale_simulator_heartbeat",
    );
  });

  it("fires order_stuck per order beyond timeout + 2 minutes", () => {
    const timeoutMs = 20 * 60 * 1000;
    const signals = evaluateAlertSignals({
      activeOrders: [
        { orderId: "stuck", ageMs: timeoutMs + ORDER_STUCK_GRACE_MS + 1, timeoutMs },
        { orderId: "ok", ageMs: timeoutMs + ORDER_STUCK_GRACE_MS, timeoutMs },
      ],
    });
    const stuck = signals.filter((s) => s.type === "order_stuck");
    expect(stuck).toHaveLength(1);
    expect(stuck[0].referenceId).toBe("stuck");
  });

  it("fires ledger_imbalance for any imbalance greater than 0", () => {
    expect(firingTypes({ ledgerImbalance: 1 })).toContain("ledger_imbalance");
    expect(firingTypes({ ledgerImbalance: 0 })).not.toContain("ledger_imbalance");
  });

  it("fires payout_processing_stalled per payout beyond 24 hours", () => {
    const signals = evaluateAlertSignals({
      processingPayouts: [
        { payoutId: "stalled", processingMs: PAYOUT_PROCESSING_MS + 1 },
        { payoutId: "fresh", processingMs: PAYOUT_PROCESSING_MS },
      ],
    });
    const stalled = signals.filter((s) => s.type === "payout_processing_stalled");
    expect(stalled).toHaveLength(1);
    expect(stalled[0].referenceId).toBe("stalled");
  });

  it("fires multiple independent signals together in a deterministic order", () => {
    const types = firingTypes({
      readinessFailingForMs: READINESS_FAILING_MS,
      requestWindowTotal: 100,
      requestWindow5xx: 50,
      simulatorHeartbeatAgeMs: STALE_HEARTBEAT_MS + 1000,
      ledgerImbalance: 5,
    });
    expect(types).toEqual([
      "readiness_failing",
      "high_5xx_error_rate",
      "stale_simulator_heartbeat",
      "ledger_imbalance",
    ]);
  });
});
