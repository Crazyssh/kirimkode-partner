import { describe, expect, it } from "vitest";

import { SecurityEventEmitter } from "./security-event-emitter";

function captured() {
  const lines: string[] = [];
  const emitter = new SecurityEventEmitter({
    nowEpochMs: () => 0,
    sink: (line) => lines.push(line),
  });
  return { emitter, lines };
}

// **Validates: Requirements 18.7, 19.6**
describe("SecurityEventEmitter", () => {
  it("emits on a stream tagged separately from the request log", () => {
    const { emitter, lines } = captured();

    emitter.emit({
      type: "ownership_violation",
      requestId: "req-1",
      principalId: "partner-1",
      deviceId: "device-1",
    });

    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.stream).toBe("security");
    expect(event.type).toBe("ownership_violation");
    expect(event.severity).toBe("warning");
    // Identifiers are hashed, never verbatim.
    expect(lines[0]).not.toContain("partner-1");
    expect(lines[0]).not.toContain("device-1");
  });

  it("never persists a secret or OTP handed to it", () => {
    const { emitter, lines } = captured();

    emitter.emit({
      type: "authentication_failure",
      requestId: "req-2",
      principalId: "partner-2",
      detail: {
        otp: "123456",
        authorization: "Bearer leak",
        apiKey: "k-live-123",
        reason: "bad signature",
      },
    });

    const line = lines[0];
    expect(line).not.toContain("123456");
    expect(line).not.toContain("Bearer leak");
    expect(line).not.toContain("k-live-123");
    const event = JSON.parse(line);
    expect(event.detail.reason).toBe("bad signature");
    expect(event.detail.otp).toBe("[REDACTED]");
  });
});
