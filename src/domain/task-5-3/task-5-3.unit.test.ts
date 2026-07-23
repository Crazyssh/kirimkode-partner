import { describe, expect, it } from "vitest";

import { canonicalizeJson, hashCanonicalRequest } from "./canonical-request-hash";
import { decideIdempotency } from "./idempotency";
import { decidePlutoPolicy } from "./private-beta-policy";
import { validateReplayProtection } from "./replay-policy";
import { createSafeMetadata, REDACTED, redactText } from "./redaction";
import { type DomainErrorKind, mapDomainError } from "./safe-errors";

const request = {
  scope: "internal.reserve",
  principalId: "main-platform",
  idempotencyKey: "reserve-123",
  method: "post",
  path: "/api/internal/v1/orders/reserve",
  payload: { buyerOrderRef: "buyer-1", filter: { service: "wa", country: "ID" } },
} as const;

// **Validates: Requirements 9.6, 10.3, 10.4, 10.5, 20.5**
describe("canonical payload-bound idempotency", () => {
  it("canonicalizes equivalent JSON objects independent of key insertion order", async () => {
    const first = await hashCanonicalRequest(request);
    const second = await hashCanonicalRequest({
      ...request,
      method: "POST",
      payload: { filter: { country: "ID", service: "wa" }, buyerOrderRef: "buyer-1" },
    });
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds the digest to payload and request identity", async () => {
    const original = await hashCanonicalRequest(request);
    await expect(hashCanonicalRequest({ ...request, payload: { ...request.payload, buyerOrderRef: "buyer-2" } }))
      .resolves.not.toBe(original);
    await expect(hashCanonicalRequest({ ...request, principalId: "other-client" })).resolves.not.toBe(original);
    await expect(hashCanonicalRequest({ ...request, path: "/api/internal/v1/orders/other" })).resolves.not.toBe(original);
  });

  it("rejects values that cannot be represented safely as JSON", () => {
    expect(() => canonicalizeJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalizeJson(Number.NaN)).toThrow(TypeError);
  });

  it("requires a key before any effect can execute", () => {
    expect(decideIdempotency({
      scope: request.scope,
      principalId: request.principalId,
      key: " ",
      requestHash: "hash-a",
    })).toEqual({ kind: "reject", mayApplyEffect: false, code: "IDEMPOTENCY_REQUIRED" });
  });

  it("replays the first stored response for an identical request", () => {
    const response = { partnerOrderId: "order-1", status: "waiting_sms" } as const;
    expect(decideIdempotency({
      scope: request.scope,
      principalId: request.principalId,
      key: request.idempotencyKey,
      requestHash: "hash-a",
      stored: {
        scope: request.scope,
        principalId: request.principalId,
        key: request.idempotencyKey,
        requestHash: "hash-a",
        statusCode: 201,
        response,
      },
    })).toEqual({ kind: "replay", mayApplyEffect: false, statusCode: 201, response });
  });

  it("rejects the same key with a different request hash without an effect", () => {
    const decision = decideIdempotency({
      scope: request.scope,
      principalId: request.principalId,
      key: request.idempotencyKey,
      requestHash: "hash-b",
      stored: {
        scope: request.scope,
        principalId: request.principalId,
        key: request.idempotencyKey,
        requestHash: "hash-a",
        statusCode: 201,
        response: { partnerOrderId: "order-1" },
      },
    });
    expect(decision).toEqual({ kind: "reject", mayApplyEffect: false, code: "IDEMPOTENCY_CONFLICT" });
  });
});

const validReplayInput = {
  principalId: "device-1",
  timestampSeconds: 1_800_000_000,
  nonce: "0123456789abcdef0123456789abcdef",
  nowSeconds: 1_800_000_000,
  credentialValid: true,
  signatureValid: true,
  ownershipValid: true,
  nonceAlreadyUsed: false,
} as const;

// **Validates: Requirements 18.4, 18.5**
describe("timestamp and nonce replay policy", () => {
  it("accepts authenticated unique requests at both skew boundaries", () => {
    expect(validateReplayProtection({ ...validReplayInput, timestampSeconds: validReplayInput.nowSeconds - 300 }))
      .toEqual({ kind: "accept", mayMutate: true, nonceExpiresAtSeconds: validReplayInput.nowSeconds + 600 });
    expect(validateReplayProtection({ ...validReplayInput, timestampSeconds: validReplayInput.nowSeconds + 300 }).kind)
      .toBe("accept");
  });

  it("rejects stale, future, duplicate, and malformed nonce requests before mutation", () => {
    for (const candidate of [
      { ...validReplayInput, timestampSeconds: validReplayInput.nowSeconds - 301 },
      { ...validReplayInput, timestampSeconds: validReplayInput.nowSeconds + 301 },
      { ...validReplayInput, nonceAlreadyUsed: true },
      { ...validReplayInput, nonce: "too-short" },
    ]) {
      expect(validateReplayProtection(candidate)).toEqual({
        kind: "reject",
        mayMutate: false,
        code: "REPLAY_REJECTED",
      });
    }
  });

  it("fails authentication and ownership checks before replay acceptance", () => {
    for (const candidate of [
      { ...validReplayInput, credentialValid: false },
      { ...validReplayInput, signatureValid: false },
      { ...validReplayInput, ownershipValid: false },
    ]) {
      expect(validateReplayProtection(candidate)).toEqual({
        kind: "reject",
        mayMutate: false,
        code: "AUTHENTICATION_FAILED",
      });
    }
  });
});

