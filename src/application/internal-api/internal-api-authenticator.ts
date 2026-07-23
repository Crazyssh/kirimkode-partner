/**
 * Internal API v1 HMAC request authenticator (task 9.1).
 *
 * A reusable guard for every `/api/internal/v1/*` request. It authenticates the
 * Main Platform's service-to-service credential and enforces replay protection
 * *before any state mutation* (requirement 18.5), so a route only ever runs its
 * business logic for a fully verified caller. It performs, in order:
 *
 *   1. HTTPS enforcement in production (requirement 18.1 parity for internal).
 *   2. Request size limit (requirement 18.6 parity for internal).
 *   3. Signing-header shape validation (generic failure, no leak).
 *   4. Credential selection: client id must match the configured Main client;
 *      the key id selects the current or previous rotation secret.
 *   5. `ServiceCredential` status check — active only (requirement 10.1). These
 *      credentials are wholly separate from human sessions and device tokens.
 *   6. Canonical string build + constant-time HMAC-SHA256 verification.
 *   7. Per-client rate limiting (abuse mitigation).
 *   8. Replay validation: <=300s clock skew and a unique 128-bit nonce for
 *      10 minutes, registered atomically so a concurrent replay loses the race.
 *
 * The only persistence effect the guard applies is the anti-replay nonce
 * insert, and it happens last, after the signature is proven valid — no order,
 * money, or inventory is ever touched by a rejected request. Every failure maps
 * to a stable, safe error envelope (requirement 10.7): credential/signature/
 * shape failures collapse to a single `AUTHENTICATION_FAILED` so no probe can
 * distinguish an unknown client from a bad signature.
 */
import {
  buildInternalApiCanonicalString,
  INTERNAL_API_HEADERS,
  INTERNAL_API_MAX_CLOCK_SKEW_SECONDS,
  INTERNAL_API_NONCE_TTL_SECONDS,
  parseInternalApiSignatureHeaders,
  validateReplayProtection,
} from "@domain/task-9-1/internal-api-signing";
import { consumeEvent, emptyWindowCounter, type WindowRule } from "@domain/task-7-2";
import { mapDomainError, type SafeError } from "@domain/task-5-3/safe-errors";

import type {
  Clock,
  HmacSignatureVerifier,
  RateLimitStore,
  ReplayNonceRegistry,
  ServiceCredentialGateway,
} from "./ports";

/** Default maximum Internal API request body size: 64 KiB of JSON. */
export const INTERNAL_API_MAX_BODY_BYTES = 64 * 1024;

/**
 * Default per-client rate limit. Rate limiting is best-effort abuse mitigation;
 * the Main Platform's own client timeouts (3s/8s) bound legitimate volume well
 * below this. Keyed on the authenticated client id so a spoofed, unauthenticated
 * client id can never exhaust a legitimate client's window.
 */
export const INTERNAL_API_RATE_LIMIT: WindowRule = Object.freeze({
  limit: 600,
  windowMs: 60_000,
});

/** The runtime HMAC secrets, keyed by rotation key id (from env config). */
export interface InternalApiHmacConfig {
  readonly clientId: string;
  readonly currentKeyId: string;
  readonly currentSecret: string;
  readonly previousKeyId?: string;
  readonly previousSecret?: string;
}

/** A request presented to the authenticator, assembled by the transport. */
export interface InternalApiAuthRequest {
  readonly method: string;
  /** Request target exactly as signed: pathname plus query string, if any. */
  readonly path: string;
  /** Read-only view of the request headers. */
  readonly headers: Pick<Headers, "get">;
  /** The raw request body text (already read by the transport; may be empty). */
  readonly rawBody: string;
  /** Whether the request arrived over HTTPS (transport-resolved). */
  readonly secure: boolean;
}

/** The verified service principal handed to the route on success. */
export interface AuthenticatedServicePrincipal {
  readonly clientId: string;
  readonly keyId: string;
  /** Stable principal id for tenant-free scoping (nonce, rate limit, audit). */
  readonly principalId: string;
  /** The validated idempotency key, or `null` when none was presented. */
  readonly idempotencyKey: string | null;
}

