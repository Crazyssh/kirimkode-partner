/**
 * Pure canonical-request construction for Internal API v1 HMAC authentication
 * (task 9.1; design section 4; requirements 10.1, 10.6, 10.7, 18.5).
 *
 * The Internal API authenticates every Main -> Partner request with an
 * HMAC-SHA256 signature over a deterministic canonical string. This module owns
 * only the *shape* of that canonical string and the validation of the signing
 * headers; the actual keyed hashing and constant-time comparison live in an
 * infrastructure adapter (node crypto) because pure domain code must not depend
 * on runtime crypto primitives. Both Main (signer) and Partner (verifier) must
 * build the exact same canonical string, so keeping it here — transport- and
 * secret-free — makes the contract unambiguous and unit-testable.
 *
 * Canonical string (design section 4: "method, path, timestamp, nonce, SHA-256
 * body, dan Idempotency-Key"): the six fields joined by `\n`, in this fixed
 * order. A request without an idempotency key (a read) signs an empty final
 * field, so the field is always present and the string is unambiguous.
 *
 * Replay protection (skew <= 300s, unique 128-bit nonce for 10 minutes) is
 * delegated to the task 5.3 `validateReplayProtection` domain, re-exported here
 * so callers assemble the whole policy from one place.
 */
export {
  isValid128BitNonce,
  validateReplayProtection,
  type ReplayDecision,
  type ReplayRejectionCode,
  type ReplayValidationInput,
} from "@domain/task-5-3/replay-policy";

/** Canonical HTTP signing header names (lower-case for `Headers.get`). */
export const INTERNAL_API_HEADERS = Object.freeze({
  clientId: "x-kk-client-id",
  keyId: "x-kk-key-id",
  timestamp: "x-kk-timestamp",
  nonce: "x-kk-nonce",
  signature: "x-kk-signature",
  idempotencyKey: "idempotency-key",
});

/** Default replay window bounds (design section 4). */
export const INTERNAL_API_MAX_CLOCK_SKEW_SECONDS = 300;
export const INTERNAL_API_NONCE_TTL_SECONDS = 600;

/** Signature is lower-case hex of an HMAC-SHA256 digest (32 bytes -> 64 chars). */
const SIGNATURE_HEX = /^[0-9a-f]{64}$/i;
/** Key/client identifiers are short opaque ASCII tokens. */
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,100}$/;
/** Idempotency keys are bounded opaque tokens (matches the persisted column). */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,255}$/;
/** Unix seconds as an unsigned integer, no sign/leading zeros beyond `0`. */
const UNIX_SECONDS = /^(?:0|[1-9]\d{0,18})$/;

/** The signing headers as presented on the wire, before validation. */
export interface RawInternalApiSignatureHeaders {
  readonly clientId: string | null;
  readonly keyId: string | null;
  readonly timestamp: string | null;
  readonly nonce: string | null;
  readonly signature: string | null;
  /** Present only on mutations; a read carries `null`. */
  readonly idempotencyKey: string | null;
}

/** The validated, well-typed signing header set. */
export interface InternalApiSignatureHeaders {
  readonly clientId: string;
  readonly keyId: string;
  readonly timestampSeconds: number;
  readonly nonce: string;
  readonly signatureHex: string;
  /** Empty string when the request carries no idempotency key. */
  readonly idempotencyKey: string;
}

/**
 * Validate the raw signing headers into a well-typed set. Returns `null` when
 * any header is missing or malformed; the caller maps that to a generic
 * `AUTHENTICATION_FAILED` so no header-level detail leaks (requirement 10.7).
 * Note: this validates *shape* only — signature correctness, credential status,
 * skew, and nonce uniqueness are checked by later stages.
 */
export function parseInternalApiSignatureHeaders(
  raw: RawInternalApiSignatureHeaders,
): InternalApiSignatureHeaders | null {
  const { clientId, keyId, timestamp, nonce, signature, idempotencyKey } = raw;

  if (
    clientId === null || !IDENTIFIER.test(clientId) ||
    keyId === null || !IDENTIFIER.test(keyId) ||
    timestamp === null || !UNIX_SECONDS.test(timestamp) ||
    signature === null || !SIGNATURE_HEX.test(signature)
  ) {
    return null;
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) return null;

  // The nonce format is authoritatively checked by `validateReplayProtection`;
  // reject an empty value here so the field is always non-empty downstream.
  if (nonce === null || nonce.length === 0) return null;

  // An idempotency key, when present, must be a bounded opaque token; a blank
  // header is treated as absent (empty canonical field).
  let canonicalIdempotencyKey = "";
  if (idempotencyKey !== null && idempotencyKey.length > 0) {
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return null;
    canonicalIdempotencyKey = idempotencyKey;
  }

  return Object.freeze({
    clientId,
    keyId,
    timestampSeconds,
    nonce,
    signatureHex: signature.toLowerCase(),
    idempotencyKey: canonicalIdempotencyKey,
  });
}

/** Inputs required to build the canonical signing string. */
export interface CanonicalInternalApiRequest {
  readonly method: string;
  /** Request target exactly as signed: pathname plus query string, if any. */
  readonly path: string;
  readonly timestampSeconds: number;
  readonly nonce: string;
  /** Lower-case hex SHA-256 of the raw request body (empty body allowed). */
  readonly bodySha256Hex: string;
  /** Empty string for requests without an idempotency key. */
  readonly idempotencyKey: string;
}

/**
 * Build the canonical string that both parties sign. The method is
 * upper-cased and the fields are joined by `\n` in the fixed order defined by
 * the contract. Every field is required (the idempotency key may be an empty
 * string) so the layout can never be ambiguous.
 */
export function buildInternalApiCanonicalString(
  request: CanonicalInternalApiRequest,
): string {
  const method = request.method.trim().toUpperCase();
  if (
    method.length === 0 ||
    request.path.length === 0 ||
    !Number.isSafeInteger(request.timestampSeconds) ||
    request.timestampSeconds < 0 ||
    request.nonce.length === 0 ||
    !SIGNATURE_HEX.test(request.bodySha256Hex)
  ) {
    throw new TypeError("Cannot build a canonical Internal API string from incomplete input");
  }

  return [
    method,
    request.path,
    String(request.timestampSeconds),
    request.nonce,
    request.bodySha256Hex.toLowerCase(),
    request.idempotencyKey,
  ].join("\n");
}
