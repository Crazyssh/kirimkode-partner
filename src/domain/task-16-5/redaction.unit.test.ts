import { describe, expect, it } from "vitest";

import {
  CIRCULAR_PLACEHOLDER,
  isSensitiveKey,
  normalizeKey,
  redact,
  redactRecord,
  REDACTION_PLACEHOLDER,
  type RedactableValue,
} from "./redaction";

// **Validates: Requirements 18.7, 19.6**
describe("task 16.5 central redaction", () => {
  it("normalizes separator/case variants of a key to one form", () => {
    expect(normalizeKey("Api-Key")).toBe("apikey");
    expect(normalizeKey("api_key")).toBe("apikey");
    expect(normalizeKey("apiKey")).toBe("apikey");
    expect(normalizeKey("Set-Cookie")).toBe("setcookie");
  });

  it("flags every design-mandated sensitive field, in any spelling", () => {
    for (const key of [
      "authorization",
      "Authorization",
      "Proxy-Authorization",
      "cookie",
      "Set-Cookie",
      "password",
      "passwordHash",
      "token",
      "accessToken",
      "refresh_token",
      "apiKey",
      "x-api-key",
      "clientSecret",
      "otp",
      "otpCode",
      "oneTimePassword",
      "sms",
      "rawSms",
      "smsBody",
      "messageBody",
      "body",
      "accountNumber",
      "bank_account_number",
      "pin",
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it("does not flag operational fields whose names merely embed a sensitive word", () => {
    for (const key of [
      "smsCount",
      "unmatchedSms",
      "ambiguousSms",
      "otpAttempts",
      "accountId",
      "partnerOrderId",
      "latencyMs",
      "requestId",
      "status",
    ]) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it("redacts sensitive fields but leaves safe scalars intact", () => {
    const input: RedactableValue = {
      requestId: "req-1",
      authorization: "Bearer super-secret",
      password: "hunter2",
      otp: "123456",
      rawSms: "Your code is 123456",
      accountNumber: "1234567890123456",
      latencyMs: 42,
      status: 200,
    };

    expect(redact(input)).toEqual({
      requestId: "req-1",
      authorization: REDACTION_PLACEHOLDER,
      password: REDACTION_PLACEHOLDER,
      otp: REDACTION_PLACEHOLDER,
      rawSms: REDACTION_PLACEHOLDER,
      accountNumber: REDACTION_PLACEHOLDER,
      latencyMs: 42,
      status: 200,
    });
  });

  it("redacts sensitive fields nested in objects and arrays", () => {
    const input: RedactableValue = {
      headers: { Authorization: "Bearer x", "x-request-id": "req-2" },
      events: [
        { type: "auth", token: "abc" },
        { type: "sms", body: "code 999888" },
      ],
    };

    expect(redact(input)).toEqual({
      headers: { Authorization: REDACTION_PLACEHOLDER, "x-request-id": "req-2" },
      events: [
        { type: "auth", token: REDACTION_PLACEHOLDER },
        { type: "sms", body: REDACTION_PLACEHOLDER },
      ],
    });
  });

  it("tolerates circular references without infinite recursion", () => {
    const cyclic: Record<string, RedactableValue> = { requestId: "req-3" };
    cyclic.self = cyclic as unknown as RedactableValue;

    const result = redact(cyclic) as Record<string, RedactableValue>;
    expect(result.requestId).toBe("req-3");
    expect(result.self).toBe(CIRCULAR_PLACEHOLDER);
  });

  it("redactRecord returns a plain object with sensitive members stripped", () => {
    const result = redactRecord({ apiKey: "k", note: "ok" });
    expect(result).toEqual({ apiKey: REDACTION_PLACEHOLDER, note: "ok" });
  });
});
