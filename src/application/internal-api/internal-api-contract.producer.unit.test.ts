/**
 * Consumer-driven contract test — PRODUCER side (task 17.1).
 *
 * This is one half of a two-sided, consumer-driven contract for Internal API
 * v1. The Main Platform (consumer) and the Partner Platform (producer, this
 * repo) must agree, byte-for-byte, on a single wire contract. To make that
 * agreement *provable* rather than aspirational, both sides embed the SAME
 * frozen fixture (`CONTRACT` below) — identical header names, canonicalization
 * algorithm, golden signature/body-hash vectors, envelope shapes, error-code
 * table, and operation set. The peer test lives at
 * `WEB/src/lib/partner-contract.test.ts`; the two `CONTRACT` objects are copied
 * literally so any drift on either side fails against the shared golden values.
 *
 * This file asserts the PRODUCER honours the contract:
 *   - the production canonical-string builder + HMAC verifier reproduce the
 *     golden signatures (pins canonicalization to the contract);
 *   - the authenticator accepts a request signed per the contract with the
 *     current AND previous rotation key, within 300s skew and a fresh nonce;
 *   - the authenticator rejects tampered / expired / replayed requests BEFORE
 *     any mutation (requirement 18.5);
 *   - the success/error envelope shapes and the stable error-code-by-status
 *     table (400/401/403/404/409 incl. idempotency conflict/422/429/503) match
 *     the contract.
 *
 * **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7**
 */
import { createHash, createHmac } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import {
  buildInternalApiCanonicalString,
  INTERNAL_API_HEADERS,
} from "@domain/task-9-1/internal-api-signing";
import { mapDomainError } from "@domain/task-5-3/safe-errors";
import { NodeHmacSignatureVerifier } from "@infrastructure/auth/node-hmac-signature-verifier";
import { InMemoryRateLimitStore } from "@infrastructure/auth/in-memory-rate-limit-store";

import {
  errorEnvelope,
  successEnvelope,
} from "./api-envelope";
import {
  InternalApiAuthenticator,
  type InternalApiAuthRequest,
  type InternalApiHmacConfig,
} from "./internal-api-authenticator";
import type {
  ServiceCredentialGateway,
  ServiceCredentialRecord,
  ServiceCredentialStatus,
} from "./ports";

/* ------------------------------------------------------------------------- *
 * THE SHARED CONTRACT (must be identical in WEB/src/lib/partner-contract.test.ts)
 * ------------------------------------------------------------------------- */