export type InternalApiAuthResult =
  | { readonly ok: true; readonly principal: AuthenticatedServicePrincipal }
  | { readonly ok: false; readonly error: SafeError };

export interface InternalApiAuthenticatorDeps {
  readonly hmac: InternalApiHmacConfig;
  readonly credentials: ServiceCredentialGateway;
  readonly nonces: ReplayNonceRegistry;
  readonly verifier: HmacSignatureVerifier;
  readonly rateLimitStore: RateLimitStore;
  readonly clock: Clock;
  /** Production rejects plain HTTP; other environments allow it for local dev. */
  readonly enforceHttps: boolean;
  readonly maxBodyBytes?: number;
  readonly rateLimit?: WindowRule;
  readonly maxClockSkewSeconds?: number;
  readonly nonceTtlSeconds?: number;
}

const AUTH_FAILED: SafeError = mapDomainError({ kind: "authentication" });
const REPLAY_REJECTED: SafeError = mapDomainError({ kind: "replay" });
const RATE_LIMITED: SafeError = mapDomainError({ kind: "rate_limited" });

const HTTPS_REQUIRED: SafeError = Object.freeze({
  status: 400,
  code: "HTTPS_REQUIRED",
  message: "Requests must use HTTPS.",
  retryable: false,
});
const PAYLOAD_TOO_LARGE: SafeError = Object.freeze({
  status: 413,
  code: "PAYLOAD_TOO_LARGE",
  message: "Request body is too large.",
  retryable: false,
});

export class InternalApiAuthenticator {
  private readonly deps: InternalApiAuthenticatorDeps;
  private readonly maxBodyBytes: number;
  private readonly rateLimit: WindowRule;
  private readonly maxClockSkewSeconds: number;
  private readonly nonceTtlSeconds: number;

  constructor(deps: InternalApiAuthenticatorDeps) {
    this.deps = deps;
    this.maxBodyBytes = deps.maxBodyBytes ?? INTERNAL_API_MAX_BODY_BYTES;
    this.rateLimit = deps.rateLimit ?? INTERNAL_API_RATE_LIMIT;
    this.maxClockSkewSeconds = deps.maxClockSkewSeconds ?? INTERNAL_API_MAX_CLOCK_SKEW_SECONDS;
    this.nonceTtlSeconds = deps.nonceTtlSeconds ?? INTERNAL_API_NONCE_TTL_SECONDS;
  }

