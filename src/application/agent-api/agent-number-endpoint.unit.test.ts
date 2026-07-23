import { describe, expect, it, vi } from "vitest";

import type { AgentApiAuthResult, AuthenticatedDevicePrincipal } from "./agent-api-authenticator";
import type { AgentNumberResult } from "@application/numbers";
import {
  handleAgentNumberAvailability,
  handleAgentNumberRegister,
  type AgentNumberEndpointDeps,
} from "./agent-number-endpoint";

const PARTNER_ID = "00000000-0000-4000-8000-00000000000a";
const DEVICE_ID = "00000000-0000-4000-8000-0000000000d1";
const NUMBER_ID = "00000000-0000-4000-8000-0000000000e5";

function principal(over: Partial<AuthenticatedDevicePrincipal> = {}): AuthenticatedDevicePrincipal {
  return Object.freeze({
    partnerId: PARTNER_ID,
    deviceId: DEVICE_ID,
    credentialPublicId: "pub-1",
    endpoint: "number-mutation" as const,
    idempotencyKey: "idem-key-1",
    ...over,
  });
}

function okRegisterResult(): AgentNumberResult {
  return {
    statusCode: 201,
    body: {
      data: {
        id: NUMBER_ID,
        deviceId: DEVICE_ID,
        canonicalNumber: "+6281234567890",
        countryCode: "ID",
        operatorCode: "any",
        status: "offline",
        enabled: true,
      },
    },
  };
}

function okAvailabilityResult(): AgentNumberResult {
  return {
    statusCode: 200,
    body: {
      data: {
        id: NUMBER_ID,
        deviceId: DEVICE_ID,
        canonicalNumber: "+6281234567890",
        countryCode: "ID",
        operatorCode: "any",
        status: "offline",
        enabled: true,
        requested: "available",
      },
    },
  };
}

/** A minimal Request stand-in: handlers call `.text()`, `.headers.get()`, `.url`, `.method`. */
function fakeRequest(
  rawBody: string,
  over: { headers?: Record<string, string>; url?: string; method?: string } = {},
): Request {
  const headers = over.headers ?? {};
  return {
    method: over.method ?? "POST",
    url: over.url ?? "https://partner.example.com/api/agent/v1/numbers/register",
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    text: async () => rawBody,
  } as unknown as Request;
}

function makeDeps(over: Partial<AgentNumberEndpointDeps> = {}): AgentNumberEndpointDeps {
  return {
    authenticate: async (): Promise<AgentApiAuthResult> => ({ ok: true, principal: principal() }),
    registerNumber: async () => okRegisterResult(),
    setAvailability: async () => okAvailabilityResult(),
    ...over,
  };
}