const CONTRACT = Object.freeze({
  /** Signing header names on the wire (case-insensitive; lower-cased here). */
  headers: Object.freeze({
    clientId: "x-kk-client-id",
    keyId: "x-kk-key-id",
    timestamp: "x-kk-timestamp",
    nonce: "x-kk-nonce",
    signature: "x-kk-signature",
    idempotencyKey: "idempotency-key",
  }),

  /** SHA-256 of the empty string — the body hash for every read (no body). */
  emptyBodySha256:
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",

  /**
   * The credential the consumer signs with and the producer verifies. Current
   * + previous keys exercise rotation (design section 4: "current+previous saat
   * rotasi").
   */
  clientId: "kirimkode-main",
  currentKeyId: "key-current-2026",
  currentSecret: "contract-hmac-secret-current-0123456789ab",
  previousKeyId: "key-previous-2025",
  previousSecret: "contract-hmac-secret-previous-0123456789cd",

  /** Replay bounds (design section 4). */
  maxClockSkewSeconds: 300,
  nonceTtlSeconds: 600,

  /** The six operations of Internal API v1 (design section 4 table). */
  operations: Object.freeze({
    inventory: Object.freeze({ method: "GET", path: "/api/internal/v1/inventory", idempotent: false }),
    reserve: Object.freeze({ method: "POST", path: "/api/internal/v1/orders/reserve", idempotent: true }),
    status: Object.freeze({ method: "GET", path: "/api/internal/v1/orders/order-uuid-1", idempotent: false }),
    cancel: Object.freeze({ method: "POST", path: "/api/internal/v1/orders/order-uuid-1/cancel", idempotent: true }),
    timeout: Object.freeze({ method: "POST", path: "/api/internal/v1/orders/order-uuid-1/timeout", idempotent: true }),
    reconciliation: Object.freeze({ method: "POST", path: "/api/internal/v1/reconciliation/orders", idempotent: true }),
  }),

  /**
   * Golden reserve vector: a POST to /orders/reserve with a fixed timestamp,
   * nonce, body, and idempotency key, signed with `currentSecret`. Both sides
   * MUST reproduce `bodySha256` and `signature` exactly.
   */
  reserveVector: Object.freeze({
    method: "POST",
    path: "/api/internal/v1/orders/reserve",
    timestampSeconds: 1_700_000_000,
    nonce: "0123456789abcdef0123456789abcdef",
    idempotencyKey: "reserve-key-1",
    body:
      '{"buyerOrderRef":"buyer-ref-1","buyerAccountRef":"acct-ref-1","quoteVersion":1,"filter":{"service":"wa","country":"ID","operator":"any"}}',
    bodySha256:
      "8969406059ccf5e95b4c4950ed1eccd5d998f2646473fdb26058db5b98254995",
    signature:
      "9bebfec0d02c4b9b587eea8394ddab3541a0d5875d0c3536bfbd4d5acb59968f",
  }),

  /**
   * Golden inventory (read) vector: a GET with query string, empty body, and
   * no idempotency key (empty final canonical field).
   */
  inventoryVector: Object.freeze({
    method: "GET",
    path: "/api/internal/v1/inventory?service=wa&country=ID&operator=any",
    timestampSeconds: 1_700_000_000,
    nonce: "fedcba9876543210fedcba9876543210",
    idempotencyKey: "",
    signature:
      "dcafae92b7631ef7ce19b56e266b91656852ff7e5c096d08dfbfd2d28d1b45f4",
  }),

  /** Stable error code + HTTP status per contract (design section 4). */
  errorTable: Object.freeze({
    validation: Object.freeze({ status: 400, code: "VALIDATION_ERROR", retryable: false }),
    authentication: Object.freeze({ status: 401, code: "AUTHENTICATION_FAILED", retryable: false }),
    forbidden: Object.freeze({ status: 403, code: "FORBIDDEN", retryable: false }),
    not_found: Object.freeze({ status: 404, code: "RESOURCE_NOT_FOUND", retryable: false }),
    idempotency_conflict: Object.freeze({ status: 409, code: "IDEMPOTENCY_CONFLICT", retryable: false }),
    out_of_stock: Object.freeze({ status: 409, code: "OUT_OF_STOCK", retryable: false }),
    terminal_state_conflict: Object.freeze({ status: 422, code: "TERMINAL_STATE_CONFLICT", retryable: false }),
    cancel_not_allowed: Object.freeze({ status: 422, code: "CANCEL_NOT_ALLOWED", retryable: false }),
    price_out_of_guardrail: Object.freeze({ status: 422, code: "PRICE_OUT_OF_GUARDRAIL", retryable: false }),
    rate_limited: Object.freeze({ status: 429, code: "RATE_LIMITED", retryable: true }),
    dependency_unavailable: Object.freeze({ status: 503, code: "DEPENDENCY_UNAVAILABLE", retryable: true }),
  }),
});

/**
 * Reference canonical algorithm — the single source of truth both sides embed
 * verbatim: METHOD \n path \n unixSeconds \n nonce \n sha256hex(body) \n key.
 */
function contractCanonicalString(
  method: string,
  path: string,
  timestampSeconds: number,
  nonce: string,
  bodySha256Hex: string,
  idempotencyKey: string,
): string {
  return [
    method.toUpperCase(),
    path,
    String(timestampSeconds),
    nonce,
    bodySha256Hex.toLowerCase(),
    idempotencyKey,
  ].join("\n");
}

