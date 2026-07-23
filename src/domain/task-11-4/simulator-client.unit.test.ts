import { describe, expect, it } from "vitest";

import { parseAgentAuthorizationHeader } from "@domain/task-11-1/agent-api-auth";

import {
  AGENT_API_BASE_PATH,
  SIMULATOR_SMS_MAX_BODY_BYTES,
  SimulatorClientError,
  assertSimulatorCreationAllowed,
  buildHeartbeatRequest,
  buildRegisterNumberRequest,
  buildSetAvailabilityRequest,
  buildSubmitSmsRequest,
  decideSimulatorClientCreation,
  type SimulatorDeviceCredential,
  type SimulatorReplayContext,
} from "./simulator-client";

const credential: SimulatorDeviceCredential = {
  publicId: "cHVibGljLWlkLTAxMjM0NTY3OA",
  secret: "s".repeat(43),
};

const nonce = "0123456789abcdef0123456789abcdef";

const replay: SimulatorReplayContext = {
  timestampSeconds: 1_700_000_000,
  nonce,
};

const mutationReplay: SimulatorReplayContext = {
  ...replay,
  idempotencyKey: "op-register-1",
};

// **Validates: Requirements 17.1, 17.3**
describe("simulator creation policy", () => {
  it("allows creation outside production", () => {
    const decision = decideSimulatorClientCreation({
      environment: "development",
      partnerSimulatorAllowed: false,
    });
    expect(decision.allowed).toBe(true);
  });

  it("allows a production partner that is explicitly allowlisted", () => {
    const decision = assertSimulatorCreationAllowed({
      environment: "production",
      partnerSimulatorAllowed: true,
    });
    expect(decision.reason).toBe("partner_simulator_allowed");
  });

  it("rejects a production partner without simulatorAllowed", () => {
    expect(() =>
      assertSimulatorCreationAllowed({
        environment: "production",
        partnerSimulatorAllowed: false,
      }),
    ).toThrowError(SimulatorClientError);
  });
});

// **Validates: Requirements 17.2, 21.1**
describe("buildHeartbeatRequest", () => {
  it("targets the shared heartbeat endpoint with a Device credential and no idempotency key", () => {
    const spec = buildHeartbeatRequest(credential, replay, {
      metadata: { agentVersion: "sim-1.0.0" },
    });

    expect(spec.method).toBe("POST");
    expect(spec.path).toBe(`${AGENT_API_BASE_PATH}/heartbeat`);
    expect(parseAgentAuthorizationHeader(spec.headers.authorization)).toEqual({
      publicId: credential.publicId,
      secret: credential.secret,
    });
    expect(spec.headers["x-agent-timestamp"]).toBe("1700000000");
    expect(spec.headers["x-agent-nonce"]).toBe(nonce);
    expect(spec.headers["idempotency-key"]).toBeUndefined();
    expect(JSON.parse(spec.body)).toEqual({ metadata: { agentVersion: "sim-1.0.0" } });
  });

  it("rejects a malformed credential before it reaches the wire", () => {
    expect(() =>
      buildHeartbeatRequest({ publicId: "bad id!", secret: credential.secret }, replay),
    ).toThrowError(SimulatorClientError);
  });

  it("rejects a non-128-bit nonce", () => {
    expect(() =>
      buildHeartbeatRequest(credential, { ...replay, nonce: "too-short" }),
    ).toThrowError(SimulatorClientError);
  });

  it("rejects a negative or non-integer timestamp", () => {
    expect(() =>
      buildHeartbeatRequest(credential, { ...replay, timestampSeconds: -1 }),
    ).toThrowError(SimulatorClientError);
  });
});

// **Validates: Requirements 17.2, 18.4, 21.1**
describe("buildRegisterNumberRequest", () => {
  it("canonicalises a +62 number and requires an idempotency key", () => {
    const spec = buildRegisterNumberRequest(credential, mutationReplay, {
      number: "0812-3456-7890",
      operator: "any",
    });

    expect(spec.path).toBe(`${AGENT_API_BASE_PATH}/numbers/register`);
    expect(spec.headers["idempotency-key"]).toBe("op-register-1");
    expect(JSON.parse(spec.body)).toEqual({ number: "+6281234567890", operator: "any" });
  });

  it("rejects a register mutation without an idempotency key", () => {
    expect(() =>
      buildRegisterNumberRequest(credential, replay, { number: "+6281234567890" }),
    ).toThrowError(SimulatorClientError);
  });

  it("rejects an invalid Indonesian number", () => {
    expect(() =>
      buildRegisterNumberRequest(credential, mutationReplay, { number: "+15551234567" }),
    ).toThrow();
  });
});

// **Validates: Requirements 7.3, 17.2**
describe("buildSetAvailabilityRequest", () => {
  it("builds the availability path with the requested state", () => {
    const spec = buildSetAvailabilityRequest(credential, "num-123", mutationReplay, "available");

    expect(spec.path).toBe(`${AGENT_API_BASE_PATH}/numbers/num-123/availability`);
    expect(JSON.parse(spec.body)).toEqual({ requested: "available" });
    expect(spec.headers["idempotency-key"]).toBe("op-register-1");
  });

  it("rejects an empty number id", () => {
    expect(() =>
      buildSetAvailabilityRequest(credential, "  ", mutationReplay, "offline"),
    ).toThrowError(SimulatorClientError);
  });
});

// **Validates: Requirements 11.3, 17.2**
describe("buildSubmitSmsRequest", () => {
  const sms = {
    messageId: "msg-1",
    number: "+6281234567890",
    sender: "WhatsApp",
    receivedAt: "2024-01-01T00:00:00.000Z",
    body: "Your WhatsApp code is 123-456",
  };

  it("targets the shared SMS endpoint and requires an idempotency key", () => {
    const spec = buildSubmitSmsRequest(credential, mutationReplay, sms);

    expect(spec.path).toBe(`${AGENT_API_BASE_PATH}/sms`);
    expect(spec.headers["idempotency-key"]).toBe("op-register-1");
    expect(JSON.parse(spec.body)).toEqual(sms);
  });

  it("rejects an SMS body larger than the 4 KiB limit", () => {
    expect(() =>
      buildSubmitSmsRequest(credential, mutationReplay, {
        ...sms,
        body: "x".repeat(SIMULATOR_SMS_MAX_BODY_BYTES + 1),
      }),
    ).toThrowError(SimulatorClientError);
  });

  it("rejects a missing required field", () => {
    expect(() =>
      buildSubmitSmsRequest(credential, mutationReplay, { ...sms, messageId: "" }),
    ).toThrowError(SimulatorClientError);
  });
});
