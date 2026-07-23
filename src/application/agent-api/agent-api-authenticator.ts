/**
 * Agent API v1 request authenticator (task 11.1).
 *
 * A reusable guard for every `/api/agent/v1/*` request that the heartbeat
 * (11.2), number (11.3), and SMS (12.3) endpoints wrap. It authenticates the
 * device credential and enforces replay + rate limits *before any state
 * mutation* (requirement 18.5), so a route only ever runs its business logic
 * for a fully verified, non-disabled device of an approved partner. It performs,
 * in order:
 *
 *   1. HTTPS enforcement in production (requirement 18.1).
 *   2. Request size limit — 16 KiB (requirement 18.6; design section 6).
 *   3. Per-network-source rate limit (300/IP/min) — a pre-auth abuse guard that
 *      bounds unauthenticated floods before any credential hashing.
 *   4. Credential + replay header shape validation (generic failure, no leak).
 *   5. Credential lookup by public id; status must be `active` — a rotated or
 *      revoked credential is refused (requirement 5.5).
 *   6. Constant-time secret verification (reuses the task 8.1 derivation).
 *   7. Fail-closed authorization: the partner must be `approved` and the device
 *      must not be `disabled` (requirements 5.6, 18.5). A valid-but-forbidden
 *      credential is rejected before any mutation.
 *   8. Per-device (endpoint-specific) + per-partner rate limits.
 *   9. Replay validation (<=300s skew, unique 128-bit nonce for 10 minutes),
 *      then an atomic nonce claim — the only persistence effect the guard
 *      applies, performed last, after everything else has passed.
 *
 * No order, number, SMS, or heartbeat is ever touched by a rejected request.
 * Credential/shape/verification failures collapse to a single
 * `AUTHENTICATION_FAILED` so no probe can distinguish an unknown public id from
 * a bad secret; disabled-device / non-approved-partner failures surface as
 * `FORBIDDEN` because the caller has already proven it holds the secret. Secrets
 * and OTPs never appear in a result (requirement 18.7): the guard returns only
 * safe error envelopes and a minimal principal.
 */
import {
  AGENT_API_HEADERS,
  AGENT_API_MAX_CLOCK_SKEW_SECONDS,
  AGENT_API_NONCE_TTL_SECONDS,
  parseAgentAuthorizationHeader,
  parseAgentReplayHeaders,
  validateReplayProtection,
} from "@domain/task-11-1/agent-api-auth";
import {
  emptyWindowCounter,
  evaluateWindow,
  registerEvent,
  type WindowRule,
} from "@domain/task-7-2";
import { mapDomainError, type SafeError } from "@domain/task-5-3/safe-errors";

import type {
  AgentDeviceCredentialGateway,
  Clock,
  DeviceSecretVerifier,
  RateLimitStore,
  ReplayNonceRegistry,
} from "./ports";

/** Maximum Agent API request body size: 16 KiB (design section 6). */
export const AGENT_API_MAX_BODY_BYTES = 16 * 1024;

/** The Agent API endpoint categories, each with its own device rate limit. */
export type AgentEndpoint = "heartbeat" | "number-mutation" | "sms";

/**
 * Per-device rate limits by endpoint (design section 6). Heartbeat allows 6/min
 * with a burst cap of 3: the token-bucket "burst 3" is approximated within the
 * fixed-window primitive by a second, tighter 3-per-10s window (the 6/min
 * refill rate is ~1 token / 10s), so a client cannot fire its whole minute
 * allotment instantly while a steady ~30s heartbeat is never throttled.
 */
export const AGENT_DEVICE_RATE_LIMITS: Readonly<Record<AgentEndpoint, readonly WindowRule[]>> =
  Object.freeze({
    heartbeat: Object.freeze([
      Object.freeze({ limit: 6, windowMs: 60_000 }),
      Object.freeze({ limit: 3, windowMs: 10_000 }),
    ]),
    "number-mutation": Object.freeze([Object.freeze({ limit: 10, windowMs: 60_000 })]),
    sms: Object.freeze([Object.freeze({ limit: 30, windowMs: 60_000 })]),
  });

/** Per-partner rate limit across all Agent API endpoints (design section 6). */
export const AGENT_PARTNER_RATE_LIMIT: WindowRule = Object.freeze({
  limit: 120,
  windowMs: 60_000,
});

/** Per-network-source rate limit across all Agent API endpoints (design section 6). */
export const AGENT_IP_RATE_LIMIT: WindowRule = Object.freeze({
  limit: 300,
  windowMs: 60_000,
});

/** Endpoints whose mutations require an idempotency key (SMS + inventory). */
const IDEMPOTENCY_REQUIRED: Readonly<Record<AgentEndpoint, boolean>> = Object.freeze({
  heartbeat: false,
  "number-mutation": true,
  sms: true,
});

