/**
 * Alert SIGNAL evaluation (task 16.5; design section 12; requirement 20.3).
 *
 * The MVP does not ship a full alerting system — it ships *signals*: pure,
 * deterministic predicates over the metrics/state a caller has already
 * gathered, each firing when the design's fixed threshold is crossed. An
 * operator (or a thin scheduled probe) reads {@link evaluateAlertSignals} and
 * decides what to do; this module never sends a page, so it stays a pure,
 * exhaustively testable function.
 *
 * Design section 12 fixes exactly six thresholds:
 *
 *  1. readiness failing continuously for ≥ 2 minutes,
 *  2. 5xx error rate > 5% over a 5-minute window,
 *  3. a simulator heartbeat older than 90 seconds,
 *  4. an order stuck longer than its configured timeout + 2 minutes,
 *  5. a ledger imbalance greater than 0,
 *  6. a payout in `processing` for more than 24 hours.
 *
 * Each check is independent: a signal that lacks its input is simply not
 * evaluated (absent input never fires), and every firing signal carries a
 * redaction-free, human-readable `reason` plus the observed vs. threshold
 * numbers so the operator can act without opening a dashboard.
 */
import { serverErrorRate } from "./metrics";

/** The closed set of alert signal identifiers. */
export type AlertSignalType =
  | "readiness_failing"
  | "high_5xx_error_rate"
  | "stale_simulator_heartbeat"
  | "order_stuck"
  | "ledger_imbalance"
  | "payout_processing_stalled";

/** Severity of a firing signal (mirrors the shared vocabulary). */
export type AlertSeverity = "warning" | "critical";

/** A single firing alert signal. */
export interface AlertSignal {
  readonly type: AlertSignalType;
  readonly severity: AlertSeverity;
  /** The observed value that crossed the threshold. */
  readonly observed: number;
  /** The design threshold the observed value crossed. */
  readonly threshold: number;
  /** Human-readable, secret-free explanation. */
  readonly reason: string;
  /** Optional reference to the specific entity (order id, payout id). */
  readonly referenceId?: string;
}

/** Fixed thresholds from design section 12. */
export const READINESS_FAILING_MS = 2 * 60 * 1000; // 2 minutes
export const ERROR_RATE_THRESHOLD = 0.05; // 5%
export const STALE_HEARTBEAT_MS = 90 * 1000; // 90 seconds
export const ORDER_STUCK_GRACE_MS = 2 * 60 * 1000; // timeout + 2 minutes
export const PAYOUT_PROCESSING_MS = 24 * 60 * 60 * 1000; // 24 hours

/** A single order the caller believes may be stuck. */
export interface StuckOrderInput {
  readonly orderId: string;
  /** How long the order has been in its non-terminal active state. */
  readonly ageMs: number;
  /** The configured order timeout that applies to this order. */
  readonly timeoutMs: number;
}

/** A single payout the caller believes may be stalled in `processing`. */
export interface StalledPayoutInput {
  readonly payoutId: string;
  /** How long the payout has been in the `processing` state. */
  readonly processingMs: number;
}

/** Everything the six signal checks can inspect. Every field is optional. */
export interface AlertSignalInput {
  /**
   * How long readiness has been *continuously* failing, in ms. `null`/absent
   * means readiness is currently healthy.
   */
  readonly readinessFailingForMs?: number | null;
  /** Requests observed in the 5-minute window. */
  readonly requestWindowTotal?: number;
  /** 5xx responses observed in the same window. */
  readonly requestWindow5xx?: number;
  /** Age of the freshest simulator heartbeat, in ms. */
  readonly simulatorHeartbeatAgeMs?: number | null;
  /** Active orders to test for the stuck threshold. */
  readonly activeOrders?: readonly StuckOrderInput[];
  /**
   * Absolute ledger imbalance (0 when balanced). Any value > 0 fires the
   * critical `ledger_imbalance` signal.
   */
  readonly ledgerImbalance?: number;
  /** Payouts currently in `processing`. */
  readonly processingPayouts?: readonly StalledPayoutInput[];
}

