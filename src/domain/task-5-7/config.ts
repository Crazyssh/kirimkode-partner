import { Task57DomainError } from "./errors";

/**
 * Retention windows for sensitive/operational data (Req 19.4). All values are
 * durations in milliseconds measured from the relevant boundary event.
 */
export interface RetentionConfig {
  /** Raw inbound SMS ciphertext: redact after 7 days. */
  readonly smsRawMs: number;
  /** Extracted OTP: redact 24h after the order reaches a terminal state. */
  readonly otpAfterTerminalMs: number;
  /** Heartbeat metadata samples: prune after 30 days. */
  readonly heartbeatMetadataMs: number;
  /** Security log events: delete after 90 days. */
  readonly securityLogMs: number;
  /** Audit events: retain for 7 years. */
  readonly auditMs: number;
  /** Ledger/payout financial records: retain for 7 years. */
  readonly ledgerPayoutMs: number;
}

/**
 * Versioned platform configuration (Req 16.5). Holds price guardrail, pricing
 * formula inputs, timeouts, heartbeat cadence, hold period, minimum payout,
 * retention windows, and the simulator allowlist flag.
 */
export interface PlatformConfigInput {
  readonly minBasePriceIdr: number;
  readonly maxBasePriceIdr: number;
  readonly fixedFeeIdr: number;
  readonly markupBps: number;
  readonly roundToIdr: number;
  readonly orderTimeoutMs: number;
  readonly cancelMinimumMs: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly earningHoldMs: number;
  readonly minimumPayoutIdr: number;
  readonly retention: RetentionConfig;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** MVP default retention windows straight from the design decisions. */
export const DEFAULT_RETENTION_CONFIG: RetentionConfig = Object.freeze({
  smsRawMs: 7 * DAY_MS,
  otpAfterTerminalMs: 24 * 60 * 60 * 1000,
  heartbeatMetadataMs: 30 * DAY_MS,
  securityLogMs: 90 * DAY_MS,
  auditMs: 7 * 365 * DAY_MS,
  ledgerPayoutMs: 7 * 365 * DAY_MS,
});

/** MVP default platform configuration (guardrail Rp500–Rp5.000, etc.). */
export const DEFAULT_PLATFORM_CONFIG: PlatformConfigInput = Object.freeze({
  minBasePriceIdr: 500,
  maxBasePriceIdr: 5_000,
  fixedFeeIdr: 250,
  markupBps: 1_500,
  roundToIdr: 50,
  orderTimeoutMs: 20 * 60 * 1000,
  cancelMinimumMs: 3 * 60 * 1000,
  heartbeatIntervalMs: 30 * 1000,
  heartbeatTimeoutMs: 90 * 1000,
  earningHoldMs: 24 * 60 * 60 * 1000,
  minimumPayoutIdr: 1_000,
  retention: DEFAULT_RETENTION_CONFIG,
});

export type ConfigViolationCode =
  | "guardrail_not_ordered"
  | "guardrail_not_positive"
  | "fixed_fee_negative"
  | "markup_negative"
  | "round_unit_not_positive"
  | "order_timeout_not_positive"
  | "cancel_minimum_not_positive"
  | "cancel_minimum_not_below_order_timeout"
  | "heartbeat_interval_not_positive"
  | "heartbeat_timeout_not_above_interval"
  | "hold_negative"
  | "minimum_payout_not_positive"
  | "retention_negative";

export interface ConfigViolation {
  readonly code: ConfigViolationCode;
  readonly field: string;
}

export type PlatformConfigValidation =
  | { readonly valid: true; readonly config: PlatformConfigInput }
  | { readonly valid: false; readonly violations: readonly ConfigViolation[] };

function isNonNegInt(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPosInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Validate a candidate PlatformConfig against every activation invariant
 * (Property 25): guardrail ordered and positive, timeouts positive, cancel
 * minimum strictly below the order timeout, heartbeat timeout strictly above
 * the heartbeat interval, hold non-negative, minimum payout positive, and all
 * retention windows non-negative. Returns every violation rather than only the
 * first so that admins get a complete picture.
 */
export function validatePlatformConfig(
  input: PlatformConfigInput,
): PlatformConfigValidation {
  const violations: ConfigViolation[] = [];

  if (!isPosInt(input.minBasePriceIdr) || !isPosInt(input.maxBasePriceIdr)) {
    violations.push({ code: "guardrail_not_positive", field: "minBasePriceIdr/maxBasePriceIdr" });
  } else if (input.minBasePriceIdr > input.maxBasePriceIdr) {
    violations.push({ code: "guardrail_not_ordered", field: "minBasePriceIdr" });
  }

  if (!isNonNegInt(input.fixedFeeIdr)) {
    violations.push({ code: "fixed_fee_negative", field: "fixedFeeIdr" });
  }
  if (!isNonNegInt(input.markupBps)) {
    violations.push({ code: "markup_negative", field: "markupBps" });
  }
  if (!isPosInt(input.roundToIdr)) {
    violations.push({ code: "round_unit_not_positive", field: "roundToIdr" });
  }

  const orderTimeoutOk = isPosInt(input.orderTimeoutMs);
  if (!orderTimeoutOk) {
    violations.push({ code: "order_timeout_not_positive", field: "orderTimeoutMs" });
  }
  const cancelMinimumOk = isPosInt(input.cancelMinimumMs);
  if (!cancelMinimumOk) {
    violations.push({ code: "cancel_minimum_not_positive", field: "cancelMinimumMs" });
  }
  if (
    orderTimeoutOk &&
    cancelMinimumOk &&
    input.cancelMinimumMs >= input.orderTimeoutMs
  ) {
    violations.push({
      code: "cancel_minimum_not_below_order_timeout",
      field: "cancelMinimumMs",
    });
  }

  const heartbeatIntervalOk = isPosInt(input.heartbeatIntervalMs);
  if (!heartbeatIntervalOk) {
    violations.push({ code: "heartbeat_interval_not_positive", field: "heartbeatIntervalMs" });
  }
  if (
    !isPosInt(input.heartbeatTimeoutMs) ||
    (heartbeatIntervalOk && input.heartbeatTimeoutMs <= input.heartbeatIntervalMs)
  ) {
    violations.push({
      code: "heartbeat_timeout_not_above_interval",
      field: "heartbeatTimeoutMs",
    });
  }

  if (!isNonNegInt(input.earningHoldMs)) {
    violations.push({ code: "hold_negative", field: "earningHoldMs" });
  }
  if (!isPosInt(input.minimumPayoutIdr)) {
    violations.push({ code: "minimum_payout_not_positive", field: "minimumPayoutIdr" });
  }

  const retentionFields: readonly (keyof RetentionConfig)[] = [
    "smsRawMs",
    "otpAfterTerminalMs",
    "heartbeatMetadataMs",
    "securityLogMs",
    "auditMs",
    "ledgerPayoutMs",
  ];
  for (const field of retentionFields) {
    if (!isNonNegInt(input.retention?.[field])) {
      violations.push({ code: "retention_negative", field: `retention.${field}` });
    }
  }

  if (violations.length > 0) {
    return { valid: false, violations: Object.freeze(violations) };
  }

  const retention: RetentionConfig = Object.freeze({
    smsRawMs: input.retention.smsRawMs,
    otpAfterTerminalMs: input.retention.otpAfterTerminalMs,
    heartbeatMetadataMs: input.retention.heartbeatMetadataMs,
    securityLogMs: input.retention.securityLogMs,
    auditMs: input.retention.auditMs,
    ledgerPayoutMs: input.retention.ledgerPayoutMs,
  });

  return {
    valid: true,
    config: Object.freeze({ ...input, retention }),
  };
}

/**
 * Validate and return an activatable config, throwing on any invariant
 * violation. Use when the caller wants a hard reject (Req 16.5).
 */
export function assertValidPlatformConfig(
  input: PlatformConfigInput,
): PlatformConfigInput {
  const result = validatePlatformConfig(input);
  if (!result.valid) {
    const summary = result.violations.map((v) => `${v.field}:${v.code}`).join(", ");
    throw new Task57DomainError(
      "INVALID_CONFIG",
      `PlatformConfig is not activatable: ${summary}`,
    );
  }
  return result.config;
}