/** A request presented to the authenticator, assembled by the transport. */
export interface AgentApiAuthRequest {
  /** Which endpoint category is being guarded (selects the device rate limit). */
  readonly endpoint: AgentEndpoint;
  /** Read-only view of the request headers. */
  readonly headers: Pick<Headers, "get">;
  /** The raw request body text (already read by the transport; may be empty). */
  readonly rawBody: string;
  /** Whether the request arrived over HTTPS (transport-resolved). */
  readonly secure: boolean;
  /** The resolved client network source, for the per-IP rate limit. */
  readonly clientIp: string;
}

/** The verified device principal handed to the route on success. */
export interface AuthenticatedDevicePrincipal {
  /** The owning partner id — the route builds a `TenantContext` from this. */
  readonly partnerId: string;
  readonly deviceId: string;
  readonly credentialPublicId: string;
  readonly endpoint: AgentEndpoint;
  /** The validated idempotency key, or `null` when none was presented. */
  readonly idempotencyKey: string | null;
}

export type AgentApiAuthResult =
  | { readonly ok: true; readonly principal: AuthenticatedDevicePrincipal }
  | { readonly ok: false; readonly error: SafeError };

export interface AgentApiAuthenticatorDeps {
  readonly credentials: AgentDeviceCredentialGateway;
  readonly secretVerifier: DeviceSecretVerifier;
  readonly nonces: ReplayNonceRegistry;
  readonly rateLimitStore: RateLimitStore;
  readonly clock: Clock;
  /** Production rejects plain HTTP; other environments allow it for local dev. */
  readonly enforceHttps: boolean;
  readonly maxBodyBytes?: number;
  readonly deviceRateLimits?: Readonly<Record<AgentEndpoint, readonly WindowRule[]>>;
  readonly partnerRateLimit?: WindowRule;
  readonly ipRateLimit?: WindowRule;
  readonly maxClockSkewSeconds?: number;
  readonly nonceTtlSeconds?: number;
}

const AUTH_FAILED: SafeError = mapDomainError({ kind: "authentication" });
const FORBIDDEN: SafeError = mapDomainError({ kind: "forbidden" });
const REPLAY_REJECTED: SafeError = mapDomainError({ kind: "replay" });
const RATE_LIMITED: SafeError = mapDomainError({ kind: "rate_limited" });
const IDEMPOTENCY_REQUIRED_ERROR: SafeError = mapDomainError({ kind: "idempotency_required" });

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

/** A single rate-limit window to check-then-consume, identified by its key. */
interface KeyedRule {
  readonly key: string;
  readonly rule: WindowRule;
}

export class AgentApiAuthenticator {
  private readonly deps: AgentApiAuthenticatorDeps;
  private readonly maxBodyBytes: number;
  private readonly deviceRateLimits: Readonly<Record<AgentEndpoint, readonly WindowRule[]>>;
  private readonly partnerRateLimit: WindowRule;
  private readonly ipRateLimit: WindowRule;
  private readonly maxClockSkewSeconds: number;
  private readonly nonceTtlSeconds: number;

  constructor(deps: AgentApiAuthenticatorDeps) {
    this.deps = deps;
    this.maxBodyBytes = deps.maxBodyBytes ?? AGENT_API_MAX_BODY_BYTES;
    this.deviceRateLimits = deps.deviceRateLimits ?? AGENT_DEVICE_RATE_LIMITS;
    this.partnerRateLimit = deps.partnerRateLimit ?? AGENT_PARTNER_RATE_LIMIT;
    this.ipRateLimit = deps.ipRateLimit ?? AGENT_IP_RATE_LIMIT;
    this.maxClockSkewSeconds = deps.maxClockSkewSeconds ?? AGENT_API_MAX_CLOCK_SKEW_SECONDS;
    this.nonceTtlSeconds = deps.nonceTtlSeconds ?? AGENT_API_NONCE_TTL_SECONDS;
  }

