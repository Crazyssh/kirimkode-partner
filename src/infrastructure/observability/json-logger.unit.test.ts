import { describe, expect, it } from "vitest";

import { JsonLogger } from "./json-logger";

function captured() {
  const lines: string[] = [];
  const logger = new JsonLogger({
    service: "partner-api",
    env: "test",
    nowEpochMs: () => 0,
    sink: (line) => lines.push(line),
  });
  return { logger, lines };
}

// **Validates: Requirements 20.3, 20.4, 19.6**
describe("JsonLogger", () => {
  it("writes one redaction-safe JSON line per request", () => {
    const { logger, lines } = captured();

    logger.logRequest({
      requestId: "req-1",
      route: "/agent/v1/heartbeat",
      method: "POST",
      status: 200,
      latencyMs: 8,
      actorId: "partner-1",
      deviceId: "device-1",
    });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.service).toBe("partner-api");
    expect(record.level).toBe("info");
    expect(record.status).toBe(200);
    // The raw ids are hashed, never emitted verbatim.
    expect(lines[0]).not.toContain("partner-1");
    expect(lines[0]).not.toContain("device-1");
    expect(typeof record.actorHash).toBe("string");
    expect(record.actorHash).not.toBe("partner-1");
  });

  it("derives error/warn/info level from the status code", () => {
    const { logger } = captured();
    expect(logger.logRequest({ requestId: "r", route: "/x", method: "GET", status: 500, latencyMs: 1 }).level).toBe("error");
    expect(logger.logRequest({ requestId: "r", route: "/x", method: "GET", status: 404, latencyMs: 1 }).level).toBe("warn");
    expect(logger.logRequest({ requestId: "r", route: "/x", method: "GET", status: 201, latencyMs: 1 }).level).toBe("info");
  });

  it("cannot leak secrets placed in the extra bag of an error line", () => {
    const { logger, lines } = captured();

    logger.logError({
      requestId: "req-2",
      errorCode: "INTERNAL_ERROR",
      route: "/agent/v1/sms",
      method: "POST",
      status: 500,
      extra: {
        authorization: "Bearer top-secret",
        otp: "999000",
        rawSms: "Your code is 999000",
      },
    });

    const line = lines[0];
    expect(line).not.toContain("top-secret");
    expect(line).not.toContain("999000");
    const record = JSON.parse(line);
    expect(record.errorCode).toBe("INTERNAL_ERROR");
    expect(record.extra.authorization).toBe("[REDACTED]");
    expect(record.extra.otp).toBe("[REDACTED]");
    expect(record.extra.rawSms).toBe("[REDACTED]");
  });
});
