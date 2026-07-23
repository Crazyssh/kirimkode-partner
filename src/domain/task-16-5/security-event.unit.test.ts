import { describe, expect, it } from "vitest";

import {
  buildSecurityEvent,
  severityForSecurityEvent,
  type SecurityEventContext,
  type SecurityEventType,
} from "./security-event";
import { REDACTION_PLACEHOLDER } from "./redaction";

const fakeHash = (raw: string): string => `h:${raw}`;
const context: SecurityEventContext = { hash: fakeHash };

// **Validates: Requirements 18.7, 19.6**
describe("task 16.5 security events", () => {
  it("assigns a fixed severity to every event type", () => {
    const expected: Record<SecurityEventType, string> = {
      authentication_failure: "info",
      replay_violation: "warning",
      rate_limit_hit: "warning",
      ownership_violation: "warning",
      admin_raw_data_access: "warning",
    };
    for (const [type, severity] of Object.entries(expected)) {
      expect(severityForSecurityEvent(type as SecurityEventType)).toBe(severity);
    }
  });

  it("builds an authentication_failure event with hashed identifiers", () => {
    const event = buildSecurityEvent(context, {
      type: "authentication_failure",
      timestampEpochMs: 0,
      requestId: "req-1",
      principalId: "partner-1",
      deviceId: "device-1",
      route: "/agent/v1/heartbeat",
      source: "203.0.113.7",
    });

    expect(event).toEqual({
      timestamp: "1970-01-01T00:00:00.000Z",
      type: "authentication_failure",
      severity: "info",
      requestId: "req-1",
      principalHash: "h:partner-1",
      deviceHash: "h:device-1",
      route: "/agent/v1/heartbeat",
      sourceHash: "h:203.0.113.7",
      detail: {},
    });
  });

  it("never records a secret or OTP, even when handed one in detail", () => {
    const event = buildSecurityEvent(context, {
      type: "replay_violation",
      timestampEpochMs: 0,
      requestId: "req-2",
      principalId: "partner-2",
      detail: {
        nonce: "abc",
        otp: "123456",
        authorization: "Bearer x",
        token: "t-1",
        reason: "nonce reused",
      },
    });

    expect(event.detail).toEqual({
      nonce: "abc",
      otp: REDACTION_PLACEHOLDER,
      authorization: REDACTION_PLACEHOLDER,
      token: REDACTION_PLACEHOLDER,
      reason: "nonce reused",
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("123456");
    expect(serialized).not.toContain("Bearer x");
    expect(serialized).not.toContain("t-1");
  });

  it("records an admin_raw_data_access event as a warning trail", () => {
    const event = buildSecurityEvent(context, {
      type: "admin_raw_data_access",
      timestampEpochMs: 5000,
      requestId: "req-3",
      principalId: "admin-9",
      detail: { resource: "raw_sms", reason: "support ticket 42" },
    });

    expect(event.type).toBe("admin_raw_data_access");
    expect(event.severity).toBe("warning");
    expect(event.detail).toEqual({ resource: "raw_sms", reason: "support ticket 42" });
    expect(event.principalHash).toBe("h:admin-9");
  });

  it("leaves absent identifiers null", () => {
    const event = buildSecurityEvent(context, {
      type: "rate_limit_hit",
      timestampEpochMs: 0,
      requestId: "req-4",
    });

    expect(event.principalHash).toBeNull();
    expect(event.deviceHash).toBeNull();
    expect(event.sourceHash).toBeNull();
    expect(event.route).toBeNull();
  });
});
