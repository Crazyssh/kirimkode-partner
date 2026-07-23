import { type RetentionConfig } from "./config";
import { assertValidEpochMs, Task57DomainError } from "./errors";

/**
 * Categories of data governed by retention (Req 19.4). Sensitive categories are
 * redacted or deleted once their window elapses; financial and audit evidence
 * is protected and never removed by this decision (Req 19.5).
 */
export const RETENTION_CATEGORIES = [
  "sms_raw",
  "otp",
  "heartbeat_metadata",
  "security_log",
  "audit",
  "ledger",
  "payout",
] as const;

export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

export type RetentionAction = "retain" | "redact" | "delete";

/**
 * How each category is disposed of once its retention window elapses:
 * - `redact`  : strip the sensitive payload but keep the record (SMS/OTP).
 * - `delete`  : prune the whole record (operational metadata / security log).
 * - `protect` : never removed by retention — required financial/audit evidence.
 */
const DISPOSAL: Readonly<
  Record<RetentionCategory, "redact" | "delete" | "protect">
> = Object.freeze({
  sms_raw: "redact",
  otp: "redact",
  heartbeat_metadata: "delete",
  security_log: "delete",
  audit: "protect",
  ledger: "protect",
  payout: "protect",
});

function windowFor(
  category: RetentionCategory,
  retention: RetentionConfig,
): number {
  switch (category) {
    case "sms_raw":
      return retention.smsRawMs;
    case "otp":
      return retention.otpAfterTerminalMs;
    case "heartbeat_metadata":
      return retention.heartbeatMetadataMs;
    case "security_log":
      return retention.securityLogMs;
    case "audit":
      return retention.auditMs;
    case "ledger":
    case "payout":
      return retention.ledgerPayoutMs;
  }
}

/**
 * The configured retention window (ms) for a category. Exposed so the retention
 * job can compute its `now - window` selection boundary from the same source of
 * truth the {@link decideRetention} decision uses, rather than duplicating the
 * category → window mapping.
 */
export function retentionWindowMs(
  category: RetentionCategory,
  retention: RetentionConfig,
): number {
  return windowFor(category, retention);
}

export interface RetentionDecisionInput {
  readonly category: RetentionCategory;
  /**
   * The boundary event the window is measured from: SMS `receivedAtServer`,
   * order `terminalAt` for OTP, sample time for heartbeat, etc.
   */
  readonly referenceEpochMs: number;
  readonly nowEpochMs: number;
  readonly retention: RetentionConfig;
}

export interface RetentionDecision {
  readonly category: RetentionCategory;
  readonly action: RetentionAction;
  /** True when the category is protected financial/audit evidence. */
  readonly protectedEvidence: boolean;
  readonly ageMs: number;
}

/**
 * Decide the retention action for a single record (Property 30). Sensitive
 * categories are redacted/deleted only once `now - reference >= window`;
 * protected financial and audit categories are always retained so that the
 * money trail and audit evidence stay intact (Req 19.5).
 */
export function decideRetention(
  input: RetentionDecisionInput,
): RetentionDecision {
  if (!RETENTION_CATEGORIES.includes(input.category)) {
    throw new Task57DomainError(
      "INVALID_RETENTION_INPUT",
      `Unknown retention category: ${String(input.category)}`,
    );
  }
  assertValidEpochMs(input.referenceEpochMs, "referenceEpochMs");
  assertValidEpochMs(input.nowEpochMs, "nowEpochMs");

  const ageMs = input.nowEpochMs - input.referenceEpochMs;
  const disposal = DISPOSAL[input.category];

  if (disposal === "protect") {
    return {
      category: input.category,
      action: "retain",
      protectedEvidence: true,
      ageMs,
    };
  }

  const window = windowFor(input.category, input.retention);
  const elapsed = ageMs >= window;

  return {
    category: input.category,
    action: elapsed ? disposal : "retain",
    protectedEvidence: false,
    ageMs,
  };
}

/**
 * True when a category represents protected financial/audit evidence that the
 * retention job must never redact or delete.
 */
export function isProtectedEvidence(category: RetentionCategory): boolean {
  return DISPOSAL[category] === "protect";
}