function contractSha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function contractSignature(canonical: string, secret: string): string {
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

/* ------------------------------------------------------------------------- *
 * Producer harness (mirrors the authenticator unit test's fakes)
 * ------------------------------------------------------------------------- */

const verifier = new NodeHmacSignatureVerifier();

const hmacConfig: InternalApiHmacConfig = {
  clientId: CONTRACT.clientId,
  currentKeyId: CONTRACT.currentKeyId,
  currentSecret: CONTRACT.currentSecret,
  previousKeyId: CONTRACT.previousKeyId,
  previousSecret: CONTRACT.previousSecret,
};

class FakeServiceCredentialGateway implements ServiceCredentialGateway {
  private readonly rows = new Map<string, ServiceCredentialRecord>();
  set(clientId: string, keyId: string, status: ServiceCredentialStatus): void {
    this.rows.set(`${clientId}|${keyId}`, { clientId, keyId, status });
  }
  async findCredential(clientId: string, keyId: string): Promise<ServiceCredentialRecord | null> {
    return this.rows.get(`${clientId}|${keyId}`) ?? null;
  }
}

class FakeReplayNonceRegistry {
  readonly seen = new Set<string>();
  registrations = 0;
  async registerNonce(principalId: string, nonce: string): Promise<boolean> {
    this.registrations += 1;
    const key = `${principalId}|${nonce}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

class FakeClock {
  constructor(public epochMs: number) {}
  nowEpochMs(): number {
    return this.epochMs;
  }
}

interface Harness {
  readonly authenticator: InternalApiAuthenticator;
  readonly credentials: FakeServiceCredentialGateway;
  readonly nonces: FakeReplayNonceRegistry;
  readonly clock: FakeClock;
}

/** Clock fixed so the golden vectors' timestamp is within skew. */
const NOW_SECONDS = CONTRACT.reserveVector.timestampSeconds;
const NOW_MS = NOW_SECONDS * 1000;

function makeHarness(): Harness {
  const credentials = new FakeServiceCredentialGateway();
  credentials.set(CONTRACT.clientId, CONTRACT.currentKeyId, "active");
  credentials.set(CONTRACT.clientId, CONTRACT.previousKeyId, "active");
  const nonces = new FakeReplayNonceRegistry();
  const clock = new FakeClock(NOW_MS);
  const authenticator = new InternalApiAuthenticator({
    hmac: hmacConfig,
    credentials,
    nonces,
    verifier,
    rateLimitStore: new InMemoryRateLimitStore(() => clock.nowEpochMs()),
    clock,
    enforceHttps: false,
    maxClockSkewSeconds: CONTRACT.maxClockSkewSeconds,
    nonceTtlSeconds: CONTRACT.nonceTtlSeconds,
  });
  return { authenticator, credentials, nonces, clock };
}

interface SignOptions {
  readonly method?: string;
  readonly path?: string;
  readonly body?: string;
  readonly timestampSeconds?: number;
  readonly nonce?: string;
  readonly keyId?: string;
  readonly secret?: string;
  readonly idempotencyKey?: string;
  readonly signatureOverride?: string;
  readonly clientId?: string;
}

/** Build a request signed exactly per the contract's canonical algorithm. */
function signPerContract(options: SignOptions = {}): InternalApiAuthRequest {
  const method = options.method ?? CONTRACT.reserveVector.method;
  const path = options.path ?? CONTRACT.reserveVector.path;
  const body = options.body ?? CONTRACT.reserveVector.body;
  const timestampSeconds = options.timestampSeconds ?? NOW_SECONDS;
  const nonce = options.nonce ?? CONTRACT.reserveVector.nonce;
  const keyId = options.keyId ?? CONTRACT.currentKeyId;
  const secret = options.secret ?? CONTRACT.currentSecret;
  const idempotencyKey = options.idempotencyKey ?? CONTRACT.reserveVector.idempotencyKey;
  const clientId = options.clientId ?? CONTRACT.clientId;

  const bodyHash = body === "" ? CONTRACT.emptyBodySha256 : contractSha256Hex(body);
  const canonical = contractCanonicalString(method, path, timestampSeconds, nonce, bodyHash, idempotencyKey);
  const signature = options.signatureOverride ?? contractSignature(canonical, secret);

  const headers = new Headers();
  headers.set(INTERNAL_API_HEADERS.clientId, clientId);
  headers.set(INTERNAL_API_HEADERS.keyId, keyId);
  headers.set(INTERNAL_API_HEADERS.timestamp, String(timestampSeconds));
  headers.set(INTERNAL_API_HEADERS.nonce, nonce);
  headers.set(INTERNAL_API_HEADERS.signature, signature);
  if (idempotencyKey.length > 0) headers.set(INTERNAL_API_HEADERS.idempotencyKey, idempotencyKey);

  return { method, path, headers, rawBody: body, secure: true };
}

describe("Internal API v1 contract — PRODUCER", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = makeHarness();
  });

  describe("canonicalization is pinned to the shared golden vectors", () => {
    it("header names match the contract exactly", () => {
      expect(INTERNAL_API_HEADERS).toEqual(CONTRACT.headers);
    });

    it("empty body hashes to the contract's empty-body SHA-256", () => {
      expect(verifier.bodySha256Hex("")).toBe(CONTRACT.emptyBodySha256);
      expect(contractSha256Hex("")).toBe(CONTRACT.emptyBodySha256);
    });

    it("the production builder + verifier reproduce the golden reserve signature", () => {
      const v = CONTRACT.reserveVector;
      const bodyHash = verifier.bodySha256Hex(v.body);
      expect(bodyHash).toBe(v.bodySha256);

      const canonical = buildInternalApiCanonicalString({
        method: v.method,
        path: v.path,
        timestampSeconds: v.timestampSeconds,
        nonce: v.nonce,
        bodySha256Hex: bodyHash,
        idempotencyKey: v.idempotencyKey,
      });
      // The production builder must equal the reference algorithm...
      expect(canonical).toBe(
        contractCanonicalString(v.method, v.path, v.timestampSeconds, v.nonce, bodyHash, v.idempotencyKey),
      );
      // ...and signing it must reproduce the frozen golden signature.
      expect(contractSignature(canonical, CONTRACT.currentSecret)).toBe(v.signature);
    });

    it("the production builder reproduces the golden inventory (read) signature", () => {
      const v = CONTRACT.inventoryVector;
      const canonical = buildInternalApiCanonicalString({
        method: v.method,
        path: v.path,
        timestampSeconds: v.timestampSeconds,
        nonce: v.nonce,
        bodySha256Hex: CONTRACT.emptyBodySha256,
        idempotencyKey: v.idempotencyKey,
      });
      expect(contractSignature(canonical, CONTRACT.currentSecret)).toBe(v.signature);
    });
  });

  describe("authenticator accepts requests signed per the contract", () => {
    it("accepts the golden reserve request with the current key", async () => {
      const result = await harness.authenticator.authenticate(signPerContract());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.principal.clientId).toBe(CONTRACT.clientId);
        expect(result.principal.keyId).toBe(CONTRACT.currentKeyId);
        expect(result.principal.idempotencyKey).toBe(CONTRACT.reserveVector.idempotencyKey);
      }
    });

    it("accepts a request signed with the PREVIOUS rotation key", async () => {
      const result = await harness.authenticator.authenticate(
        signPerContract({
          keyId: CONTRACT.previousKeyId,
          secret: CONTRACT.previousSecret,
          nonce: "aaaabbbbccccddddaaaabbbbccccdddd",
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.principal.keyId).toBe(CONTRACT.previousKeyId);
    });

    it("accepts a read (no idempotency key) — empty canonical final field", async () => {
      const result = await harness.authenticator.authenticate(
        signPerContract({
          method: "GET",
          path: CONTRACT.inventoryVector.path,
          body: "",
          idempotencyKey: "",
          nonce: CONTRACT.inventoryVector.nonce,
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.principal.idempotencyKey).toBeNull();
    });

    it("accepts a request at the exact 300s skew boundary", async () => {
      const result = await harness.authenticator.authenticate(
        signPerContract({ timestampSeconds: NOW_SECONDS - CONTRACT.maxClockSkewSeconds }),
      );
      expect(result.ok).toBe(true);
    });

    it("authenticates all six contract operations", async () => {
      for (const [name, op] of Object.entries(CONTRACT.operations)) {
        const local = makeHarness();
        const body = op.method === "GET" ? "" : `{"op":"${name}"}`;
        const idempotencyKey = op.idempotent ? `${name}-key-1` : "";
        const result = await local.authenticator.authenticate(
          signPerContract({
            method: op.method,
            path: op.path,
            body,
            idempotencyKey,
            nonce: contractSha256Hex(name).slice(0, 32),
          }),
        );
        expect(result.ok, `operation ${name} must authenticate`).toBe(true);
        if (result.ok) {
          expect(result.principal.idempotencyKey).toBe(op.idempotent ? idempotencyKey : null);
        }
      }
    });
  });

  describe("authenticator rejects invalid requests BEFORE any mutation (18.5)", () => {
    it("rejects a tampered signature and registers no nonce", async () => {
      const result = await harness.authenticator.authenticate(
        signPerContract({ signatureOverride: "f".repeat(64) }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(CONTRACT.errorTable.authentication.code);
      expect(harness.nonces.registrations).toBe(0);
    });

    it("rejects a body altered after signing (body-bound signature)", async () => {
      const req = signPerContract();
      const tampered: InternalApiAuthRequest = { ...req, rawBody: '{"buyerOrderRef":"attacker"}' };
      const result = await harness.authenticator.authenticate(tampered);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(CONTRACT.errorTable.authentication.code);
    });

    it("rejects an expired timestamp (beyond 300s skew) as REPLAY_REJECTED", async () => {
      const result = await harness.authenticator.authenticate(
        signPerContract({ timestampSeconds: NOW_SECONDS - (CONTRACT.maxClockSkewSeconds + 1) }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("REPLAY_REJECTED");
      expect(harness.nonces.registrations).toBe(0);
    });

    it("rejects a replayed nonce on second use", async () => {
      const first = await harness.authenticator.authenticate(signPerContract({ idempotencyKey: "reserve-key-1" }));
      expect(first.ok).toBe(true);
      const replay = await harness.authenticator.authenticate(signPerContract({ idempotencyKey: "reserve-key-2" }));
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.error.code).toBe("REPLAY_REJECTED");
    });

    it("rejects an unknown client id as generic AUTHENTICATION_FAILED", async () => {
      const result = await harness.authenticator.authenticate(signPerContract({ clientId: "attacker" }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(CONTRACT.errorTable.authentication.code);
      expect(harness.nonces.registrations).toBe(0);
    });
  });

  describe("envelope shapes and error-code table match the contract", () => {
    it("success envelope is { data, requestId }", () => {
      const env = successEnvelope({ available: 1 }, "req-1");
      expect(env).toEqual({ data: { available: 1 }, requestId: "req-1" });
    });

    it("error envelope is { error: { code, message, retryable }, requestId }", () => {
      const env = errorEnvelope(mapDomainError({ kind: "idempotency_conflict" }), "req-2");
      expect(env).toEqual({
        error: {
          code: CONTRACT.errorTable.idempotency_conflict.code,
          message: expect.any(String),
          retryable: CONTRACT.errorTable.idempotency_conflict.retryable,
        },
        requestId: "req-2",
      });
    });

    it("maps every contract domain error to the pinned status + code + retryable", () => {
      for (const [kind, expected] of Object.entries(CONTRACT.errorTable)) {
        const safe = mapDomainError({ kind });
        expect(safe.status, `status for ${kind}`).toBe(expected.status);
        expect(safe.code, `code for ${kind}`).toBe(expected.code);
        expect(safe.retryable, `retryable for ${kind}`).toBe(expected.retryable);
      }
    });

    it("surfaces the idempotency conflict as 409 IDEMPOTENCY_CONFLICT", () => {
      const safe = mapDomainError({ kind: "idempotency_conflict" });
      expect(safe.status).toBe(409);
      expect(safe.code).toBe("IDEMPOTENCY_CONFLICT");
    });
  });
});
