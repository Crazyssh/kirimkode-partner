/**
 * Structured JSON log record shape and builder (task 16.5; design section 12;
 * requirements 20.3, 20.4, 19.6).
 *
 * Design section 12 fixes the exact field set for every request/error log line:
 * `timestamp`, `level`, `service`, `env`, `requestId`, `route`, `method`,
 * `status`, `latencyMs`, a *hashed* actor and device id, `partnerOrderId`, and
 * a stable error code. This module owns that shape and is the single builder
 * every log call must go through, because it:
 *
 *  1. Hashes the actor/device identifiers through an injected hash function so
 *     a raw principal id never reaches a log sink (the infrastructure adapter
 *     supplies a SHA-256 hasher; tests supply a deterministic fake).
 *  2. Runs {@link redactRecord} over any caller-supplied `extra` metadata so an
 *     `authorization` header, cookie, OTP, token, or raw SMS smuggled into the
 *     free-form bag is stripped before serialization (requirement 19.6).
 *
 * The builder is pure: the timestamp and hasher are injected, so no clock or
 * runtime global is touched. The infrastructure {@link JsonLogger} wraps it
 * with a real clock, hasher, and stdout sink.
 */
import { redactRecord, type RedactableValue } from "./redaction";

/** Severity levels for a structured log line, ordered least→most severe. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** A one-way hash of a sensitive identifier (actor/device). */
export type IdHasher = (raw: string) => string;

/** The immutable fields the design mandates for every request/error log line. */
export interface LogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly service: string;
  readonly env: string;
  readonly requestId: string;
  readonly route: string | null;
  readonly method: string | null;
  readonly status: number | null;
  readonly latencyMs: number | null;
  /** SHA-256 (or injected) hash of the actor id; never the raw id. */
  readonly actorHash: string | null;
  /** SHA-256 (or injected) hash of the device id; never the raw id. */
  readonly deviceHash: string | null;
  readonly partnerOrderId: string | null;
  /** Stable error code (e.g. `RATE_LIMITED`, `INTERNAL_ERROR`); null on success. */
  readonly errorCode: string | null;
  /** Redaction-safe free-form context; guaranteed to contain no secrets. */
  readonly extra?: Record<string, RedactableValue>;
}

/** Static per-process context shared by every log line. */
export interface LogContext {
  readonly service: string;
  readonly env: string;
  /** Injected hasher for actor/device ids; keeps this module pure. */
  readonly hash: IdHasher;
}

/** The per-request inputs a call site provides when emitting a log line. */
export interface LogInput {
  readonly level: LogLevel;
  readonly timestampEpochMs: number;
  readonly requestId: string;
  readonly route?: string | null;
  readonly method?: string | null;
  readonly status?: number | null;
  readonly latencyMs?: number | null;
  /** Raw actor id; hashed by the builder, never logged verbatim. */
  readonly actorId?: string | null;
  /** Raw device id; hashed by the builder, never logged verbatim. */
  readonly deviceId?: string | null;
  readonly partnerOrderId?: string | null;
  readonly errorCode?: string | null;
  /** Free-form context; redacted before it is attached. */
  readonly extra?: Readonly<Record<string, RedactableValue>>;
}

function hashOrNull(hash: IdHasher, raw: string | null | undefined): string | null {
  return raw === null || raw === undefined || raw === "" ? null : hash(raw);
}

/**
 * Build a fully-formed, redaction-safe {@link LogRecord}. Actor/device ids are
 * hashed and any `extra` metadata is redacted, so the returned record can be
 * serialized directly to a log sink with no risk of leaking a secret listed in
 * design section 12.
 */
export function buildLogRecord(context: LogContext, input: LogInput): LogRecord {
  const record: LogRecord = {
    timestamp: new Date(input.timestampEpochMs).toISOString(),
    level: input.level,
    service: context.service,
    env: context.env,
    requestId: input.requestId,
    route: input.route ?? null,
    method: input.method ?? null,
    status: input.status ?? null,
    latencyMs: input.latencyMs ?? null,
    actorHash: hashOrNull(context.hash, input.actorId),
    deviceHash: hashOrNull(context.hash, input.deviceId),
    partnerOrderId: input.partnerOrderId ?? null,
    errorCode: input.errorCode ?? null,
  };

  if (input.extra !== undefined) {
    return Object.freeze({ ...record, extra: redactRecord(input.extra) });
  }
  return Object.freeze(record);
}
