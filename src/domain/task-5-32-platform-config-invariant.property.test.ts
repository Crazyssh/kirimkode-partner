import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLATFORM_CONFIG,
  validatePlatformConfig,
  assertValidPlatformConfig,
  type PlatformConfigInput,
  type RetentionConfig,
} from "@domain/task-5-7";

// Feature: partner-platform, Property 25: Policy konfigurasi selalu menjaga invariant
//
// For all kandidat PlatformConfig (guardrail, fee, markup, round unit, timeout,
// cancel minimum, heartbeat interval/timeout, hold, minimum payout, dan seluruh
// jendela retention), config HANYA dapat diaktifkan bila SEMUA invariant berikut
// terpenuhi: guardrail terurut dan positif, fixed fee/markup/hold non-negatif,
// round unit positif, order/cancel/heartbeat timeout positif, cancel minimum
// lebih kecil dari order timeout, heartbeat timeout lebih besar dari heartbeat
// interval, minimum payout positif, dan setiap jendela retention non-negatif.
// Validasi bersifat total (menerima integer valid/invalid) dan deterministik;
// hasil `valid` selalu ekuivalen dengan oracle invariant independen, dan config
// yang diterima selalu beku (immutable) dengan nilai yang identik.
//
// **Validates: Requirements 16.5, 19.4**
//
// Design references:
// - PlatformConfig terversi menyimpan guardrail, fee, markup bps, round unit,
//   timeout, cancel minimum, heartbeat interval/timeout, hold, minimum payout,
//   dan retention; update tervalidasi sebelum aktivasi (Design §2, Req 16.5).
// - Retention SMS mentah, OTP, log keamanan, audit, dan data finansial harus
//   dikonfigurasi dengan nilai non-negatif (Req 19.4 / Req 15/19).
// - Pure domain test tidak memakai DB/network (Testing Strategy).
// - Property 25 bukan bagian dari set 500-run (parser/pricing/state machine/
//   ledger); memakai minimum numRuns per Testing Strategy.

const NUM_RUNS = 300;

function isNonNegInt(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPosInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

// Independent oracle: mirrors the specification invariants for Property 25 so we
// can assert equivalence with the implementation across valid AND invalid input.
function invariantsHold(c: PlatformConfigInput): boolean {
  const guardrail =
    isPosInt(c.minBasePriceIdr) &&
    isPosInt(c.maxBasePriceIdr) &&
    c.minBasePriceIdr <= c.maxBasePriceIdr;
  const fee = isNonNegInt(c.fixedFeeIdr);
  const markup = isNonNegInt(c.markupBps);
  const round = isPosInt(c.roundToIdr);
  const cancel =
    isPosInt(c.orderTimeoutMs) &&
    isPosInt(c.cancelMinimumMs) &&
    c.cancelMinimumMs < c.orderTimeoutMs;
  const heartbeat =
    isPosInt(c.heartbeatIntervalMs) &&
    isPosInt(c.heartbeatTimeoutMs) &&
    c.heartbeatTimeoutMs > c.heartbeatIntervalMs;
  const hold = isNonNegInt(c.earningHoldMs);
  const payout = isPosInt(c.minimumPayoutIdr);
  const retention =
    isNonNegInt(c.retention?.smsRawMs) &&
    isNonNegInt(c.retention?.otpAfterTerminalMs) &&
    isNonNegInt(c.retention?.heartbeatMetadataMs) &&
    isNonNegInt(c.retention?.securityLogMs) &&
    isNonNegInt(c.retention?.auditMs) &&
    isNonNegInt(c.retention?.ledgerPayoutMs);

  return (
    guardrail &&
    fee &&
    markup &&
    round &&
    cancel &&
    heartbeat &&
    hold &&
    payout &&
    retention
  );
}

const SCALAR_KEYS = [
  "minBasePriceIdr",
  "maxBasePriceIdr",
  "fixedFeeIdr",
  "markupBps",
  "roundToIdr",
  "orderTimeoutMs",
  "cancelMinimumMs",
  "heartbeatIntervalMs",
  "heartbeatTimeoutMs",
  "earningHoldMs",
  "minimumPayoutIdr",
] as const;

const RETENTION_KEYS = [
  "smsRawMs",
  "otpAfterTerminalMs",
  "heartbeatMetadataMs",
  "securityLogMs",
  "auditMs",
  "ledgerPayoutMs",
] as const;

// A single numeric value that is intentionally a mix of valid and invalid inputs:
// positive safe integers, zero, negatives, fractionals, NaN, and out-of-range
// (non-safe) integers exercise both isPosInt and isNonNegInt branches.
const intishArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 1, max: 5_000_000 }) },
  { weight: 2, arbitrary: fc.constant(0) },
  { weight: 2, arbitrary: fc.integer({ min: -5_000_000, max: -1 }) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 1000 }).map((n) => n + 0.5) },
  { weight: 1, arbitrary: fc.constant(Number.NaN) },
  { weight: 1, arbitrary: fc.constant(Number.MAX_SAFE_INTEGER + 1) },
);

