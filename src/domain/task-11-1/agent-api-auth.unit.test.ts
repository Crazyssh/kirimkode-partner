import { describe, expect, it } from "vitest";

import {
  parseAgentAuthorizationHeader,
  parseAgentReplayHeaders,
} from "./agent-api-auth";

// **Validates: Requirements 18.2, 18.4, 18.6**
describe("parseAgentAuthorizationHeader", () => {
  const publicId = "cHVibGljLWlkLTAxMjM0NTY3OA";
  const secret = "s".repeat(43);

  it("parses a well-formed Device credential", () => {
    const parsed = parseAgentAuthorizationHeader(`Device ${publicId}.${secret}`);
    expect(parsed).toEqual({ publicId, secret });
  });

  it("accepts a case-insensitive scheme and surrounding whitespace", () => {
    const parsed = parseAgentAuthorizationHeader(`  device   ${publicId}.${secret}  `);
    expect(parsed).toEqual({ publicId, secret });
  });

  it("rejects a null, empty, or scheme-only header", () => {
    expect(parseAgentAuthorizationHeader(null)).toBeNull();
    expect(parseAgentAuthorizationHeader("")).toBeNull();
    expect(parseAgentAuthorizationHeader("Device")).toBeNull();
    expect(parseAgentAuthorizationHeader("Device ")).toBeNull();
  });

  it("rejects the wrong scheme", () => {
    expect(parseAgentAuthorizationHeader(`Bearer ${publicId}.${secret}`)).toBeNull();
  });

  it("rejects a token without a separator or with an empty half", () => {
    expect(parseAgentAuthorizationHeader(`Device ${publicId}${secret}`)).toBeNull();
    expect(parseAgentAuthorizationHeader(`Device .${secret}`)).toBeNull();
    expect(parseAgentAuthorizationHeader(`Device ${publicId}.`)).toBeNull();
  });

  it("rejects a too-short secret or out-of-charset public id", () => {
    expect(parseAgentAuthorizationHeader(`Device ${publicId}.short`)).toBeNull();
    expect(parseAgentAuthorizationHeader(`Device pub!id.${secret}`)).toBeNull();
  });
});

// **Validates: Requirements 18.4**
describe("parseAgentReplayHeaders", () => {
  const base = {
    timestamp: "1700000000",
    nonce: "0123456789abcdef0123456789abcdef",
    idempotencyKey: "op-1",
  } as const;

  it("parses timestamp, nonce, and idempotency key when present", () => {
    const parsed = parseAgentReplayHeaders(base, { requireIdempotencyKey: true });
    expect(parsed).toEqual({
      timestampSeconds: 1_700_000_000,
      nonce: base.nonce,
      idempotencyKey: "op-1",
    });
  });

  it("treats a blank idempotency key as absent when not required", () => {
    const parsed = parseAgentReplayHeaders(
      { ...base, idempotencyKey: null },
      { requireIdempotencyKey: false },
    );
    expect(parsed?.idempotencyKey).toBe("");
  });

  it("rejects a missing idempotency key when required", () => {
    expect(
      parseAgentReplayHeaders(
        { ...base, idempotencyKey: null },
        { requireIdempotencyKey: true },
      ),
    ).toBeNull();
  });

  it("rejects a missing or non-numeric timestamp", () => {
    expect(
      parseAgentReplayHeaders({ ...base, timestamp: null }, { requireIdempotencyKey: false }),
    ).toBeNull();
    expect(
      parseAgentReplayHeaders({ ...base, timestamp: "-1" }, { requireIdempotencyKey: false }),
    ).toBeNull();
    expect(
      parseAgentReplayHeaders({ ...base, timestamp: "1.5" }, { requireIdempotencyKey: false }),
    ).toBeNull();
  });

  it("rejects a missing nonce (uniqueness is validated downstream)", () => {
    expect(
      parseAgentReplayHeaders({ ...base, nonce: null }, { requireIdempotencyKey: false }),
    ).toBeNull();
    expect(
      parseAgentReplayHeaders({ ...base, nonce: "" }, { requireIdempotencyKey: false }),
    ).toBeNull();
  });

  it("rejects a malformed idempotency key", () => {
    expect(
      parseAgentReplayHeaders(
        { ...base, idempotencyKey: "has space" },
        { requireIdempotencyKey: true },
      ),
    ).toBeNull();
  });
});
