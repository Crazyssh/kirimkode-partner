import { describe, expect, it, vi } from "vitest";

import type { AgentApiAuthResult, AuthenticatedDevicePrincipal } from "./agent-api-authenticator";
import type { RecordHeartbeatOutcome } from "@application/heartbeat";
import {
  handleAgentHeartbeat,
  type AgentHeartbeatEndpointDeps,
} from "./agent-heartbeat-endpoint";

const PARTNER_ID = "00000000-0000-4000-8000-00000000000a";
const DEVICE_ID = "00000000-0000-4000-8000-0000000000d1";
const SERVER_NOW = new Date("2024-01-01T00:00:00.000Z");

function principal(over: Partial<AuthenticatedDevicePrincipal> = {}): AuthenticatedDevicePrincipal {
  return Object.freeze({
    partnerId: PARTNER_ID,
    deviceId: DEVICE_ID,
    credentialPublicId: "pub-1",
    endpoint: "heartbeat" as const,
    idempotencyKey: null,
    ...over,
  });
}

function okDeviceOutcome(): RecordHeartbeatOutcome {
  return {
    ok: true,
    device: {
      id: DEVICE_ID,
      partnerId: PARTNER_ID,
      type: "simulator",
      status: "online",
      lastSeenAtEpochMs: SERVER_NOW.getTime(),
      agentVersion: "1.2.3",
      capabilities: { sms: true, notification: false, resend: false, operator: false, slots: 1 },
    },
    recoveredNumberIds: ["num-1", "num-2"],
  };
}

/** A minimal Request stand-in: the handler only calls `.text()` + `.headers.get()`. */
function fakeRequest(rawBody: string, headers: Record<string, string> = {}): Request {
  return {
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    text: async () => rawBody,
  } as unknown as Request;
}

function makeDeps(over: Partial<AgentHeartbeatEndpointDeps> = {}): AgentHeartbeatEndpointDeps {
  return {
    authenticate: async (): Promise<AgentApiAuthResult> => ({ ok: true, principal: principal() }),
    recordHeartbeat: async (): Promise<RecordHeartbeatOutcome> => okDeviceOutcome(),
    now: () => SERVER_NOW,
    ...over,
  };
}

describe("handleAgentHeartbeat", () => {
  // Requirement 6.1: a valid heartbeat updates lastSeenAt/status and returns a
  // safe envelope carrying only the device's public liveness view.
  it("returns a 200 safe envelope on a successful heartbeat", async () => {
    const response = await handleAgentHeartbeat(
      fakeRequest(JSON.stringify({ metadata: { agentVersion: "1.2.3" } })),
      makeDeps(),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual({
      deviceId: DEVICE_ID,
      status: "online",
      lastSeenAt: SERVER_NOW.toISOString(),
      recoveredNumbers: 2,
    });
    expect(typeof body.requestId).toBe("string");
  });

  // Requirements 6.4 / 21.2-21.4: identity is taken from the authenticated
  // credential, never the body, and the receive time is server-authoritative.
  it("uses credential identity + server time, ignoring body-supplied identity", async () => {
    const recordHeartbeat =
      vi.fn<AgentHeartbeatEndpointDeps["recordHeartbeat"]>().mockResolvedValue(okDeviceOutcome());
    const body = JSON.stringify({
      partnerId: "11111111-1111-4111-8111-111111111111",
      deviceId: "22222222-2222-4222-8222-222222222222",
      receivedAtServer: "1999-01-01T00:00:00.000Z",
      metadata: { agentVersion: "9.9.9", signal: -50 },
      capabilities: { sms: true, slots: 4 },
    });

    await handleAgentHeartbeat(fakeRequest(body), makeDeps({ recordHeartbeat }));

    expect(recordHeartbeat).toHaveBeenCalledTimes(1);
    const passed = recordHeartbeat.mock.calls[0][0];
    // Identity is the authenticated principal, not the spoofed body values.
    expect(passed.partnerId).toBe(PARTNER_ID);
    expect(passed.deviceId).toBe(DEVICE_ID);
    // Time is the server clock, not the body.
    expect(passed.receivedAtServer).toBe(SERVER_NOW);
    // Metadata/capabilities are forwarded raw for the domain to validate.
    expect(passed.metadata).toEqual({ agentVersion: "9.9.9", signal: -50 });
    expect(passed.capabilities).toEqual({ sms: true, slots: 4 });
  });

  // A bare heartbeat (no body) is valid: metadata/capabilities are undefined.
  it("accepts an empty body as a bare heartbeat", async () => {
    const recordHeartbeat =
      vi.fn<AgentHeartbeatEndpointDeps["recordHeartbeat"]>().mockResolvedValue(okDeviceOutcome());

    const response = await handleAgentHeartbeat(fakeRequest(""), makeDeps({ recordHeartbeat }));

    expect(response.status).toBe(200);
    const passed = recordHeartbeat.mock.calls[0][0];
    expect(passed.metadata).toBeUndefined();
    expect(passed.capabilities).toBeUndefined();
  });

  it("rejects before mutation when authentication fails", async () => {
    const recordHeartbeat =
      vi.fn<AgentHeartbeatEndpointDeps["recordHeartbeat"]>().mockResolvedValue(okDeviceOutcome());
    const authenticate = async (): Promise<AgentApiAuthResult> => ({
      ok: false,
      error: { status: 401, code: "AUTHENTICATION_FAILED", message: "Authentication failed.", retryable: false },
    });

    const response = await handleAgentHeartbeat(
      fakeRequest(JSON.stringify({ metadata: {} })),
      makeDeps({ authenticate, recordHeartbeat }),
    );

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("AUTHENTICATION_FAILED");
    // No heartbeat command runs on an auth failure.
    expect(recordHeartbeat).not.toHaveBeenCalled();
  });

  it("returns a validation error for a malformed JSON body", async () => {
    const recordHeartbeat =
      vi.fn<AgentHeartbeatEndpointDeps["recordHeartbeat"]>().mockResolvedValue(okDeviceOutcome());

    const response = await handleAgentHeartbeat(
      fakeRequest("{ not json"),
      makeDeps({ recordHeartbeat }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(recordHeartbeat).not.toHaveBeenCalled();
  });

  it("returns a validation error for a non-object JSON body", async () => {
    const response = await handleAgentHeartbeat(
      fakeRequest(JSON.stringify([1, 2, 3])),
      makeDeps(),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("maps a not_found outcome to RESOURCE_NOT_FOUND", async () => {
    const response = await handleAgentHeartbeat(
      fakeRequest(""),
      makeDeps({ recordHeartbeat: async () => ({ ok: false, reason: "not_found" }) }),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("maps a disabled-device outcome to FORBIDDEN", async () => {
    const response = await handleAgentHeartbeat(
      fakeRequest(""),
      makeDeps({ recordHeartbeat: async () => ({ ok: false, reason: "device_disabled" }) }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
  });

  it("maps a validation outcome from the domain to VALIDATION_ERROR", async () => {
    const response = await handleAgentHeartbeat(
      fakeRequest(JSON.stringify({ metadata: { agentVersion: 123 } })),
      makeDeps({
        recordHeartbeat: async () => ({ ok: false, reason: "validation", code: "INVALID_HEARTBEAT" }),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("collapses an unexpected thrown error to a generic internal error", async () => {
    const response = await handleAgentHeartbeat(
      fakeRequest(""),
      makeDeps({
        recordHeartbeat: async () => {
          throw new Error("boom: secret leak");
        },
      }),
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("secret leak");
  });
});