  async authenticate(request: InternalApiAuthRequest): Promise<InternalApiAuthResult> {
    // 1. HTTPS enforcement (production). Reject before touching credentials.
    if (this.deps.enforceHttps && !request.secure) {
      return reject(HTTPS_REQUIRED);
    }

    // 2. Request size limit. A body larger than the cap is refused before any
    //    hashing so an oversized payload cannot be used to burn CPU.
    if (byteLength(request.rawBody) > this.maxBodyBytes) {
      return reject(PAYLOAD_TOO_LARGE);
    }

    // 3. Signing-header shape. Any malformed/missing header -> generic failure.
    const headers = parseInternalApiSignatureHeaders({
      clientId: request.headers.get(INTERNAL_API_HEADERS.clientId),
      keyId: request.headers.get(INTERNAL_API_HEADERS.keyId),
      timestamp: request.headers.get(INTERNAL_API_HEADERS.timestamp),
      nonce: request.headers.get(INTERNAL_API_HEADERS.nonce),
      signature: request.headers.get(INTERNAL_API_HEADERS.signature),
      idempotencyKey: request.headers.get(INTERNAL_API_HEADERS.idempotencyKey),
    });
    if (headers === null) return reject(AUTH_FAILED);

    // 4. Credential selection. The client id must match the configured Main
    //    client and the key id must select a known rotation secret.
    if (headers.clientId !== this.deps.hmac.clientId) return reject(AUTH_FAILED);
    const secret = this.selectSecret(headers.keyId);
    if (secret === null) return reject(AUTH_FAILED);

    // 5. Credential status. Only an ACTIVE service credential authenticates.
    const credential = await this.deps.credentials.findCredential(
      headers.clientId,
      headers.keyId,
    );
    if (credential === null || credential.status !== "active") {
      return reject(AUTH_FAILED);
    }

    // 6. Constant-time signature verification over the canonical string.
    const canonical = buildInternalApiCanonicalString({
      method: request.method,
      path: request.path,
      timestampSeconds: headers.timestampSeconds,
      nonce: headers.nonce,
      bodySha256Hex: this.deps.verifier.bodySha256Hex(request.rawBody),
      idempotencyKey: headers.idempotencyKey,
    });
    const signatureValid = this.deps.verifier.verifySignature(
      canonical,
      secret,
      headers.signatureHex,
    );
    if (!signatureValid) return reject(AUTH_FAILED);

    const principalId = headers.clientId;

    // 7. Per-client rate limit (keyed on the now-authenticated client id).
    const limited = await this.consumeRateLimit(principalId);
    if (limited) return reject(RATE_LIMITED);

    // 8. Replay validation (skew + nonce shape), then atomic nonce claim. The
    //    domain rejects a stale timestamp or malformed nonce before we attempt
    //    the (only) mutation this guard performs.
    const nowSeconds = Math.floor(this.deps.clock.nowEpochMs() / 1000);
    const decision = validateReplayProtection({
      principalId,
      timestampSeconds: headers.timestampSeconds,
      nonce: headers.nonce,
      nowSeconds,
      credentialValid: true,
      signatureValid: true,
      ownershipValid: true,
      nonceAlreadyUsed: false,
      maxClockSkewSeconds: this.maxClockSkewSeconds,
      nonceTtlSeconds: this.nonceTtlSeconds,
    });
    if (decision.kind === "reject") {
      return reject(decision.code === "REPLAY_REJECTED" ? REPLAY_REJECTED : AUTH_FAILED);
    }

    const fresh = await this.deps.nonces.registerNonce(
      principalId,
      headers.nonce,
      decision.nonceExpiresAtSeconds * 1000,
    );
    if (!fresh) return reject(REPLAY_REJECTED);

    return {
      ok: true,
      principal: Object.freeze({
        clientId: headers.clientId,
        keyId: headers.keyId,
        principalId,
        idempotencyKey: headers.idempotencyKey.length === 0 ? null : headers.idempotencyKey,
      }),
    };
  }

  /** Select the rotation secret for a key id, or `null` when unknown. */
  private selectSecret(keyId: string): string | null {
    if (keyId === this.deps.hmac.currentKeyId) return this.deps.hmac.currentSecret;
    if (
      this.deps.hmac.previousKeyId !== undefined &&
      this.deps.hmac.previousSecret !== undefined &&
      keyId === this.deps.hmac.previousKeyId
    ) {
      return this.deps.hmac.previousSecret;
    }
    return null;
  }

  /** Count one request against the per-client window; returns `true` when denied. */
  private async consumeRateLimit(principalId: string): Promise<boolean> {
    const key = `internal-api:${principalId}`;
    const now = this.deps.clock.nowEpochMs();
    const current = (await this.deps.rateLimitStore.get(key)) ?? emptyWindowCounter();
    const { decision, counter } = consumeEvent(current, this.rateLimit, now);
    if (decision.allowed) {
      await this.deps.rateLimitStore.set(
        key,
        counter,
        counter.windowStartEpochMs + this.rateLimit.windowMs,
      );
    }
    return !decision.allowed;
  }
}

function reject(error: SafeError): InternalApiAuthResult {
  return { ok: false, error };
}

/** UTF-8 byte length of the raw body (application layer; node available). */
function byteLength(rawBody: string): number {
  return Buffer.byteLength(rawBody, "utf8");
}