/**
 * Evaluate all six signals against the supplied snapshot and return the firing
 * ones in a deterministic order (readiness, error rate, heartbeat, stuck
 * orders, ledger, payouts). An empty array means everything is within
 * threshold.
 */
export function evaluateAlertSignals(
  input: AlertSignalInput,
): readonly AlertSignal[] {
  const signals: AlertSignal[] = [];

  // 1. Readiness failing ≥ 2 minutes.
  const readinessMs = input.readinessFailingForMs;
  if (
    readinessMs !== null &&
    readinessMs !== undefined &&
    readinessMs >= READINESS_FAILING_MS
  ) {
    signals.push({
      type: "readiness_failing",
      severity: "critical",
      observed: readinessMs,
      threshold: READINESS_FAILING_MS,
      reason: `Readiness has been failing for ${readinessMs}ms (threshold ${READINESS_FAILING_MS}ms).`,
    });
  }

  // 2. 5xx error rate > 5% over the window.
  if (input.requestWindowTotal !== undefined) {
    const rate = serverErrorRate({
      totalRequests: input.requestWindowTotal,
      serverErrors: input.requestWindow5xx ?? 0,
    });
    if (rate > ERROR_RATE_THRESHOLD) {
      signals.push({
        type: "high_5xx_error_rate",
        severity: "critical",
        observed: rate,
        threshold: ERROR_RATE_THRESHOLD,
        reason: `5xx error rate ${(rate * 100).toFixed(2)}% exceeds ${(ERROR_RATE_THRESHOLD * 100).toFixed(0)}% over the window.`,
      });
    }
  }

  // 3. Stale simulator heartbeat > 90s.
  const heartbeatAge = input.simulatorHeartbeatAgeMs;
  if (
    heartbeatAge !== null &&
    heartbeatAge !== undefined &&
    heartbeatAge > STALE_HEARTBEAT_MS
  ) {
    signals.push({
      type: "stale_simulator_heartbeat",
      severity: "warning",
      observed: heartbeatAge,
      threshold: STALE_HEARTBEAT_MS,
      reason: `Simulator heartbeat is ${heartbeatAge}ms old (threshold ${STALE_HEARTBEAT_MS}ms).`,
    });
  }

  // 4. Order stuck > timeout + 2 minutes (one signal per offending order).
  for (const order of input.activeOrders ?? []) {
    const limit = order.timeoutMs + ORDER_STUCK_GRACE_MS;
    if (order.ageMs > limit) {
      signals.push({
        type: "order_stuck",
        severity: "critical",
        observed: order.ageMs,
        threshold: limit,
        reason: `Order has been active for ${order.ageMs}ms (timeout ${order.timeoutMs}ms + ${ORDER_STUCK_GRACE_MS}ms grace).`,
        referenceId: order.orderId,
      });
    }
  }

  // 5. Ledger imbalance > 0.
  if (input.ledgerImbalance !== undefined && input.ledgerImbalance > 0) {
    signals.push({
      type: "ledger_imbalance",
      severity: "critical",
      observed: input.ledgerImbalance,
      threshold: 0,
      reason: `Ledger imbalance of ${input.ledgerImbalance} detected; expected 0.`,
    });
  }

  // 6. Payout stuck in processing > 24 hours (one signal per offending payout).
  for (const payout of input.processingPayouts ?? []) {
    if (payout.processingMs > PAYOUT_PROCESSING_MS) {
      signals.push({
        type: "payout_processing_stalled",
        severity: "warning",
        observed: payout.processingMs,
        threshold: PAYOUT_PROCESSING_MS,
        reason: `Payout has been processing for ${payout.processingMs}ms (threshold ${PAYOUT_PROCESSING_MS}ms).`,
        referenceId: payout.payoutId,
      });
    }
  }

  return Object.freeze(signals.map((signal) => Object.freeze(signal)));
}
