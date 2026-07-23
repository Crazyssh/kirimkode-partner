import { describe, expect, it, vi } from "vitest";

import type { AgentApiAuthResult, AuthenticatedDevicePrincipal } from "./agent-api-authenticator";
import {
  SmsDependencyUnavailableError,
  SmsOwnershipMismatchError,
  SmsSuccessContentionError,
  type SafePartnerSmsView,
  type SmsIngestionResult,
} from "@application/sms";
import {
  AGENT_SMS_MAX_BODY_BYTES,
  handleAgentSms,
  type AgentSmsEndpointDeps,
} from "./agent-sms-endpoint";

const PARTNER_ID = "00000000-0000-4000-8000-00000000000a";
const DEVICE_ID = "00000000-0000-4000-8000-0000000000d1";
const NUMBER_ID = "00000000-0000-4000-8000-0000000000e5";
const SMS_ID = "00000000-0000-4000-8000-0000000000f9";
const ORDER_ID = "00000000-0000-4000-8000-000000000abc";
const IDEM_KEY = "idem-key-1";

const RECEIVED_AT_DEVICE_MS = Date.parse("2024-01-01T00:00:00.000Z");
const RECEIVED_AT_SERVER_MS = Date.parse("2024-01-01T00:00:01.000Z");

function principal(over: Partial<AuthenticatedDevicePrincipal> = {}): AuthenticatedDevicePrincipal {
  return Object.freeze({
    partnerId: PARTNER_ID,
    deviceId: DEVICE_ID,
    credentialPublicId: "pub-1",
    endpoint: "sms" as const,
    idempotencyKey: IDEM_KEY,
    ...over,
  });
}

function safeView(over: Partial<SafePartnerSmsView> = {}): SafePartnerSmsView {
  return Object.freeze({
    id: SMS_ID,
    deviceId: DEVICE_ID,
    numberId: NUMBER_ID,
    messageId: "msg-1",
    keyVersion: 1,
    bodyFingerprint: "f".repeat(64),
    matchStatus: "matched",
    matchedOrderId: ORDER_ID,
    receivedAtDeviceEpochMs: RECEIVED_AT_DEVICE_MS,
    receivedAtServerEpochMs: RECEIVED_AT_SERVER_MS,
    extractedAtEpochMs: RECEIVED_AT_SERVER_MS,
    redactedAtEpochMs: null,
    ...over,
  });
}

function matchedResult(): SmsIngestionResult {
  return Object.freeze({ status: "matched", sms: safeView(), orderId: ORDER_ID });
}

/** A minimal Request stand-in: the handler calls `.text()` and `.headers.get()`. */
function fakeRequest(
  rawBody: string,
  over: { headers?: Record<string, string>; url?: string; method?: string } = {},
): Request {
  const headers = over.headers ?? {};
  return {
    method: over.method ?? "POST",
    url: over.url ?? "https://partner.example.com/api/agent/v1/sms",
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    text: async () => rawBody,
  } as unknown as Request;
}

function validBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    numberId: NUMBER_ID,
    messageId: "msg-1",
    sender: "+6289911223344",
    receivedAt: "2024-01-01T00:00:00.000Z",
    body: "Your code is 123456",
    ...over,
  });
}

function makeDeps(over: Partial<AgentSmsEndpointDeps> = {}): AgentSmsEndpointDeps {
  return {
    authenticate: async (): Promise<AgentApiAuthResult> => ({ ok: true, principal: principal() }),
    ingest: async () => matchedResult(),
    ...over,
  };
}

