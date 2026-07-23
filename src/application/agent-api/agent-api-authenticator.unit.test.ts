import { beforeEach, describe, expect, it } from "vitest";

import { CryptoDeviceCredentialFactory } from "@infrastructure/auth/crypto-device-credential";
import { InMemoryRateLimitStore } from "@infrastructure/auth/in-memory-rate-limit-store";

import {
  AgentApiAuthenticator,
  AGENT_API_MAX_BODY_BYTES,
  type AgentApiAuthRequest,
  type AgentEndpoint,
} from "./agent-api-authenticator";
import {
  AGENT_API_HEADERS,
} from "@domain/task-11-1/agent-api-auth";
import type {
  AgentDeviceAuthRecord,
  AgentDeviceCredentialGateway,
  DeviceCredentialStatus,
  DeviceEffectiveStatus,
} from "./ports";
import type { PartnerStatus } from "@domain/task-5-1/partner-status";

const PEPPER = "test-device-credential-pepper-0123456789";
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const PARTNER_ID = "22222222-2222-4222-8222-222222222222";
const PUBLIC_ID = "cHVibGljLWlkLTAxMjM0NTY3OA";
const NONCE = "0123456789abcdef0123456789abcdef";
const CLIENT_IP = "203.0.113.7";
const NOW_SECONDS = 1_700_000_000;
const NOW_MS = NOW_SECONDS * 1000;

const factory = new CryptoDeviceCredentialFactory(PEPPER);
// A stable secret/hash pair for the fixture device.
const SECRET = "s".repeat(43);
const SECRET_HASH = factory.hashSecret(DEVICE_ID, SECRET);

class FakeAgentDeviceCredentialGateway implements AgentDeviceCredentialGateway {
  private readonly rows = new Map<string, AgentDeviceAuthRecord>();

  set(record: AgentDeviceAuthRecord): void {
    this.rows.set(record.publicId, record);
  }