describe("handleAgentNumberRegister", () => {
  // Requirement 7.1: a valid registration returns a 201 safe envelope carrying
  // the created number, and identity is taken from the credential, not the body.
  it("returns a 201 envelope and passes credential identity + parsed body", async () => {
    const registerNumber =
      vi.fn<AgentNumberEndpointDeps["registerNumber"]>().mockResolvedValue(okRegisterResult());
    const body = JSON.stringify({
      number: "0812-3456-7890",
      operator: "tsel",
      // Spoofed identity in the body must be ignored.
      partnerId: "11111111-1111-4111-8111-111111111111",
      deviceId: "22222222-2222-4222-8222-222222222222",
    });

    const response = await handleAgentNumberRegister(
      fakeRequest(body, { headers: { "idempotency-key": "idem-key-1" } }),
      makeDeps({ registerNumber }),
    );

    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.data.id).toBe(NUMBER_ID);
    expect(typeof json.requestId).toBe("string");

    expect(registerNumber).toHaveBeenCalledTimes(1);
    const passed = registerNumber.mock.calls[0][0];
    expect(passed.partnerId).toBe(PARTNER_ID);
    expect(passed.deviceId).toBe(DEVICE_ID);
    expect(passed.idempotencyKey).toBe("idem-key-1");
    expect(passed.rawNumber).toBe("0812-3456-7890");
    expect(passed.operatorCode).toBe("tsel");
    expect(passed.method).toBe("POST");
    expect(passed.path).toBe("/api/agent/v1/numbers/register");
  });

  it("omits operatorCode when the body has none", async () => {
    const registerNumber =
      vi.fn<AgentNumberEndpointDeps["registerNumber"]>().mockResolvedValue(okRegisterResult());

    await handleAgentNumberRegister(
      fakeRequest(JSON.stringify({ number: "+6281234567890" })),
      makeDeps({ registerNumber }),
    );

    expect(registerNumber.mock.calls[0][0].operatorCode).toBeUndefined();
  });

  it("rejects before mutation when authentication fails", async () => {
    const registerNumber =
      vi.fn<AgentNumberEndpointDeps["registerNumber"]>().mockResolvedValue(okRegisterResult());
    const authenticate = async (): Promise<AgentApiAuthResult> => ({
      ok: false,
      error: { status: 401, code: "AUTHENTICATION_FAILED", message: "Authentication failed.", retryable: false },
    });

    const response = await handleAgentNumberRegister(
      fakeRequest(JSON.stringify({ number: "+6281234567890" })),
      makeDeps({ authenticate, registerNumber }),
    );

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("AUTHENTICATION_FAILED");
    expect(registerNumber).not.toHaveBeenCalled();
  });

  it("returns a validation error for a malformed / non-object / missing-number body", async () => {
    const registerNumber =
      vi.fn<AgentNumberEndpointDeps["registerNumber"]>().mockResolvedValue(okRegisterResult());

    for (const raw of ["{ not json", JSON.stringify([1, 2]), JSON.stringify({ operator: "tsel" }), ""]) {
      const response = await handleAgentNumberRegister(
        fakeRequest(raw),
        makeDeps({ registerNumber }),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    }
    expect(registerNumber).not.toHaveBeenCalled();
  });

  it("collapses an unexpected thrown error to a generic internal error", async () => {
    const response = await handleAgentNumberRegister(
      fakeRequest(JSON.stringify({ number: "+6281234567890" })),
      makeDeps({
        registerNumber: async () => {
          throw new Error("boom: secret leak");
        },
      }),
    );
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(json)).not.toContain("secret leak");
  });
});

describe("handleAgentNumberAvailability", () => {
  const AVAIL_URL = `https://partner.example.com/api/agent/v1/numbers/${NUMBER_ID}/availability`;

  // Requirement 7.3 / 18.5: the requested availability + number id are forwarded
  // to the shared command, which resolves the effective state.
  it("returns a 200 envelope and forwards the route id + requested availability", async () => {
    const setAvailability =
      vi.fn<AgentNumberEndpointDeps["setAvailability"]>().mockResolvedValue(okAvailabilityResult());

    const response = await handleAgentNumberAvailability(
      fakeRequest(JSON.stringify({ requested: "available" }), { url: AVAIL_URL }),
      NUMBER_ID,
      makeDeps({ setAvailability }),
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.requested).toBe("available");

    const passed = setAvailability.mock.calls[0][0];
    expect(passed.numberId).toBe(NUMBER_ID);
    expect(passed.requested).toBe("available");
    expect(passed.partnerId).toBe(PARTNER_ID);
    expect(passed.deviceId).toBe(DEVICE_ID);
    expect(passed.path).toBe(`/api/agent/v1/numbers/${NUMBER_ID}/availability`);
  });

  it("rejects an unknown requested value with VALIDATION_ERROR", async () => {
    const setAvailability =
      vi.fn<AgentNumberEndpointDeps["setAvailability"]>().mockResolvedValue(okAvailabilityResult());

    const response = await handleAgentNumberAvailability(
      fakeRequest(JSON.stringify({ requested: "busy" }), { url: AVAIL_URL }),
      NUMBER_ID,
      makeDeps({ setAvailability }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    expect(setAvailability).not.toHaveBeenCalled();
  });

  it("rejects before mutation when authentication fails", async () => {
    const setAvailability =
      vi.fn<AgentNumberEndpointDeps["setAvailability"]>().mockResolvedValue(okAvailabilityResult());
    const authenticate = async (): Promise<AgentApiAuthResult> => ({
      ok: false,
      error: { status: 403, code: "FORBIDDEN", message: "Operation is not permitted.", retryable: false },
    });

    const response = await handleAgentNumberAvailability(
      fakeRequest(JSON.stringify({ requested: "offline" }), { url: AVAIL_URL }),
      NUMBER_ID,
      makeDeps({ authenticate, setAvailability }),
    );

    expect(response.status).toBe(403);
    expect(setAvailability).not.toHaveBeenCalled();
  });
});