describe("handleAgentSms", () => {
  // Requirements 11.1, 11.2, 18.5: a valid SMS is ingested; identity comes from
  // the credential, and a redaction-safe envelope carrying no raw text/OTP is
  // returned.
  it("ingests a valid SMS and returns a redaction-safe matched envelope", async () => {
    const ingest = vi.fn<AgentSmsEndpointDeps["ingest"]>().mockResolvedValue(matchedResult());

    const response = await handleAgentSms(
      fakeRequest(
        validBody({
          // Spoofed identity in the body must be ignored.
          partnerId: "11111111-1111-4111-8111-111111111111",
          deviceId: "22222222-2222-4222-8222-222222222222",
        }),
        { headers: { "idempotency-key": IDEM_KEY } },
      ),
      makeDeps({ ingest }),
    );

    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.data.status).toBe("matched");
    expect(json.data.orderId).toBe(ORDER_ID);
    expect(json.data.sms.id).toBe(SMS_ID);
    expect(json.data.sms.numberId).toBe(NUMBER_ID);
    expect(json.data.sms.receivedAtServer).toBe("2024-01-01T00:00:01.000Z");
    expect(typeof json.requestId).toBe("string");

    // No ciphertext / raw body / OTP is ever present in the response.
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("123456");
    expect(serialized).not.toContain("ciphertext");

    // Identity is taken from the credential, never the body.
    expect(ingest).toHaveBeenCalledTimes(1);
    const passed = ingest.mock.calls[0][0];
    expect(passed.principal).toEqual({ partnerId: PARTNER_ID, deviceId: DEVICE_ID });
    expect(passed.numberId).toBe(NUMBER_ID);
    expect(passed.messageId).toBe("msg-1");
    expect(passed.idempotencyKey).toBe(IDEM_KEY);
    expect(passed.sender).toBe("+6289911223344");
    expect(passed.body).toBe("Your code is 123456");
    expect(passed.receivedAtDeviceEpochMs).toBe(RECEIVED_AT_DEVICE_MS);
  });

  it("accepts the design's `number` label as the number identifier", async () => {
    const ingest = vi.fn<AgentSmsEndpointDeps["ingest"]>().mockResolvedValue(matchedResult());

    await handleAgentSms(
      fakeRequest(validBody({ numberId: undefined, number: NUMBER_ID })),
      makeDeps({ ingest }),
    );

    expect(ingest.mock.calls[0][0].numberId).toBe(NUMBER_ID);
  });

  it("accepts a numeric epoch-ms receivedAt", async () => {
    const ingest = vi.fn<AgentSmsEndpointDeps["ingest"]>().mockResolvedValue(matchedResult());

    await handleAgentSms(
      fakeRequest(validBody({ receivedAt: RECEIVED_AT_DEVICE_MS })),
      makeDeps({ ingest }),
    );

    expect(ingest.mock.calls[0][0].receivedAtDeviceEpochMs).toBe(RECEIVED_AT_DEVICE_MS);
  });

  // Requirement 11.3: an idempotent replay short-circuits to `duplicate` (200)
  // without creating a second row.
  it("returns 200 for a duplicate replay", async () => {
    const response = await handleAgentSms(
      fakeRequest(validBody()),
      makeDeps({
        ingest: async () => Object.freeze({ status: "duplicate", matchedBy: "message_id" }),
      }),
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.status).toBe("duplicate");
    expect(json.data.matchedBy).toBe("message_id");
  });

  // Requirement 11.5: an ambiguous/unmatched SMS is stored for audit, no OTP.
  it("returns 201 with candidate order ids for an ambiguous result", async () => {
    const response = await handleAgentSms(
      fakeRequest(validBody()),
      makeDeps({
        ingest: async () =>
          Object.freeze({
            status: "ambiguous",
            sms: safeView({ matchStatus: "ambiguous", matchedOrderId: null, extractedAtEpochMs: null }),
            candidateOrderIds: [ORDER_ID, "00000000-0000-4000-8000-000000000def"],
          }),
      }),
    );

    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.data.status).toBe("ambiguous");
    expect(json.data.candidateOrderIds).toHaveLength(2);
    expect(json.data.sms.matchedOrderId).toBeNull();
  });

  it("returns 201 with the reason for an unmatched result", async () => {
    const response = await handleAgentSms(
      fakeRequest(validBody()),
      makeDeps({
        ingest: async () =>
          Object.freeze({
            status: "unmatched",
            sms: safeView({ matchStatus: "unmatched", matchedOrderId: null, extractedAtEpochMs: null }),
            reason: "no_active_order",
          }),
      }),
    );

    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.data.status).toBe("unmatched");
    expect(json.data.reason).toBe("no_active_order");
  });

  // Requirement 18.5: reject before any mutation when authentication fails.
  it("rejects before mutation when authentication fails", async () => {
    const ingest = vi.fn<AgentSmsEndpointDeps["ingest"]>().mockResolvedValue(matchedResult());
    const authenticate = async (): Promise<AgentApiAuthResult> => ({
      ok: false,
      error: { status: 401, code: "AUTHENTICATION_FAILED", message: "Authentication failed.", retryable: false },
    });

    const response = await handleAgentSms(
      fakeRequest(validBody()),
      makeDeps({ authenticate, ingest }),
    );

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("AUTHENTICATION_FAILED");
    expect(ingest).not.toHaveBeenCalled();
  });

  // Requirement 18.6: server-side validation of every input before mutation.
  it("returns a validation error for malformed / incomplete bodies", async () => {
    const ingest = vi.fn<AgentSmsEndpointDeps["ingest"]>().mockResolvedValue(matchedResult());

    const invalidBodies = [
      "{ not json",
      JSON.stringify([1, 2]),
      "",
      validBody({ numberId: undefined, number: undefined }),
      validBody({ messageId: "" }),
      validBody({ sender: 123 }),
      validBody({ body: 42 }),
      validBody({ receivedAt: "not-a-date" }),
      validBody({ receivedAt: undefined }),
      validBody({ receivedAt: -1 }),
    ];

    for (const raw of invalidBodies) {
      const response = await handleAgentSms(fakeRequest(raw), makeDeps({ ingest }));
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    }
    expect(ingest).not.toHaveBeenCalled();
  });

  // Requirement 18.6: body over 4 KiB is refused server-side before mutation.
  it("rejects a body larger than 4 KiB before mutation", async () => {
    const ingest = vi.fn<AgentSmsEndpointDeps["ingest"]>().mockResolvedValue(matchedResult());
    const oversized = "a".repeat(AGENT_SMS_MAX_BODY_BYTES + 1);

    const response = await handleAgentSms(
      fakeRequest(validBody({ body: oversized })),
      makeDeps({ ingest }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    expect(ingest).not.toHaveBeenCalled();

    // A body at exactly the limit is accepted.
    const atLimit = "a".repeat(AGENT_SMS_MAX_BODY_BYTES);
    const okResponse = await handleAgentSms(
      fakeRequest(validBody({ body: atLimit })),
      makeDeps({ ingest }),
    );
    expect(okResponse.status).toBe(201);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  // Requirement 11.1: an ownership violation is opaque (RESOURCE_NOT_FOUND) so
  // a caller cannot probe another tenant's inventory.
  it("maps an ownership mismatch to an opaque RESOURCE_NOT_FOUND", async () => {
    const response = await handleAgentSms(
      fakeRequest(validBody()),
      makeDeps({
        ingest: async () => {
          throw new SmsOwnershipMismatchError();
        },
      }),
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("maps a success contention to a retryable STATE_CONFLICT", async () => {
    const response = await handleAgentSms(
      fakeRequest(validBody()),
      makeDeps({
        ingest: async () => {
          throw new SmsSuccessContentionError();
        },
      }),
    );

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.error.code).toBe("STATE_CONFLICT");
    expect(json.error.retryable).toBe(true);
  });

  it("maps a missing dependency to a retryable DEPENDENCY_UNAVAILABLE", async () => {
    const response = await handleAgentSms(
      fakeRequest(validBody()),
      makeDeps({
        ingest: async () => {
          throw new SmsDependencyUnavailableError();
        },
      }),
    );

    expect(response.status).toBe(503);
    const json = await response.json();
    expect(json.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(json.error.retryable).toBe(true);
  });

  it("collapses an unexpected thrown error to a generic internal error", async () => {
    const response = await handleAgentSms(
      fakeRequest(validBody()),
      makeDeps({
        ingest: async () => {
          throw new Error("boom: raw otp 123456 leak");
        },
      }),
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(json)).not.toContain("123456");
  });
});
