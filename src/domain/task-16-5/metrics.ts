/**
 * Metric catalog and pure aggregation helpers (task 16.5; design section 12;
 * requirement 20.3).
 *
 * Design section 12 fixes the minimum metric set the platform must expose:
 * per-API request count / error / latency; DB pool; eligible inventory;
 * reservation success / stockout / conflict; order terminal count and success
 * latency; unmatched / ambiguous SMS; heartbeat age and offline-device count;
 * pending / available earning; payout count by state; job duration / failure;
 * and reconciliation issue count.
 *
 * This module is the source of truth for that catalog: each entry declares a
 * stable {@link MetricName}, its {@link MetricKind} (counter / gauge /
 * histogram), unit, and label keys, so the infrastructure registry and any
 * exporter stay in lock-step with the design. It also provides the small pure
 * aggregations the alert-signal layer consumes (notably the 5xx error rate),
 * keeping threshold arithmetic out of the I/O layer and unit-testable.
 */

/** The kind of a metric, mirroring the usual counter/gauge/histogram trichotomy. */
export type MetricKind = "counter" | "gauge" | "histogram";

/** A single metric definition in the catalog. */
export interface MetricDefinition {
  readonly name: MetricName;
  readonly kind: MetricKind;
  readonly help: string;
  readonly unit: string;
  /** Label keys that partition the metric (e.g. `api`, `state`). */
  readonly labels: readonly string[];
}

/** The closed set of metric names the design mandates. */
export type MetricName =
  | "partner_request_total"
  | "partner_request_error_total"
  | "partner_request_latency_ms"
  | "partner_db_pool_in_use"
  | "partner_db_pool_size"
  | "partner_eligible_inventory"
  | "partner_reservation_success_total"
  | "partner_reservation_stockout_total"
  | "partner_reservation_conflict_total"
  | "partner_order_terminal_total"
  | "partner_order_success_latency_ms"
  | "partner_sms_unmatched_total"
  | "partner_sms_ambiguous_total"
  | "partner_device_heartbeat_age_ms"
  | "partner_device_offline"
  | "partner_earning_pending_idr"
  | "partner_earning_available_idr"
  | "partner_payout_by_state"
  | "partner_job_duration_ms"
  | "partner_job_failure_total"
  | "partner_reconciliation_issue";

/**
 * The metric catalog. Every metric the design's section 12 enumerates appears
 * exactly once; the infrastructure registry validates recorded samples against
 * this list so a typo cannot silently create a shadow metric.
 */
export const METRIC_CATALOG: readonly MetricDefinition[] = Object.freeze([
  // Per-API request health.
  { name: "partner_request_total", kind: "counter", help: "Requests handled, per API and method.", unit: "requests", labels: ["api", "method"] },
  { name: "partner_request_error_total", kind: "counter", help: "Errored requests, per API and status class.", unit: "requests", labels: ["api", "statusClass"] },
  { name: "partner_request_latency_ms", kind: "histogram", help: "Request handling latency, per API.", unit: "ms", labels: ["api"] },
  // Database connection pool.
  { name: "partner_db_pool_in_use", kind: "gauge", help: "Database connections currently checked out.", unit: "connections", labels: [] },
  { name: "partner_db_pool_size", kind: "gauge", help: "Configured database pool size.", unit: "connections", labels: [] },
  // Inventory.
  { name: "partner_eligible_inventory", kind: "gauge", help: "Eligible (available, approved) numbers per offer.", unit: "numbers", labels: ["offer"] },
  // Reservation outcomes.
  { name: "partner_reservation_success_total", kind: "counter", help: "Successful reservations.", unit: "reservations", labels: [] },
  { name: "partner_reservation_stockout_total", kind: "counter", help: "Reservations rejected for stockout.", unit: "reservations", labels: [] },
  { name: "partner_reservation_conflict_total", kind: "counter", help: "Reservations lost to a contention conflict.", unit: "reservations", labels: [] },
  // Order lifecycle.
  { name: "partner_order_terminal_total", kind: "counter", help: "Orders reaching a terminal state, per state.", unit: "orders", labels: ["terminalState"] },
  { name: "partner_order_success_latency_ms", kind: "histogram", help: "Reserve→success latency.", unit: "ms", labels: [] },
  // SMS matching.
  { name: "partner_sms_unmatched_total", kind: "counter", help: "Inbound SMS that matched no active order.", unit: "messages", labels: [] },
  { name: "partner_sms_ambiguous_total", kind: "counter", help: "Inbound SMS with an ambiguous OTP match.", unit: "messages", labels: [] },
  // Devices / heartbeat.
  { name: "partner_device_heartbeat_age_ms", kind: "gauge", help: "Age of the most recent heartbeat, per device.", unit: "ms", labels: ["device"] },
  { name: "partner_device_offline", kind: "gauge", help: "Devices currently considered offline.", unit: "devices", labels: [] },
  // Earnings.
  { name: "partner_earning_pending_idr", kind: "gauge", help: "Pending (held) earning balance.", unit: "idr", labels: [] },
  { name: "partner_earning_available_idr", kind: "gauge", help: "Available (released) earning balance.", unit: "idr", labels: [] },
  // Payouts.
  { name: "partner_payout_by_state", kind: "gauge", help: "Payout count per lifecycle state.", unit: "payouts", labels: ["state"] },
  // Jobs.
  { name: "partner_job_duration_ms", kind: "histogram", help: "Cron job run duration, per job.", unit: "ms", labels: ["job"] },
  { name: "partner_job_failure_total", kind: "counter", help: "Cron job failures, per job.", unit: "runs", labels: ["job"] },
  // Reconciliation.
  { name: "partner_reconciliation_issue", kind: "gauge", help: "Open reconciliation issues, per type.", unit: "issues", labels: ["type"] },
]);

/** Index the catalog by name for O(1) validation/lookup. */
export const METRIC_DEFINITIONS_BY_NAME: ReadonlyMap<MetricName, MetricDefinition> =
  new Map(METRIC_CATALOG.map((definition) => [definition.name, definition]));

/** True when `name` is a metric the catalog defines. */
export function isKnownMetric(name: string): name is MetricName {
  return METRIC_DEFINITIONS_BY_NAME.has(name as MetricName);
}

/** Inputs for the pure 5xx error-rate aggregation. */
export interface RequestErrorRateInput {
  /** Total requests observed in the window. */
  readonly totalRequests: number;
  /** Requests that returned a 5xx status in the window. */
  readonly serverErrors: number;
}

/**
 * Fraction (0..1) of requests that were server errors. Returns 0 when no
 * requests were observed, so an idle window never raises a false alarm.
 */
export function serverErrorRate(input: RequestErrorRateInput): number {
  if (input.totalRequests <= 0) return 0;
  const rate = input.serverErrors / input.totalRequests;
  if (rate < 0) return 0;
  return rate > 1 ? 1 : rate;
}