  async findByPublicId(publicId: string): Promise<AgentDeviceAuthRecord | null> {
    return this.rows.get(publicId) ?? null;
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

interface BuildOptions {
  readonly endpoint?: AgentEndpoint;
  readonly publicId?: string;
  readonly secret?: string;
  readonly timestampSeconds?: number;
  readonly nonce?: string;
  readonly idempotencyKey?: string | null;
  readonly authorization?: string;
  readonly secure?: boolean;
  readonly clientIp?: string;
  readonly body?: string;
}

function buildRequest(options: BuildOptions = {}): AgentApiAuthRequest {
  const endpoint = options.endpoint ?? "sms";
  const publicId = options.publicId ?? PUBLIC_ID;
  const secret = options.secret ?? SECRET;
  const authorization = options.authorization ?? `Device ${publicId}.${secret}`;

  const headers = new Headers();
  headers.set(AGENT_API_HEADERS.authorization, authorization);
  headers.set(AGENT_API_HEADERS.timestamp, String(options.timestampSeconds ?? NOW_SECONDS));
  headers.set(AGENT_API_HEADERS.nonce, options.nonce ?? NONCE);
  // For mutations the default fixture includes an idempotency key; pass `null`
  // to omit it.
  const idempotencyKey =
    options.idempotencyKey === undefined ? "sms-message-1" : options.idempotencyKey;
  if (idempotencyKey !== null) {
    headers.set(AGENT_API_HEADERS.idempotencyKey, idempotencyKey);
  }

  return {
    endpoint,
    headers,
    rawBody: options.body ?? '{"messageId":"m-1"}',
    secure: options.secure ?? true,
    clientIp: options.clientIp ?? CLIENT_IP,
  };
}

interface Harness {
  readonly authenticator: AgentApiAuthenticator;
  readonly credentials: FakeAgentDeviceCredentialGateway;
  readonly nonces: FakeReplayNonceRegistry;
  readonly clock: FakeClock;
}

function record(overrides: Partial<AgentDeviceAuthRecord> = {}): AgentDeviceAuthRecord {
  return {
    publicId: PUBLIC_ID,
    secretHash: SECRET_HASH,
    deviceId: DEVICE_ID,
    partnerId: PARTNER_ID,
    credentialStatus: "active" as DeviceCredentialStatus,
    deviceStatus: "online" as DeviceEffectiveStatus,
    partnerStatus: "approved" as PartnerStatus,
    ...overrides,
  };
}

function makeHarness(overrides: { enforceHttps?: boolean } = {}): Harness {
  const credentials = new FakeAgentDeviceCredentialGateway();
  credentials.set(record());
  const nonces = new FakeReplayNonceRegistry();
  const clock = new FakeClock(NOW_MS);

  const authenticator = new AgentApiAuthenticator({
    credentials,
    secretVerifier: factory,
    nonces,
    rateLimitStore: new InMemoryRateLimitStore(() => clock.nowEpochMs()),
    clock,
    enforceHttps: overrides.enforceHttps ?? false,
  });

  return { authenticator, credentials, nonces, clock };
}

// **Validates: Requirements 5.5, 5.6, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7**
describe("AgentApiAuthenticator", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it("authenticates a well-formed device request and returns the principal", async () => {
    const result = await harness.authenticator.authenticate(buildRequest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal).toMatchObject({
        partnerId: PARTNER_ID,
        deviceId: DEVICE_ID,
        credentialPublicId: PUBLIC_ID,
        endpoint: "sms",
        idempotencyKey: "sms-message-1",
      });
    }
  });

  it("accepts a heartbeat without an idempotency key", async () => {
    const result = await harness.authenticator.authenticate(
      buildRequest({ endpoint: "heartbeat", idempotencyKey: null }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal.idempotencyKey).toBeNull();
  });

  it("requires an idempotency key for SMS/inventory mutations", async () => {
    const sms = await harness.authenticator.authenticate(
      buildRequest({ endpoint: "sms", idempotencyKey: null }),
    );
    expect(sms.ok).toBe(false);
    if (!sms.ok) expect(sms.error.code).toBe("IDEMPOTENCY_REQUIRED");
    expect(harness.nonces.registrations).toBe(0);

    const numbers = await harness.authenticator.authenticate(
      buildRequest({ endpoint: "number-mutation", idempotencyKey: null }),
    );
    expect(numbers.ok).toBe(false);
    if (!numbers.ok) expect(numbers.error.code).toBe("IDEMPOTENCY_REQUIRED");
  });

  it("rejects a missing or malformed Authorization header as generic AUTHENTICATION_FAILED", async () => {
    const missing = await harness.authenticator.authenticate(
      buildRequest({ authorization: "" }),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("AUTHENTICATION_FAILED");

    const wrongScheme = await harness.authenticator.authenticate(
      buildRequest({ authorization: `Bearer ${PUBLIC_ID}.${SECRET}` }),
    );
    expect(wrongScheme.ok).toBe(false);
    if (!wrongScheme.ok) expect(wrongScheme.error.code).toBe("AUTHENTICATION_FAILED");
    expect(harness.nonces.registrations).toBe(0);
  });

  it("rejects an unknown public id", async () => {
    const result = await harness.authenticator.authenticate(
      buildRequest({ publicId: "dW5rbm93bi1wdWJsaWMtaWQ" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("rejects a revoked or superseded credential even with the correct secret", async () => {
    harness.credentials.set(record({ credentialStatus: "revoked" }));
    const revoked = await harness.authenticator.authenticate(buildRequest());
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.error.code).toBe("AUTHENTICATION_FAILED");

    harness.credentials.set(record({ credentialStatus: "superseded" }));
    const superseded = await harness.authenticator.authenticate(buildRequest());
    expect(superseded.ok).toBe(false);
    expect(harness.nonces.registrations).toBe(0);
  });

  it("rejects a wrong secret via constant-time verification", async () => {
    const result = await harness.authenticator.authenticate(
      buildRequest({ secret: "w".repeat(43) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AUTHENTICATION_FAILED");
    expect(harness.nonces.registrations).toBe(0);
  });

  it("rejects a disabled device as FORBIDDEN (fail-closed)", async () => {
    harness.credentials.set(record({ deviceStatus: "disabled" }));
    const result = await harness.authenticator.authenticate(buildRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    expect(harness.nonces.registrations).toBe(0);
  });

  it("rejects a non-approved partner as FORBIDDEN (fail-closed)", async () => {
    for (const partnerStatus of ["pending", "suspended", "rejected"] as const) {
      harness.credentials.set(record({ partnerStatus }));
      const result = await harness.authenticator.authenticate(buildRequest());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    }
  });

  it("rejects a timestamp outside the 300s skew as REPLAY_REJECTED", async () => {
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
    const first = await harness.authenticator.authenticate(
      buildRequest({ idempotencyKey: "sms-1" }),
    );
    expect(first.ok).toBe(true);

    const replay = await harness.authenticator.authenticate(
      buildRequest({ idempotencyKey: "sms-2" }),
    );
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("REPLAY_REJECTED");
  });

  it("rejects a malformed nonce as REPLAY_REJECTED", async () => {
    const result = await harness.authenticator.authenticate(
      buildRequest({ nonce: "too-short" }),
    );
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

  it("rejects an oversized request body (16 KiB limit)", async () => {
    const big = "x".repeat(AGENT_API_MAX_BODY_BYTES + 1);
    const result = await harness.authenticator.authenticate(buildRequest({ body: big }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("enforces the per-device SMS rate limit (30/min)", async () => {
    for (let index = 0; index < 30; index += 1) {
      const ok = await harness.authenticator.authenticate(
        buildRequest({ nonce: hex(index), idempotencyKey: `sms-${index}` }),
      );
      expect(ok.ok).toBe(true);
    }
    const limited = await harness.authenticator.authenticate(
      buildRequest({ nonce: hex(30), idempotencyKey: "sms-30" }),
    );
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.error.code).toBe("RATE_LIMITED");
  });

  it("enforces the heartbeat burst cap (3) before the per-minute limit (6)", async () => {
    for (let index = 0; index < 3; index += 1) {
      const ok = await harness.authenticator.authenticate(
        buildRequest({ endpoint: "heartbeat", idempotencyKey: null, nonce: hex(index) }),
      );
      expect(ok.ok).toBe(true);
    }
    // The 4th within the 10s burst window is throttled even though the 6/min
    // window still has budget.
    const burst = await harness.authenticator.authenticate(
      buildRequest({ endpoint: "heartbeat", idempotencyKey: null, nonce: hex(3) }),
    );
    expect(burst.ok).toBe(false);
    if (!burst.ok) expect(burst.error.code).toBe("RATE_LIMITED");
  });

  it("enforces the per-IP rate limit across devices before authentication", async () => {
    const limited = new AgentApiAuthenticator({
      credentials: harness.credentials,
      secretVerifier: factory,
      nonces: harness.nonces,
      rateLimitStore: new InMemoryRateLimitStore(() => harness.clock.nowEpochMs()),
      clock: harness.clock,
      enforceHttps: false,
      ipRateLimit: { limit: 1, windowMs: 60_000 },
    });

    const first = await limited.authenticate(buildRequest({ nonce: hex(1), idempotencyKey: "k1" }));
    expect(first.ok).toBe(true);

    // A second request from the same IP is throttled even with a bad credential
    // (the IP guard runs before credential verification).
    const second = await limited.authenticate(
      buildRequest({ nonce: hex(2), secret: "w".repeat(43) }),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("RATE_LIMITED");
  });
});

/** A distinct, well-formed 32-char hex nonce for iteration `n`. */
function hex(n: number): string {
  return n.toString(16).padStart(32, "0");
}
