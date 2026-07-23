/**
 * Pure Agent API v1 credential + replay header parsing (task 11.1; design
 * section 6; requirements 5.5, 5.6, 18.1–18.7).
 *
 * The Agent API authenticates every device request with a bearer-style
 * credential — `Authorization: Device <devicePublicId>.<secret>` (design
 * section 6) — rather than the HMAC canonical-request signature used by the
 * Internal API. This module owns only the *shape* of that credential and of the
 * replay headers; the constant-time secret hashing lives in an infrastructure
 * adapter (node crypto — the task 8.1 `CryptoDeviceCredentialFactory`) because
 * pure domain code must not depend on runtime crypto primitives.
 *
 * Replay protection (skew <= 300s, unique 128-bit nonce for 10 minutes) is
 * delegated to the task 5.3 `validateReplayProtection` domain, re-exported here
 * so a caller assembles the whole policy from one place. Every mutation vulnerable
 * to replay carries `X-Agent-Timestamp` + `X-Agent-Nonce`; SMS and inventory
 * mutations additionally carry an `Idempotency-Key` (design section 6).
 */
export {
  isValid128BitNonce,
  validateReplayProtection,
  type ReplayDecision,
  type ReplayRejectionCode,
  type ReplayValidationInput,
} from "@domain/task-5-3/replay-policy";

/** Canonical Agent API header names (lower-case for `Headers.get`). */
export const AGENT_API_HEADERS = Object.freeze({
  authorization: "authorization",
  timestamp: "x-agent-timestamp",
  nonce: "x-agent-nonce",
  idempotencyKey: "idempotency-key",
});

/** Default replay window bounds (design section 6). */
export const AGENT_API_MAX_CLOCK_SKEW_SECONDS = 300;
export const AGENT_API_NONCE_TTL_SECONDS = 600;

/** The bearer scheme for a device credential (case-insensitive on the wire). */
const AUTH_SCHEME = "device";
/**
 * A device public id is the base64url encoding of 128 bits of CSPRNG output
 * (task 8.1). The persisted column is `VarChar(80)`; bound the parse to that.
 */
const PUBLIC_ID = /^[A-Za-z0-9_-]{1,80}$/;
/**
 * A device secret is the base64url encoding of 256 bits of CSPRNG output
 * (43 chars). Accept a bounded range so a rotated encoding stays valid while an
 * absurdly long value is refused before any hashing.
 */
const SECRET = /^[A-Za-z0-9_-]{16,256}$/;
/** Idempotency keys are bounded opaque tokens (matches the persisted column). */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,255}$/;
/** Unix seconds as an unsigned integer, no sign/leading zeros beyond `0`. */
const UNIX_SECONDS = /^(?:0|[1-9]\d{0,18})$/;

/** The parsed pieces of a `Device <publicId>.<secret>` credential. */
export interface AgentCredentialToken {
  readonly publicId: string;
  /** The raw agent secret; verified constant-time against the stored hash. */
  readonly secret: string;
}

/**
 * Parse an `Authorization: Device <publicId>.<secret>` header. Returns `null`
 * for any malformed/missing value; the caller maps that to a generic
 * `AUTHENTICATION_FAILED` so no shape detail leaks (requirement 18.7). The
 * public id and secret are base64url (no `.`), so the first `.` unambiguously
 * separates them.
 */
export function parseAgentAuthorizationHeader(
  headerValue: string | null,
): AgentCredentialToken | null {
  if (headerValue === null) return null;
  const trimmed = headerValue.trim();
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace <= 0) return null;

  const scheme = trimmed.slice(0, firstSpace);
  if (scheme.toLowerCase() !== AUTH_SCHEME) return null;

  const token = trimmed.slice(firstSpace + 1).trim();
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;

  const publicId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!PUBLIC_ID.test(publicId) || !SECRET.test(secret)) return null;

  return Object.freeze({ publicId, secret });
}

/** The replay headers as presented on the wire, before validation. */
export interface RawAgentReplayHeaders {
  readonly timestamp: string | null;
  readonly nonce: string | null;
  /** Present only on SMS/inventory mutations; other requests carry `null`. */
  readonly idempotencyKey: string | null;
}

/** The validated, well-typed replay header set. */
export interface AgentReplayHeaders {
  readonly timestampSeconds: number;
  readonly nonce: string;
  /** Empty string when the request carries no idempotency key. */
  readonly idempotencyKey: string;
}

/**
 * Validate the raw replay headers into a well-typed set. The timestamp and
 * nonce are always required (every replay-vulnerable request carries them);
 * `requireIdempotencyKey` additionally demands a well-formed `Idempotency-Key`
 * for SMS/inventory mutations. Returns `null` when any required header is
 * missing or malformed. Nonce *format* is authoritatively checked by
 * `validateReplayProtection`; here it must merely be present and non-empty.
 */
export function parseAgentReplayHeaders(
  raw: RawAgentReplayHeaders,
  options: { readonly requireIdempotencyKey: boolean },
): AgentReplayHeaders | null {
  const { timestamp, nonce, idempotencyKey } = raw;

  if (timestamp === null || !UNIX_SECONDS.test(timestamp)) return null;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) return null;

  if (nonce === null || nonce.length === 0) return null;

  let canonicalIdempotencyKey = "";
  const hasIdempotencyKey = idempotencyKey !== null && idempotencyKey.length > 0;
  if (hasIdempotencyKey) {
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return null;
    canonicalIdempotencyKey = idempotencyKey;
  } else if (options.requireIdempotencyKey) {
    return null;
  }

  return Object.freeze({
    timestampSeconds,
    nonce,
    idempotencyKey: canonicalIdempotencyKey,
  });
}
