import { describe, expect, it } from "vitest";

import { createLivenessHandler } from "./live/route";
import { createReadinessHandler } from "./ready/route";

const time = "2026-03-15T08:30:00.000Z";

// **Validates: Requirements 1.4, 20.3, 20.4**
describe("public health routes", () => {
  it("returns the exact liveness body and propagates request identity", async () => {
    const get = createLivenessHandler(() => ({ status: "live", version: "1.2.3", time }));
    const response = get(new Request("https://partner.test/api/health/live", {
      headers: { "x-request-id": "probe-123" },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("probe-123");
    expect(await response.json()).toEqual({ status: "live", version: "1.2.3", time });
  });

  it("returns ready only when the application readiness query succeeds", async () => {
    const get = createReadinessHandler(async () => ({ status: "ready", version: "1.2.3", time }));
    const response = await get(new Request("https://partner.test/api/health/ready"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", version: "1.2.3", time });
  });

  it("returns a sanitized stable 503 without dependency details", async () => {
    const get = createReadinessHandler(async () => ({
      status: "DEPENDENCY_UNAVAILABLE", version: "1.2.3", time,
    }));
    const response = await get(new Request("https://partner.test/api/health/ready"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ status: "DEPENDENCY_UNAVAILABLE", version: "1.2.3", time });
    expect(JSON.stringify(body)).not.toMatch(/postgres|dsn|schema|secret/i);
  });
});