  async authenticate(request: AgentApiAuthRequest): Promise<AgentApiAuthResult> {
    // 1. HTTPS enforcement (production). Reject before touching credentials.
    if (this.deps.enforceHttps && !request.secure) {
      return reject(HTTPS_REQUIRED);
    }

    // 2. Request size limit. An oversized body is refused before any hashing so
    //    it cannot be used to burn CPU.
    if (byteLength(request.rawBody) > this.maxBodyBytes) {
      return reject(PAYLOAD_TOO_LARGE);
    }

    // 3. Per-network-source rate limit. Keyed on the client IP so an
    //    unauthenticated flood is bounded before credential verification; an
    //    attacker can only exhaust its own window, never a victim's identity.
    if (await this.consumeRateLimit([this.ipRule(request.clientIp)])) {
      return reject(RATE_LIMITED);
    }

    // 4. Credential + replay header shape. Any malformed/missing header ->
    //    generic failure so no shape detail leaks.
    const credential = parseAgentAuthorizationHeader(
      request.headers.get(AGENT_API_HEADERS.authorization),
    );
    if (credential === null) return reject(AUTH_FAILED);

    const replay = parseAgentReplayHeaders(
      {
        timestamp: request.headers.get(AGENT_API_HEADERS.timestamp),
        nonce: request.headers.get(AGENT_API_HEADERS.nonce),
        idempotencyKey: request.headers.get(AGENT_API_HEADERS.idempotencyKey),
      },
      { requireIdempotencyKey: IDEMPOTENCY_REQUIRED[request.endpoint] },
    );
    if (replay === null) {
      // A missing idempotency key on a mutation is a distinct, actionable
      // client error; every other shape failure stays generic.
      if (
        IDEMPOTENCY_REQUIRED[request.endpoint] &&
        !hasIdempotencyKey(request.headers.get(AGENT_API_HEADERS.idempotencyKey))
      ) {
        return reject(IDEMPOTENCY_REQUIRED_ERROR);
      }
      return reject(AUTH_FAILED);
    }

    // 5. Credential lookup + status. Only an ACTIVE credential authenticates; a
    //    rotated/revoked or unknown public id is refused (requirement 5.5).
    const record = await this.deps.credentials.findByPublicId(credential.publicId);
    if (record === null || record.credentialStatus !== "active") {
      return reject(AUTH_FAILED);
    }

    // 6. Constant-time secret verification (reuses the task 8.1 derivation).
    const secretValid = this.deps.secretVerifier.verifySecret(
      record.deviceId,
      credential.secret,
      record.secretHash,
    );
    if (!secretValid) return reject(AUTH_FAILED);

    // 7. Fail-closed authorization. The caller has proven it holds the secret,
    //    so a disabled device or non-approved partner surfaces as FORBIDDEN
    //    (requirements 5.6, 18.5) — still rejected before any mutation.
    if (record.partnerStatus !== "approved" || record.deviceStatus === "disabled") {
      return reject(FORBIDDEN);
    }

    // 8. Per-device (endpoint-specific) + per-partner rate limits, now that the
    //    device and partner identities are authenticated.
    const scopedRules: KeyedRule[] = [
      ...this.deviceRules(request.endpoint, record.deviceId),
      this.partnerRule(record.partnerId),
    ];
    if (await this.consumeRateLimit(scopedRules)) {
      return reject(RATE_LIMITED);
    }

    // 9. Replay validation (skew + nonce shape), then the atomic nonce claim.
    //    The nonce is namespaced per device so two devices may reuse a value.
    const principalId = `device:${record.deviceId}`;
    const nowSeconds = Math.floor(this.deps.clock.nowEpochMs() / 1000);
    const decision = validateReplayProtection({
      principalId,
      timestampSeconds: replay.timestampSeconds,
      nonce: replay.nonce,
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
      replay.nonce,
      decision.nonceExpiresAtSeconds * 1000,
    );
    if (!fresh) return reject(REPLAY_REJECTED);

    return {
      ok: true,
      principal: Object.freeze({
        partnerId: record.partnerId,
        deviceId: record.deviceId,
        credentialPublicId: record.publicId,
        endpoint: request.endpoint,
        idempotencyKey: replay.idempotencyKey.length === 0 ? null : replay.idempotencyKey,
      }),
    };
  }

  private ipRule(clientIp: string): KeyedRule {
    return { key: `agent:ip:${clientIp}`, rule: this.ipRateLimit };
  }

  private partnerRule(partnerId: string): KeyedRule {
    return { key: `agent:partner:${partnerId}`, rule: this.partnerRateLimit };
  }

  private deviceRules(endpoint: AgentEndpoint, deviceId: string): KeyedRule[] {
    return this.deviceRateLimits[endpoint].map((rule) => ({
      key: `agent:device:${deviceId}:${endpoint}:${rule.windowMs}:${rule.limit}`,
      rule,
    }));
  }

  /**
   * Check every rule read-only, and only if *all* are within budget consume one
   * event against each. Two-phase so a denial on one window never leaves a
   * partial increment on another. Returns `true` when the request is denied.
   */
  private async consumeRateLimit(rules: readonly KeyedRule[]): Promise<boolean> {
    const now = this.deps.clock.nowEpochMs();

    const evaluated = await Promise.all(
      rules.map(async ({ key, rule }) => {
        const counter = (await this.deps.rateLimitStore.get(key)) ?? emptyWindowCounter();
        const decision = evaluateWindow(counter, rule, now);
        return { key, rule, counter, decision };
      }),
    );

    if (evaluated.some(({ decision }) => !decision.allowed)) {
      return true;
    }

    await Promise.all(
      evaluated.map(async ({ key, rule, counter }) => {
        const next = registerEvent(counter, rule, now);
        await this.deps.rateLimitStore.set(key, next, next.windowStartEpochMs + rule.windowMs);
      }),
    );
    return false;
  }
}

function reject(error: SafeError): AgentApiAuthResult {
  return { ok: false, error };
}

/** UTF-8 byte length of the raw body (application layer; node available). */
function byteLength(rawBody: string): number {
  return Buffer.byteLength(rawBody, "utf8");
}

function hasIdempotencyKey(value: string | null): boolean {
  return value !== null && value.length > 0;
}
