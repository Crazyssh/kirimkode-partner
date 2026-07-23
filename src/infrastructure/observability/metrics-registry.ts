import {
  isKnownMetric,
  METRIC_DEFINITIONS_BY_NAME,
  type MetricDefinition,
  type MetricName,
} from "@domain/task-16-5";

/**
 * In-process metrics registry (task 16.5; design section 12; requirement 20.3).
 *
 * A minimal, dependency-free recorder for the fixed {@link METRIC_CATALOG}. It
 * validates every sample against the catalog — recording an unknown metric or
 * using a metric with the wrong kind throws, so a typo can never spawn a shadow
 * metric — and exposes a {@link snapshot} the readiness/ops surface (or a
 * Prometheus exporter, post-MVP) can render. Labels are folded into a stable
 * key so per-`api`/`state`/`job` series stay separate.
 *
 * Counters accumulate, gauges hold the last set value, and histograms keep
 * count/sum/min/max (enough to derive averages and feed the alert-signal error
 * rate without pulling in a histogram library for the MVP).
 */

type Labels = Readonly<Record<string, string>>;

interface HistogramState {
  count: number;
  sum: number;
  min: number;
  max: number;
}

export interface CounterSample {
  readonly name: MetricName;
  readonly labels: Labels;
  readonly value: number;
}

export interface GaugeSample {
  readonly name: MetricName;
  readonly labels: Labels;
  readonly value: number;
}

export interface HistogramSample {
  readonly name: MetricName;
  readonly labels: Labels;
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
}

export interface MetricsSnapshot {
  readonly counters: readonly CounterSample[];
  readonly gauges: readonly GaugeSample[];
  readonly histograms: readonly HistogramSample[];
}

function seriesKey(name: string, labels: Labels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`);
  return parts.length === 0 ? name : `${name}{${parts.join(",")}}`;
}

function definitionOrThrow(name: MetricName, kind: MetricDefinition["kind"]): MetricDefinition {
  if (!isKnownMetric(name)) {
    throw new Error(`Unknown metric: ${name}`);
  }
  const definition = METRIC_DEFINITIONS_BY_NAME.get(name)!;
  if (definition.kind !== kind) {
    throw new Error(
      `Metric ${name} is a ${definition.kind}, not a ${kind}.`,
    );
  }
  return definition;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, CounterSample>();
  private readonly gauges = new Map<string, GaugeSample>();
  private readonly histograms = new Map<string, { name: MetricName; labels: Labels; state: HistogramState }>();

  /** Increment a counter by `amount` (default 1). */
  increment(name: MetricName, labels: Labels = {}, amount = 1): void {
    definitionOrThrow(name, "counter");
    const key = seriesKey(name, labels);
    const existing = this.counters.get(key);
    this.counters.set(key, {
      name,
      labels,
      value: (existing?.value ?? 0) + amount,
    });
  }

  /** Set a gauge to an absolute value. */
  setGauge(name: MetricName, value: number, labels: Labels = {}): void {
    definitionOrThrow(name, "gauge");
    this.gauges.set(seriesKey(name, labels), { name, labels, value });
  }

  /** Record one observation into a histogram. */
  observe(name: MetricName, value: number, labels: Labels = {}): void {
    definitionOrThrow(name, "histogram");
    const key = seriesKey(name, labels);
    const existing = this.histograms.get(key);
    if (existing === undefined) {
      this.histograms.set(key, {
        name,
        labels,
        state: { count: 1, sum: value, min: value, max: value },
      });
      return;
    }
    existing.state.count += 1;
    existing.state.sum += value;
    existing.state.min = Math.min(existing.state.min, value);
    existing.state.max = Math.max(existing.state.max, value);
  }

  /** Immutable snapshot of every recorded series. */
  snapshot(): MetricsSnapshot {
    return {
      counters: [...this.counters.values()],
      gauges: [...this.gauges.values()],
      histograms: [...this.histograms.values()].map(({ name, labels, state }) => ({
        name,
        labels,
        count: state.count,
        sum: state.sum,
        min: state.min,
        max: state.max,
      })),
    };
  }
}
