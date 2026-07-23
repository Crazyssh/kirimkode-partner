import { describe, expect, it } from "vitest";

import {
  buildLogRecord,
  type LogContext,
} from "./log-record";
import { REDACTION_PLACEHOLDER } from "./redaction";

// A deterministic, reversible fake hasher so tests can assert *that* an id was
// hashed (prefixed) without depending on a real digest.
const fakeHash = (raw: string): string => `h:${raw}`;

const context: LogContext = { service: "partner-api", env: "test", hash: fakeHash };

// **Validates: Requirements 20.3, 20.4, 19.6**
describe("task 16.5 structured log record", () => {
  it("emits every design-mandated field with hashed actor/device ids", () => {
    const record = buildLogRecord(context, {
      level: "info",
      timestampEpochMs: 0,
      requestId: "req-1",
      route: "/agent/v1/heartbeat",
      method: "POST",
      status: 200,
      latencyMs: 12,
      actorId: "partner-42",
      deviceId: "device-7",
      partnerOrderId: "order-9",
      errorCode: null,
    });

    expect(record).toEqual({
      timestamp: "1970-01-01T00:00:00.000Z",
      level: "info",
      service: "partner-api",
      env: "test",
      requestId: "req-1",
      route: "/agent/v1/heartbeat",
      method: "POST",
      status: 200,
      latencyMs: 12,
      actorHash: "h:partner-42",
      deviceHash: "h:device-7",
      partnerOrderId: "order-9",
      errorCode: null,
    });
  });

  it("never writes a raw actor/device id (only its hash)", () => {
    // A hasher that genuinely obscures the input (hex encoding), mirroring the
    // real SHA-256 adapter: the digest must not contain the raw id substring.
    const obscuringHash = (raw: string): string =>
      Buffer.from(raw, "utf8").toString("hex");
    const obscuringContext: LogContext = {
      service: "partner-api",
      env: "test",
      hash: obscuringHash,
    };

    const record = buildLogRecord(obscuringContext, {
      level: "warn",
      timestampEpochMs: 1000,
      requestId: "req-2",
      actorId: "partner-secret-id",
      deviceId: "device-secret-id",
    });

    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("partner-secret-id");
    expect(serialized).not.toContain("device-secret-id");
    expect(record.actorHash).toBe(obscuringHash("partner-secret-id"));
    expect(record.deviceHash).toBe(obscuringHash("device-secret-id"));
  });

  it("leaves absent ids/fields null rather than hashing empty strings", () => {
    const record = buildLogRecord(context, {
      level: "info",
      timestampEpochMs: 0,
      requestId: "req-3",
    });

    expect(record.actorHash).toBeNull();
    expect(record.deviceHash).toBeNull();
    expect(record.route).toBeNull();
    expect(record.status).toBeNull();
    expect(record.errorCode).toBeNull();
  });

  it("redacts secrets smuggled into the free-form extra bag", () => {
    const record = buildLogRecord(context, {
      level: "error",
      timestampEpochMs: 0,
      requestId: "req-4",
      errorCode: "INTERNAL_ERROR",
      extra: {
        authorization: "Bearer leak",
        otp: "654321",
        rawSms: "code 654321",
        note: "safe context",
      },
    });

    expect(record.extra).toEqual({
      authorization: REDACTION_PLACEHOLDER,
      otp: REDACTION_PLACEHOLDER,
      rawSms: REDACTION_PLACEHOLDER,
      note: "safe context",
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("Bearer leak");
    expect(serialized).not.toContain("654321");
  });
});
