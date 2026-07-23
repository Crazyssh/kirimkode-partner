import { describe, expect, it } from "vitest";

import {
  buildInternalApiCanonicalString,
  INTERNAL_API_HEADERS,
  INTERNAL_API_MAX_CLOCK_SKEW_SECONDS,
  INTERNAL_API_NONCE_TTL_SECONDS,
  parseInternalApiSignatureHeaders,
  type RawInternalApiSignatureHeaders,
} from "./internal-api-signing";

const HEX64 = "a".repeat(64);
const NONCE_HEX = "0123456789abcdef0123456789abcdef";

function rawHeaders(
  overrides: Partial<RawInternalApiSignatureHeaders> = {},
): RawInternalApiSignatureHeaders {
  return {
    clientId: "kirimkode-main",
    keyId: "key-2024-01",
    timestamp: "1700000000",
    nonce: NONCE_HEX,
    signature: HEX64,
    idempotencyKey: null,
    ...overrides,
  };
}

// **Validates: Requirements 10.1, 10.6, 10.7, 18.5**
describe("parseInternalApiSignatureHeaders", () => {
  it("accepts a well-formed signing header set", () => {
    const parsed = parseInternalApiSignatureHeaders(rawHeaders());
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      clientId: "kirimkode-main",
      keyId: "key-2024-01",
      timestampSeconds: 1_700_000_000,
      nonce: NONCE_HEX,
      signatureHex: HEX64,
      idempotencyKey: "",
    });
  });

  it("carries a bounded idempotency key when present", () => {
    const parsed = parseInternalApiSignatureHeaders(
      rawHeaders({ idempotencyKey: "reserve-123" }),
    );
    expect(parsed?.idempotencyKey).toBe("reserve-123");
  });

  it("treats a blank idempotency header as absent", () => {
    const parsed = parseInternalApiSignatureHeaders(rawHeaders({ idempotencyKey: "" }));
    expect(parsed?.idempotencyKey).toBe("");
  });

  it("lower-cases the signature so comparison is canonical", () => {
    const parsed = parseInternalApiSignatureHeaders(rawHeaders({ signature: "A".repeat(64) }));
    expect(parsed?.signatureHex).toBe("a".repeat(64));
  });

  it.each<[string, Partial<RawInternalApiSignatureHeaders>]>([
    ["missing client id", { clientId: null }],
    ["missing key id", { keyId: null }],
    ["missing timestamp", { timestamp: null }],
    ["missing nonce", { nonce: null }],
    ["missing signature", { signature: null }],
    ["empty nonce", { nonce: "" }],
    ["non-numeric timestamp", { timestamp: "17e9" }],
    ["negative timestamp", { timestamp: "-1" }],
    ["signature not hex", { signature: "z".repeat(64) }],
    ["signature wrong length", { signature: "a".repeat(63) }],
    ["client id with illegal char", { clientId: "bad id" }],
    ["oversized idempotency key", { idempotencyKey: "x".repeat(256) }],
  ])("rejects %s as null (generic failure, no leak)", (_label, overrides) => {
    expect(parseInternalApiSignatureHeaders(rawHeaders(overrides))).toBeNull();
  });

  it("exposes the canonical lower-case header names", () => {
    expect(INTERNAL_API_HEADERS).toMatchObject({
      clientId: "x-kk-client-id",
      keyId: "x-kk-key-id",
      timestamp: "x-kk-timestamp",
      nonce: "x-kk-nonce",
      signature: "x-kk-signature",
      idempotencyKey: "idempotency-key",
    });
  });
});

// **Validates: Requirements 10.1, 10.6**
describe("buildInternalApiCanonicalString", () => {
  const base = {
    method: "post",
    path: "/api/internal/v1/orders/reserve",
    timestampSeconds: 1_700_000_000,
    nonce: NONCE_HEX,
    bodySha256Hex: HEX64,
    idempotencyKey: "reserve-123",
  } as const;

  it("joins the six fields by newline in fixed order with an upper-cased method", () => {
    expect(buildInternalApiCanonicalString(base)).toBe(
      [
        "POST",
        "/api/internal/v1/orders/reserve",
        "1700000000",
        NONCE_HEX,
        HEX64,
        "reserve-123",
      ].join("\n"),
    );
  });

  it("keeps a trailing empty field for a request without an idempotency key", () => {
    const canonical = buildInternalApiCanonicalString({ ...base, idempotencyKey: "" });
    expect(canonical.endsWith("\n")).toBe(true);
    expect(canonical.split("\n")).toHaveLength(6);
  });

  it("is sensitive to every signed field", () => {
    const reference = buildInternalApiCanonicalString(base);
    expect(buildInternalApiCanonicalString({ ...base, method: "get" })).not.toBe(reference);
    expect(buildInternalApiCanonicalString({ ...base, path: "/api/internal/v1/orders/x" })).not.toBe(reference);
    expect(buildInternalApiCanonicalString({ ...base, timestampSeconds: 1_700_000_001 })).not.toBe(reference);
    expect(buildInternalApiCanonicalString({ ...base, nonce: "f".repeat(32) })).not.toBe(reference);
    expect(buildInternalApiCanonicalString({ ...base, bodySha256Hex: "b".repeat(64) })).not.toBe(reference);
    expect(buildInternalApiCanonicalString({ ...base, idempotencyKey: "reserve-999" })).not.toBe(reference);
  });

  it("throws on incomplete input rather than emitting an ambiguous string", () => {
    expect(() => buildInternalApiCanonicalString({ ...base, method: "" })).toThrow(TypeError);
    expect(() => buildInternalApiCanonicalString({ ...base, path: "" })).toThrow(TypeError);
    expect(() => buildInternalApiCanonicalString({ ...base, nonce: "" })).toThrow(TypeError);
    expect(() => buildInternalApiCanonicalString({ ...base, bodySha256Hex: "nothex" })).toThrow(TypeError);
    expect(() => buildInternalApiCanonicalString({ ...base, timestampSeconds: -1 })).toThrow(TypeError);
  });

  it("uses the design-mandated replay window defaults", () => {
    expect(INTERNAL_API_MAX_CLOCK_SKEW_SECONDS).toBe(300);
    expect(INTERNAL_API_NONCE_TTL_SECONDS).toBe(600);
  });
});
