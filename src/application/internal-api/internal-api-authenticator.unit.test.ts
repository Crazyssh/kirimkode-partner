import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import {
  buildInternalApiCanonicalString,
  INTERNAL_API_HEADERS,
} from "@domain/task-9-1/internal-api-signing";
import { NodeHmacSignatureVerifier } from "@infrastructure/auth/node-hmac-signature-verifier";
import { InMemoryRateLimitStore } from "@infrastructure/auth/in-memory-rate-limit-store";

import {
  InternalApiAuthenticator,
  INTERNAL_API_MAX_BODY_BYTES,
  type InternalApiAuthRequest,
  type InternalApiHmacConfig,
} from "./internal-api-authenticator";
import type {
  ServiceCredentialGateway,
  ServiceCredentialRecord,
  ServiceCredentialStatus,
} from "./ports";

const CLIENT_ID = "kirimkode-main";
const CURRENT_KEY_ID = "key-current-2024";
const PREVIOUS_KEY_ID = "key-previous-2023";
const CURRENT_SECRET = "current-hmac-secret-abcdefghijklmnop-01";
const PREVIOUS_SECRET = "previous-hmac-secret-abcdefghijklmnop-02";
const NONCE = "0123456789abcdef0123456789abcdef";
const NOW_SECONDS = 1_700_000_000;
const NOW_MS = NOW_SECONDS * 1000;

const hmacConfig: InternalApiHmacConfig = {
  clientId: CLIENT_ID,
  currentKeyId: CURRENT_KEY_ID,
  currentSecret: CURRENT_SECRET,
  previousKeyId: PREVIOUS_KEY_ID,
  previousSecret: PREVIOUS_SECRET,
};

const verifier = new NodeHmacSignatureVerifier();

class FakeServiceCredentialGateway implements ServiceCredentialGateway {
  private readonly rows = new Map<string, ServiceCredentialRecord>();

  set(clientId: string, keyId: string, status: ServiceCredentialStatus): void {
    this.rows.set(`${clientId}|${keyId}`, { clientId, keyId, status });
  }