const retentionIntishArb: fc.Arbitrary<RetentionConfig> = fc.record({
  smsRawMs: intishArb,
  otpAfterTerminalMs: intishArb,
  heartbeatMetadataMs: intishArb,
  securityLogMs: intishArb,
  auditMs: intishArb,
  ledgerPayoutMs: intishArb,
});

// Fully random config: most draws are invalid, exercising every violation code.
const randomConfigArb: fc.Arbitrary<PlatformConfigInput> = fc.record({
  minBasePriceIdr: intishArb,
  maxBasePriceIdr: intishArb,
  fixedFeeIdr: intishArb,
  markupBps: intishArb,
  roundToIdr: intishArb,
  orderTimeoutMs: intishArb,
  cancelMinimumMs: intishArb,
  heartbeatIntervalMs: intishArb,
  heartbeatTimeoutMs: intishArb,
  earningHoldMs: intishArb,
  minimumPayoutIdr: intishArb,
  retention: retentionIntishArb,
});

// Guaranteed-valid config: every cross-field relation is satisfied by
// construction so the accepting branch is exercised on a large fraction of runs.
const validConfigArb: fc.Arbitrary<PlatformConfigInput> = fc
  .record({
    minBasePriceIdr: fc.integer({ min: 1, max: 5_000 }),
    guardrailSpan: fc.integer({ min: 0, max: 100_000 }),
    fixedFeeIdr: fc.integer({ min: 0, max: 5_000 }),
    markupBps: fc.integer({ min: 0, max: 10_000 }),
    roundToIdr: fc.integer({ min: 1, max: 1_000 }),
    orderTimeoutMs: fc.integer({ min: 2, max: 3_600_000 }),
    cancelSeed: fc.nat(),
    heartbeatIntervalMs: fc.integer({ min: 1, max: 120_000 }),
    heartbeatSpan: fc.integer({ min: 1, max: 120_000 }),
    earningHoldMs: fc.integer({ min: 0, max: 604_800_000 }),
    minimumPayoutIdr: fc.integer({ min: 1, max: 1_000_000 }),
    retention: fc.record({
      smsRawMs: fc.integer({ min: 0, max: 604_800_000 }),
      otpAfterTerminalMs: fc.integer({ min: 0, max: 604_800_000 }),
      heartbeatMetadataMs: fc.integer({ min: 0, max: 604_800_000 }),
      securityLogMs: fc.integer({ min: 0, max: 604_800_000 }),
      auditMs: fc.integer({ min: 0, max: 604_800_000 }),
      ledgerPayoutMs: fc.integer({ min: 0, max: 604_800_000 }),
    }),
  })
  .map((r) => ({
    minBasePriceIdr: r.minBasePriceIdr,
    maxBasePriceIdr: r.minBasePriceIdr + r.guardrailSpan,
    fixedFeeIdr: r.fixedFeeIdr,
    markupBps: r.markupBps,
    roundToIdr: r.roundToIdr,
    orderTimeoutMs: r.orderTimeoutMs,
    // cancel minimum lands in [1, orderTimeout - 1] so it is strictly below.
    cancelMinimumMs: 1 + (r.cancelSeed % (r.orderTimeoutMs - 1)),
    heartbeatIntervalMs: r.heartbeatIntervalMs,
    heartbeatTimeoutMs: r.heartbeatIntervalMs + r.heartbeatSpan,
    earningHoldMs: r.earningHoldMs,
    minimumPayoutIdr: r.minimumPayoutIdr,
    retention: r.retention,
  }));

