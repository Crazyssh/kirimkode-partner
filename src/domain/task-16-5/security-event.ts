/**
 * Security event shape and builder (task 16.5; design section 12; requirements
 * 18.7, 19.6).
 *
 * Design section 12 requires a *separate* event stream — distinct from the
 * general request log — that records the security-relevant occurrences an
 * operator must be able to audit: authentication failures, replay violations,
 * rate-limit hits, ownership violations, and admin raw-data access. Requirement
 * 18.7 additionally states these must be recorded "without logging secrets or
 * OTP".
 *
 * This module owns the closed vocabulary of {@link SecurityEventType} and a
 * pure {@link buildSecurityEvent} that, exactly like the log-record builder,
 * hashes the principal/device identifiers through an injected hasher and runs
 * {@link redactRecord} over the free-form `detail` bag. So even if a caller
 * accidentally hands over an `authorization` header or an `otp`, the built
 * event carries only the redacted placeholder. The severity is derived
 * deterministically from the event type.
 */
import { redactRecord, type RedactableValue } from "./redaction";
import type { IdHasher } from "./log-record";

/**
 * The closed set of security event categories the design enumerates. Extending
 * this set is a deliberate design change, not an ad-hoc call-site decision.
 */
export type SecurityEventType =
  | "authentication_failure"
  | "replay_violation"
  | "rate_limit_hit"
  | "ownership_violation"
  | "admin_raw_data_access";

/** Security events map onto the shared issue-severity vocabulary. */
export type SecurityEventSeverity = "info" | "warning" | "critical";

/**
 * Fixed severity per event type. Admin raw-data access is `warning` (it is an
 * authorized-but-sensitive action that must always leave a trail); the abuse
 * signals are `warning`; a bare authentication failure is `info` until volume
 * turns it into a rate-limit/abuse pattern.
 */
const SEVERITY_BY_TYPE: Readonly<Record<SecurityEventType, SecurityEventSeverity>> = {
  authentication_failure: "info",
  replay_violation: "warning",
  rate_limit_hit: "warning",
  ownership_violation: "warning",
  admin_raw_data_access: "warning",
};

/** A built, redaction-safe security event ready for the security stream. */
export interface SecurityEvent {
  readonly timestamp: string;
  readonly type: SecurityEventType;
  readonly severity: SecurityEventSeverity;
  readonly requestId: string;
  /** Hashed principal (partner/user/device ref); never the raw identifier. */
  readonly principalHash: string | null;
  /** Hashed device id when the event concerns a device; else null. */
  readonly deviceHash: string | null;
  readonly route: string | null;
  /** Generic network source label (e.g. hashed ip); never a raw secret. */
  readonly sourceHash: string | null;
  /** Redaction-safe context; guaranteed to contain no secrets or OTP. */
  readonly detail: Record<string, RedactableValue>;
}

/** Static per-process context shared by every security event. */
export interface SecurityEventContext {
  readonly hash: IdHasher;
}

/** Per-occurrence inputs a call site provides to record a security event. */
export interface SecurityEventInput {
  readonly type: SecurityEventType;
  readonly timestampEpochMs: number;
  readonly requestId: string;
  /** Raw principal ref; hashed by the builder. */
  readonly principalId?: string | null;
  /** Raw device id; hashed by the builder. */
  readonly deviceId?: string | null;
  readonly route?: string | null;
  /** Raw network source (e.g. ip); hashed by the builder. */
  readonly source?: string | null;
  /** Free-form context; redacted before it is attached. */
  readonly detail?: Readonly<Record<string, RedactableValue>>;
}

function hashOrNull(hash: IdHasher, raw: string | null | undefined): string | null {
  return raw === null || raw === undefined || raw === "" ? null : hash(raw);
}

/** The severity the design assigns to a given security event type. */
export function severityForSecurityEvent(
  type: SecurityEventType,
): SecurityEventSeverity {
  return SEVERITY_BY_TYPE[type];
}

/**
 * Build a fully-formed, redaction-safe {@link SecurityEvent}. All identifiers
 * are hashed and the `detail` bag is redacted, so the event can be written to
 * the security stream without any risk of persisting a secret or OTP
 * (requirement 18.7).
 */
export function buildSecurityEvent(
  context: SecurityEventContext,
  input: SecurityEventInput,
): SecurityEvent {
  return Object.freeze({
    timestamp: new Date(input.timestampEpochMs).toISOString(),
    type: input.type,
    severity: SEVERITY_BY_TYPE[input.type],
    requestId: input.requestId,
    principalHash: hashOrNull(context.hash, input.principalId),
    deviceHash: hashOrNull(context.hash, input.deviceId),
    route: input.route ?? null,
    sourceHash: hashOrNull(context.hash, input.source),
    detail: input.detail === undefined ? {} : redactRecord(input.detail),
  });
}