  async findCredential(
    clientId: string,
    keyId: string,
  ): Promise<ServiceCredentialRecord | null> {
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

interface SignOptions {
  readonly method?: string;
  readonly path?: string;
  readonly body?: string;
  readonly timestampSeconds?: number;
  readonly nonce?: string;
  readonly keyId?: string;
  readonly secret?: string;
  readonly idempotencyKey?: string;
  readonly secure?: boolean;
  /** Override the signature header directly (to simulate tampering). */
  readonly signatureOverride?: string;
  readonly clientId?: string;
}

function buildRequest(options: SignOptions = {}): InternalApiAuthRequest {
  const method = options.method ?? "POST";
  const path = options.path ?? "/api/internal/v1/orders/reserve";
  const body = options.body ?? '{"buyerOrderRef":"buyer-1"}';
  const timestampSeconds = options.timestampSeconds ?? NOW_SECONDS;
  const nonce = options.nonce ?? NONCE;
  const keyId = options.keyId ?? CURRENT_KEY_ID;
  const secret = options.secret ?? CURRENT_SECRET;
  const idempotencyKey = options.idempotencyKey ?? "reserve-123";
  const clientId = options.clientId ?? CLIENT_ID;

  const canonical = buildInternalApiCanonicalString({
    method,
    path,
    timestampSeconds,
    nonce,
    bodySha256Hex: verifier.bodySha256Hex(body),
    idempotencyKey,
  });
  const signature =
    options.signatureOverride ??
    createHmac("sha256", secret).update(canonical, "utf8").digest("hex");

  const headers = new Headers();
  headers.set(INTERNAL_API_HEADERS.clientId, clientId);
  headers.set(INTERNAL_API_HEADERS.keyId, keyId);
  headers.set(INTERNAL_API_HEADERS.timestamp, String(timestampSeconds));
  headers.set(INTERNAL_API_HEADERS.nonce, nonce);
  headers.set(INTERNAL_API_HEADERS.signature, signature);
  if (idempotencyKey.length > 0) headers.set(INTERNAL_API_HEADERS.idempotencyKey, idempotencyKey);

  return { method, path, headers, rawBody: body, secure: options.secure ?? true };
}

interface Harness {
  readonly authenticator: InternalApiAuthenticator;
  readonly credentials: FakeServiceCredentialGateway;
  readonly nonces: FakeReplayNonceRegistry;
  readonly clock: FakeClock;
}

function makeHarness(overrides: { enforceHttps?: boolean } = {}): Harness {
  const credentials = new FakeServiceCredentialGateway();
  credentials.set(CLIENT_ID, CURRENT_KEY_ID, "active");
  credentials.set(CLIENT_ID, PREVIOUS_KEY_ID, "active");
  const nonces = new FakeReplayNonceRegistry();
  const clock = new FakeClock(NOW_MS);

  const authenticator = new InternalApiAuthenticator({
    hmac: hmacConfig,
    credentials,
    nonces,
    verifier,
    rateLimitStore: new InMemoryRateLimitStore(() => clock.nowEpochMs()),
    clock,
    enforceHttps: overrides.enforceHttps ?? false,
  });

  return { authenticator, credentials, nonces, clock };
}

// **Validates: Requirements 10.1, 10.6, 10.7, 18.5, 22.1**
describe("InternalApiAuthenticator", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it("authenticates a correctly signed request and returns the service principal", async () => {
    const result = await harness.authenticator.authenticate(buildRequest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal).toMatchObject({
        clientId: CLIENT_ID,
        keyId: CURRENT_KEY_ID,
        principalId: CLIENT_ID,
        idempotencyKey: "reserve-123",
      });
    }
  });

  it("authenticates with the previous rotation key during rotation", async () => {
    const result = await harness.authenticator.authenticate(
      buildRequest({ keyId: PREVIOUS_KEY_ID, secret: PREVIOUS_SECRET }),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a read request with no idempotency key (empty canonical field)", async () => {
    const result = await harness.authenticator.authenticate(
      buildRequest({ method: "GET", path: "/api/internal/v1/inventory", body: "", idempotencyKey: "" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal.idempotencyKey).toBeNull();
  });

  it("rejects an unknown client id as generic AUTHENTICATION_FAILED", async () => {
    const result = await harness.authenticator.authenticate(buildRequest({ clientId: "attacker" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AUTHENTICATION_FAILED");
    expect(harness.nonces.registrations).toBe(0);
  });

  it("rejects an unknown key id", async () => {
    const result = await harness.authenticator.authenticate(
      buildRequest({ keyId: "key-unknown", secret: CURRENT_SECRET }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("rejects a revoked service credential even with a valid signature", async () => {
    harness.credentials.set(CLIENT_ID, CURRENT_KEY_ID, "revoked");
    const result = await harness.authenticator.authenticate(buildRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AUTHENTICATION_FAILED");
    expect(harness.nonces.registrations).toBe(0);
  });

  it("rejects a superseded credential", async () => {
    harness.credentials.set(CLIENT_ID, CURRENT_KEY_ID, "superseded");
    const result = await harness.authenticator.authenticate(buildRequest());
    expect(result.ok).toBe(false);
  });

  it("rejects a tampered signature before any mutation", async () => {
    const result = await harness.authenticator.authenticate(
      buildRequest({ signatureOverride: "f".repeat(64) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AUTHENTICATION_FAILED");
    expect(harness.nonces.registrations).toBe(0);
  });

  it("rejects when the body is altered after signing (body-bound signature)", async () => {
    const request = buildRequest();
    const tampered: InternalApiAuthRequest = { ...request, rawBody: '{"buyerOrderRef":"buyer-2"}' };
    const result = await harness.authenticator.authenticate(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("rejects a timestamp outside the 300s clock skew as REPLAY_REJECTED", async () => {
    const stale = await harness.authenticator.authenticate(
      buildRequest({ timestampSeconds: NOW_SECONDS - 301 }),
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("REPLAY_REJECTED");

    const future = await harness.authenticator.authenticate(
      buildRequest({ timestampSeconds: NOW_SECONDS + 301, nonce: "f".repeat(32) }),
    );
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.error.code).toBe("REPLAY_REJECTED");
  });

  it("accepts a timestamp exactly at the skew boundary", async () => {
    const result = await harness.authenticator.authenticate(
      buildRequest({ timestampSeconds: NOW_SECONDS - 300 }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a replayed nonce on the second use", async () => {
    const first = await harness.authenticator.authenticate(buildRequest({ idempotencyKey: "k1" }));
    expect(first.ok).toBe(true);

    // Same nonce, fresh signature over a different idempotency key: the nonce
    // registry rejects the replay.
    const replay = await harness.authenticator.authenticate(buildRequest({ idempotencyKey: "k2" }));
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("REPLAY_REJECTED");
  });

  it("rejects a malformed nonce as REPLAY_REJECTED", async () => {
    const result = await harness.authenticator.authenticate(buildRequest({ nonce: "too-short" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("REPLAY_REJECTED");
  });

  it("rejects plain HTTP when HTTPS is enforced (production)", async () => {
    const secured = makeHarness({ enforceHttps: true });
    const result = await secured.authenticator.authenticate(buildRequest({ secure: false }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("HTTPS_REQUIRED");
    expect(secured.nonces.registrations).toBe(0);
  });

  it("rejects an oversized request body", async () => {
    const big = "x".repeat(INTERNAL_API_MAX_BODY_BYTES + 1);
    const result = await harness.authenticator.authenticate(buildRequest({ body: big }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects a request missing signing headers as generic AUTHENTICATION_FAILED", async () => {
    const result = await harness.authenticator.authenticate({
      method: "POST",
      path: "/api/internal/v1/orders/reserve",
      headers: new Headers(),
      rawBody: "{}",
      secure: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("enforces a per-client rate limit and returns RATE_LIMITED when exceeded", async () => {
    const limited = new InternalApiAuthenticator({
      hmac: hmacConfig,
      credentials: harness.credentials,
      nonces: harness.nonces,
      verifier,
      rateLimitStore: new InMemoryRateLimitStore(() => harness.clock.nowEpochMs()),
      clock: harness.clock,
      enforceHttps: false,
      rateLimit: { limit: 1, windowMs: 60_000 },
    });

    const first = await limited.authenticate(buildRequest({ nonce: "a".repeat(32), idempotencyKey: "k1" }));
    expect(first.ok).toBe(true);

    const second = await limited.authenticate(buildRequest({ nonce: "b".repeat(32), idempotencyKey: "k2" }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("RATE_LIMITED");
  });
});