// Valid config with exactly one scalar field replaced by an intish value:
// targeted coverage that each single invariant is independently enforced.
const mutatedScalarArb: fc.Arbitrary<PlatformConfigInput> = fc
  .tuple(validConfigArb, fc.constantFrom(...SCALAR_KEYS), intishArb)
  .map(([base, key, badValue]) => ({ ...base, [key]: badValue }));

// Valid config with exactly one retention window replaced by an intish value.
const mutatedRetentionArb: fc.Arbitrary<PlatformConfigInput> = fc
  .tuple(validConfigArb, fc.constantFrom(...RETENTION_KEYS), intishArb)
  .map(([base, key, badValue]) => ({
    ...base,
    retention: { ...base.retention, [key]: badValue },
  }));

const configArb: fc.Arbitrary<PlatformConfigInput> = fc.oneof(
  { weight: 3, arbitrary: validConfigArb },
  { weight: 3, arbitrary: randomConfigArb },
  { weight: 2, arbitrary: mutatedScalarArb },
  { weight: 2, arbitrary: mutatedRetentionArb },
);

describe("Property 25: Policy konfigurasi selalu menjaga invariant", () => {
  it("accepts a config iff every activation invariant holds, and returns a frozen, value-identical config when valid", () => {
    fc.assert(
      fc.property(configArb, (candidate) => {
        const expectedValid = invariantsHold(candidate);
        const result = validatePlatformConfig(candidate);

        // Core property: activation decision is exactly the invariant conjunction.
        expect(result.valid).toBe(expectedValid);

        if (result.valid) {
          // Accepted config carries the same values and is immutable (Req 16.5).
          expect(result.config.minBasePriceIdr).toBe(candidate.minBasePriceIdr);
          expect(result.config.maxBasePriceIdr).toBe(candidate.maxBasePriceIdr);
          expect(result.config.cancelMinimumMs).toBe(candidate.cancelMinimumMs);
          expect(result.config.orderTimeoutMs).toBe(candidate.orderTimeoutMs);
          expect(result.config.heartbeatIntervalMs).toBe(candidate.heartbeatIntervalMs);
          expect(result.config.heartbeatTimeoutMs).toBe(candidate.heartbeatTimeoutMs);
          expect(result.config.minimumPayoutIdr).toBe(candidate.minimumPayoutIdr);
          expect(Object.isFrozen(result.config)).toBe(true);
          expect(Object.isFrozen(result.config.retention)).toBe(true);

          // assertValidPlatformConfig agrees and never throws on a valid config.
          expect(() => assertValidPlatformConfig(candidate)).not.toThrow();
        } else {
          // Rejected config reports at least one concrete violation and the hard
          // assert variant throws rather than returning an unusable config.
          expect(result.violations.length).toBeGreaterThan(0);
          expect(() => assertValidPlatformConfig(candidate)).toThrow();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("accepts the shipped MVP default platform configuration", () => {
    // Sanity anchor: the seeded MVP default must satisfy every invariant.
    expect(invariantsHold(DEFAULT_PLATFORM_CONFIG)).toBe(true);
    expect(validatePlatformConfig(DEFAULT_PLATFORM_CONFIG).valid).toBe(true);
  });
});