const expectedErrors: ReadonlyArray<readonly [DomainErrorKind, number, string, boolean]> = [
  ["validation", 400, "VALIDATION_ERROR", false],
  ["authentication", 401, "AUTHENTICATION_FAILED", false],
  ["replay", 401, "REPLAY_REJECTED", false],
  ["forbidden", 403, "FORBIDDEN", false],
  ["not_found", 404, "RESOURCE_NOT_FOUND", false],
  ["idempotency_required", 400, "IDEMPOTENCY_REQUIRED", false],
  ["idempotency_conflict", 409, "IDEMPOTENCY_CONFLICT", false],
  ["terminal_state_conflict", 422, "TERMINAL_STATE_CONFLICT", false],
  ["out_of_stock", 409, "OUT_OF_STOCK", false],
  ["price_out_of_guardrail", 422, "PRICE_OUT_OF_GUARDRAIL", false],
  ["cancel_not_allowed", 422, "CANCEL_NOT_ALLOWED", false],
  ["rate_limited", 429, "RATE_LIMITED", true],
  ["dependency_unavailable", 503, "DEPENDENCY_UNAVAILABLE", true],
];

// **Validates: Requirements 10.7, 19.6, 20.4**
describe("stable safe errors and metadata redaction", () => {
  it.each(expectedErrors)("maps %s deterministically", (kind, status, code, retryable) => {
    const mapped = mapDomainError({ kind });
    expect(mapped).toMatchObject({ status, code, retryable });
    expect(mapped.message).not.toContain("undefined");
  });

  it("maps unexpected exceptions to a generic response without their message or stack", () => {
    const secret = "otp=654321 token=raw-token";
    const mapped = mapDomainError(new Error(secret));
    expect(mapped).toEqual({
      status: 500,
      code: "INTERNAL_ERROR",
      message: "An internal error occurred.",
      retryable: true,
    });
    expect(JSON.stringify(mapped)).not.toContain(secret);
    expect(JSON.stringify(mapped)).not.toContain("raw-token");
  });

  it("redacts sensitive keys, headers, inline credentials, and supplied sensitive values recursively", () => {
    const metadata = createSafeMetadata({
      requestId: "request-1",
      headers: { authorization: "Bearer raw-token", cookie: "session=raw-cookie", accept: "application/json" },
      password: "raw-password",
      otp: "654321",
      nested: { note: "Device device-1.raw-device-secret", raw: "private-marker" },
    }, ["private-marker"]);

    expect(metadata).toEqual({
      headers: { accept: "application/json", authorization: REDACTED, cookie: REDACTED },
      nested: { note: REDACTED, raw: REDACTED },
      otp: REDACTED,
      password: REDACTED,
      requestId: "request-1",
    });
    const serialized = JSON.stringify(metadata);
    for (const leaked of ["raw-token", "raw-cookie", "raw-password", "654321", "raw-device-secret", "private-marker"]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("handles cyclic metadata safely and sanitizes labelled text", () => {
    const cyclic: Record<string, unknown> = { safe: "ok" };
    cyclic.self = cyclic;
    expect(createSafeMetadata(cyclic)).toEqual({ safe: "ok", self: REDACTED });
    expect(redactText("authorization=Bearer-token otp:654321")).toBe(`${REDACTED} ${REDACTED}`);
  });
});

// **Validates: Requirements 17.4, 17.6, 22.7**
describe("reversible Pluto private-beta policy", () => {
  const base = {
    operation: "discover" as const,
    buyerAccountRef: "buyer-1",
    partnerSupplyEnabled: true,
    allowlistedBuyerAccountRefs: ["buyer-1"],
    existingPlutoOrder: false,
  };

  it("allows discovery and purchase only when both flag and allowlist permit them", () => {
    expect(decidePlutoPolicy(base)).toEqual({ allowed: true, reason: "PRIVATE_BETA_ELIGIBLE" });
    expect(decidePlutoPolicy({ ...base, operation: "purchase" })).toEqual({
      allowed: true,
      reason: "PRIVATE_BETA_ELIGIBLE",
    });
    expect(decidePlutoPolicy({ ...base, partnerSupplyEnabled: false })).toEqual({
      allowed: false,
      reason: "FEATURE_DISABLED",
    });
    expect(decidePlutoPolicy({ ...base, allowlistedBuyerAccountRefs: [] })).toEqual({
      allowed: false,
      reason: "BUYER_NOT_ALLOWLISTED",
    });
  });

  it("keeps status and cancel available for existing orders when the flag or allowlist is removed", () => {
    for (const operation of ["existing-order-status", "existing-order-cancel"] as const) {
      expect(decidePlutoPolicy({
        ...base,
        operation,
        partnerSupplyEnabled: false,
        allowlistedBuyerAccountRefs: [],
        existingPlutoOrder: true,
      })).toEqual({ allowed: true, reason: "EXISTING_ORDER_OPERATION" });
    }
  });

  it("does not treat a missing order as an existing-order operation", () => {
    expect(decidePlutoPolicy({ ...base, operation: "existing-order-status", existingPlutoOrder: false }))
      .toEqual({ allowed: false, reason: "ORDER_NOT_FOUND" });
  });
});
