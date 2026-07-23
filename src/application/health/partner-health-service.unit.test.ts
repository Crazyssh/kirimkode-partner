import { describe, expect, it } from "vitest";

import { DEPENDENCY_UNAVAILABLE, PartnerHealthService } from "./partner-health-service";

const observedAt = new Date("2026-03-15T08:30:00.000Z");

// **Validates: Requirements 1.4, 20.3, 20.4**
describe("Partner health service", () => {
  it("reports process liveness using only stable public fields", () => {
    const service = new PartnerHealthService("1.2.3", { async isReady() { return true; } }, () => observedAt);

    expect(service.liveness()).toEqual({
      status: "live",
      version: "1.2.3",
      time: "2026-03-15T08:30:00.000Z",
    });
  });

  it("reports readiness only after the persisted database probe succeeds", async () => {
    const service = new PartnerHealthService("1.2.3", { async isReady() { return true; } }, () => observedAt);

    expect(await service.readiness()).toEqual({
      status: "ready",
      version: "1.2.3",
      time: "2026-03-15T08:30:00.000Z",
    });
  });

  it("sanitizes rejected dependency checks to one stable status", async () => {
    const leakedDetail = "postgresql://secret@db/schema private_table";
    const service = new PartnerHealthService("1.2.3", {
      async isReady() { throw new Error(leakedDetail); },
    }, () => observedAt);

    const result = await service.readiness();
    expect(result.status).toBe(DEPENDENCY_UNAVAILABLE);
    expect(JSON.stringify(result)).not.toContain(leakedDetail);
    expect(Object.keys(result)).toEqual(["status", "version", "time"]);
  });
});
