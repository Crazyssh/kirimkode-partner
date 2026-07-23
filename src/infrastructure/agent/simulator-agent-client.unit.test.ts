import { describe, expect, it } from "vitest";

import { parseAgentAuthorizationHeader } from "@domain/task-11-1/agent-api-auth";
import { SimulatorClientError, type SimulatorDeviceCredential } from "@domain/task-11-4/simulator-client";

import {
  SimulatorAgentClient,
  type AgentHttpRequest,
  type AgentHttpResponse,
  type AgentHttpTransport,
  type SimulatorClock,
  type SimulatorEntropy,
} from "./simulator-agent-client";

const credential: SimulatorDeviceCredential = {
  publicId: "cHVibGljLWlkLTAxMjM0NTY3OA",
  secret: "s".repeat(43),
};

class RecordingTransport implements AgentHttpTransport {
  readonly requests: AgentHttpRequest[] = [];
  constructor(private readonly response: AgentHttpResponse) {}

  async send(request: AgentHttpRequest): Promise<AgentHttpResponse> {
    this.requests.push(request);
    return this.response;
  }
}

class FixedClock implements SimulatorClock {
  constructor(private readonly ms: number) {}
  nowEpochMs(): number {
    return this.ms;
  }
}

class ScriptedEntropy implements SimulatorEntropy {
  private nonceCount = 0;
  private keyCount = 0;
  nonce(): string {
    this.nonceCount += 1;
    // A deterministic yet valid 128-bit hex nonce.
    return this.nonceCount.toString(16).padStart(32, "0");
  }
  idempotencyKey(): string {
    this.keyCount += 1;
    return `key-${this.keyCount}`;
  }
}

function makeClient(overrides: {
  transport: AgentHttpTransport;
  environment?: string;
  partnerSimulatorAllowed?: boolean;
}): SimulatorAgentClient {
  return SimulatorAgentClient.create({
    environment: overrides.environment ?? "development",
    partnerSimulatorAllowed: overrides.partnerSimulatorAllowed ?? false,
    baseUrl: "https://partner-api.example.com/",
    credential,
    transport: overrides.transport,
    clock: new FixedClock(1_700_000_000_000),
    entropy: new ScriptedEntropy(),
  });
}

// **Validates: Requirements 17.1, 17.3**
describe("SimulatorAgentClient.create", () => {
  it("refuses creation in production without simulatorAllowed", () => {
    expect(() =>
      SimulatorAgentClient.create({
        environment: "production",
        partnerSimulatorAllowed: false,
        baseUrl: "https://partner-api.example.com",
        credential,
      }),
    ).toThrowError(SimulatorClientError);
  });

  it("allows creation for an allowlisted production partner", () => {
    const client = SimulatorAgentClient.create({
      environment: "production",
      partnerSimulatorAllowed: true,
      baseUrl: "https://partner-api.example.com",
      credential,
    });
    expect(client).toBeInstanceOf(SimulatorAgentClient);
  });
});

// **Validates: Requirements 17.2, 21.1**
describe("SimulatorAgentClient requests", () => {
  it("sends an authenticated heartbeat to the shared endpoint", async () => {
    const transport = new RecordingTransport({ status: 200, body: '{"data":{"status":"online"}}' });
    const client = makeClient({ transport });

    const result = await client.heartbeat({ metadata: { agentVersion: "sim-1" } });

    expect(result).toEqual({ status: 200, data: { data: { status: "online" } } });
    const [request] = transport.requests;
    expect(request.url).toBe("https://partner-api.example.com/api/agent/v1/heartbeat");
    expect(parseAgentAuthorizationHeader(request.headers.authorization)).toEqual({
      publicId: credential.publicId,
      secret: credential.secret,
    });
    expect(request.headers["x-agent-timestamp"]).toBe("1700000000");
    expect(request.headers["idempotency-key"]).toBeUndefined();
  });

  it("attaches an idempotency key to number registration", async () => {
    const transport = new RecordingTransport({ status: 201, body: '{"data":{"id":"num-1"}}' });
    const client = makeClient({ transport });

    await client.registerNumber({ number: "081234567890" });

    const [request] = transport.requests;
    expect(request.url).toBe("https://partner-api.example.com/api/agent/v1/numbers/register");
    expect(request.headers["idempotency-key"]).toBe("key-1");
    expect(JSON.parse(request.body)).toEqual({ number: "+6281234567890" });
  });

  it("sends availability changes and SMS through the same Agent API", async () => {
    const transport = new RecordingTransport({ status: 200, body: "{}" });
    const client = makeClient({ transport });

    await client.setAvailability("num-1", "available");
    await client.submitSms({
      messageId: "msg-1",
      number: "+6281234567890",
      sender: "WhatsApp",
      receivedAt: "2024-01-01T00:00:00.000Z",
      body: "code 123456",
    });

    expect(transport.requests.map((r) => r.url)).toEqual([
      "https://partner-api.example.com/api/agent/v1/numbers/num-1/availability",
      "https://partner-api.example.com/api/agent/v1/sms",
    ]);
    // Each mutation gets a fresh idempotency key and nonce.
    expect(transport.requests[0].headers["idempotency-key"]).toBe("key-1");
    expect(transport.requests[1].headers["idempotency-key"]).toBe("key-2");
    expect(transport.requests[0].headers["x-agent-nonce"]).not.toBe(
      transport.requests[1].headers["x-agent-nonce"],
    );
  });
});
