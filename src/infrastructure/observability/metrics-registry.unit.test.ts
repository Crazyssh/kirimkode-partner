import { describe, expect, it } from "vitest";

import { MetricsRegistry } from "./metrics-registry";

// **Validates: Requirements 20.3**
describe("MetricsRegistry", () => {
  it("accumulates counters per label set", () => {
    const registry = new MetricsRegistry();
    registry.increment("partner_request_total", { api: "agent", method: "POST" });
    registry.increment("partner_request_total", { api: "agent", method: "POST" });
    registry.increment("partner_request_total", { api: "internal", method: "GET" });

    const { counters } = registry.snapshot();
    const agentPost = counters.find(
      (c) => c.labels.api === "agent" && c.labels.method === "POST",
    );
    expect(agentPost?.value).toBe(2);
    expect(counters).toHaveLength(2);
  });

  it("holds the last value for a gauge", () => {
    const registry = new MetricsRegistry();
    registry.setGauge("partner_db_pool_in_use", 3);
    registry.setGauge("partner_db_pool_in_use", 7);

    const { gauges } = registry.snapshot();
    expect(gauges).toEqual([
      { name: "partner_db_pool_in_use", labels: {}, value: 7 },
    ]);
  });

  it("aggregates histogram count/sum/min/max", () => {
    const registry = new MetricsRegistry();
    registry.observe("partner_request_latency_ms", 10, { api: "agent" });
    registry.observe("partner_request_latency_ms", 30, { api: "agent" });

    const [histogram] = registry.snapshot().histograms;
    expect(histogram).toMatchObject({ count: 2, sum: 40, min: 10, max: 30 });
  });

  it("rejects an unknown metric name", () => {
    const registry = new MetricsRegistry();
    // @ts-expect-error deliberately passing an unknown metric name.
    expect(() => registry.increment("not_a_metric")).toThrow(/Unknown metric/);
  });

  it("rejects using a metric with the wrong kind", () => {
    const registry = new MetricsRegistry();
    // A gauge cannot be incremented like a counter.
    expect(() => registry.increment("partner_db_pool_in_use")).toThrow(/counter/);
  });
});
