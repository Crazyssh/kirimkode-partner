import { describe, expect, it } from "vitest";

import {
  PartnerEconomicsError,
  type PartnerEconomicsErrorCode,
} from "./errors";
import {
  FROZEN_RELEASE_MS,
  frozenReleaseAt,
  HEROSMS_REFERENCE_PENALTY_LADDER_USD,
  isRetentionSatisfied,
  NUMBER_RETENTION_DAYS,
  NUMBER_RETENTION_MS,
  resolveResalePenalty,
  type ResalePenalty,
} from "./resale-policy";

// Item 5 — anti-resale: 2-month retention + fine/freeze ladder.
// Reference: .agents/RESEARCH-HEROSMS-PARTNERS.md ("Anti-resale", "Denda resale").

/** Assert that `fn` throws a PartnerEconomicsError carrying exactly `code`. */
function expectErrorCode(fn: () => unknown, code: PartnerEconomicsErrorCode): void {
  expect(fn).toThrow(PartnerEconomicsError);
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(PartnerEconomicsError);
  expect((thrown as PartnerEconomicsError).code).toBe(code);
}

describe("resale-policy constants", () => {
  it("encodes the 60-day retention window consistently in days and ms", () => {
    expect(NUMBER_RETENTION_DAYS).toBe(60);
    expect(NUMBER_RETENTION_MS).toBe(60 * 24 * 60 * 60 * 1000);
    expect(NUMBER_RETENTION_MS).toBe(NUMBER_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  });

  it("models the 6-month freeze release as 182 days", () => {
    expect(FROZEN_RELEASE_MS).toBe(182 * 24 * 60 * 60 * 1000);
  });

  it("exposes the HeroSMS USD reference ladder for offenses 1..3 as frozen data", () => {
    expect(HEROSMS_REFERENCE_PENALTY_LADDER_USD).toEqual([
      { offense: 1, fineUsd: 30, frozenUsd: 60 },
      { offense: 2, fineUsd: 60, frozenUsd: 120 },
      { offense: 3, fineUsd: 100, frozenUsd: 200 },
    ]);
    expect(Object.isFrozen(HEROSMS_REFERENCE_PENALTY_LADDER_USD)).toBe(true);
    for (const rung of HEROSMS_REFERENCE_PENALTY_LADDER_USD) {
      expect(Object.isFrozen(rung)).toBe(true);
    }
  });
});

describe("resolveResalePenalty", () => {
  it("maps offenses 1..3 to the fine/freeze ladder", () => {
    expect(resolveResalePenalty(1)).toEqual({
      kind: "fine",
      offense: 1,
      fineUsd: 30,
      frozenUsd: 60,
    });
    expect(resolveResalePenalty(2)).toEqual({
      kind: "fine",
      offense: 2,
      fineUsd: 60,
      frozenUsd: 120,
    });
    expect(resolveResalePenalty(3)).toEqual({
      kind: "fine",
      offense: 3,
      fineUsd: 100,
      frozenUsd: 200,
    });
  });

  it("mirrors the reference ladder amounts exactly", () => {
    for (const rung of HEROSMS_REFERENCE_PENALTY_LADDER_USD) {
      const penalty = resolveResalePenalty(rung.offense);
      expect(penalty.kind).toBe("fine");
      if (penalty.kind === "fine") {
        expect(penalty.fineUsd).toBe(rung.fineUsd);
        expect(penalty.frozenUsd).toBe(rung.frozenUsd);
      }
    }
  });

  it("escalates the 4th and later offenses to permanent disconnect", () => {
    const fourth = resolveResalePenalty(4);
    expect(fourth).toEqual({ kind: "permanent_disconnect", offense: 4 });

    const tenth = resolveResalePenalty(10);
    expect(tenth).toEqual({ kind: "permanent_disconnect", offense: 10 });
    // A permanent disconnect never carries fine amounts.
    expect("fineUsd" in tenth).toBe(false);
  });

  it("returns a frozen penalty object", () => {
    const fine: ResalePenalty = resolveResalePenalty(1);
    const disconnect: ResalePenalty = resolveResalePenalty(4);
    expect(Object.isFrozen(fine)).toBe(true);
    expect(Object.isFrozen(disconnect)).toBe(true);
  });

  it("rejects non-integer, zero, negative and NaN offense counts", () => {
    expectErrorCode(() => resolveResalePenalty(0), "INVALID_OFFENSE");
    expectErrorCode(() => resolveResalePenalty(-1), "INVALID_OFFENSE");
    expectErrorCode(() => resolveResalePenalty(1.5), "INVALID_OFFENSE");
    expectErrorCode(() => resolveResalePenalty(Number.NaN), "INVALID_OFFENSE");
    expectErrorCode(
      () => resolveResalePenalty(Number.POSITIVE_INFINITY),
      "INVALID_OFFENSE",
    );
  });
});

describe("isRetentionSatisfied", () => {
  const lastUsedAt = new Date("2026-01-01T00:00:00.000Z");

  it("is satisfied exactly at the 60-day boundary (elapsed === retention)", () => {
    const exactly = new Date(lastUsedAt.getTime() + NUMBER_RETENTION_MS);
    expect(isRetentionSatisfied({ lastUsedAt, now: exactly })).toBe(true);
  });

  it("is not satisfied one millisecond before the boundary", () => {
    const oneMsShort = new Date(lastUsedAt.getTime() + NUMBER_RETENTION_MS - 1);
    expect(isRetentionSatisfied({ lastUsedAt, now: oneMsShort })).toBe(false);
  });

  it("is satisfied after the window and unsatisfied at time zero elapsed", () => {
    const wellAfter = new Date(lastUsedAt.getTime() + NUMBER_RETENTION_MS + 5_000);
    expect(isRetentionSatisfied({ lastUsedAt, now: wellAfter })).toBe(true);
    expect(isRetentionSatisfied({ lastUsedAt, now: new Date(lastUsedAt) })).toBe(
      false,
    );
  });

  it("honours a custom retentionMs override", () => {
    const now = new Date(lastUsedAt.getTime() + 10_000);
    expect(isRetentionSatisfied({ lastUsedAt, now, retentionMs: 10_000 })).toBe(
      true,
    );
    expect(isRetentionSatisfied({ lastUsedAt, now, retentionMs: 10_001 })).toBe(
      false,
    );
  });

  it("throws INVALID_INPUT when lastUsedAt is after now", () => {
    const now = new Date(lastUsedAt.getTime() - 1);
    expectErrorCode(
      () => isRetentionSatisfied({ lastUsedAt, now }),
      "INVALID_INPUT",
    );
  });

  it("throws INVALID_INPUT for invalid timestamps", () => {
    expectErrorCode(
      () =>
        isRetentionSatisfied({ lastUsedAt: new Date(Number.NaN), now: lastUsedAt }),
      "INVALID_INPUT",
    );
    expectErrorCode(
      () =>
        isRetentionSatisfied({ lastUsedAt, now: new Date(Number.NaN) }),
      "INVALID_INPUT",
    );
  });

  it("throws INVALID_INPUT for an invalid retentionMs override", () => {
    const now = new Date(lastUsedAt.getTime() + 1_000);
    expectErrorCode(
      () => isRetentionSatisfied({ lastUsedAt, now, retentionMs: -1 }),
      "INVALID_INPUT",
    );
    expectErrorCode(
      () => isRetentionSatisfied({ lastUsedAt, now, retentionMs: 1.5 }),
      "INVALID_INPUT",
    );
  });
});

describe("frozenReleaseAt", () => {
  const lastPenaltyAt = new Date("2026-03-01T00:00:00.000Z");

  it("adds the 6-month (182-day) default release delay", () => {
    const release = frozenReleaseAt(lastPenaltyAt);
    expect(release.getTime()).toBe(lastPenaltyAt.getTime() + FROZEN_RELEASE_MS);
  });

  it("honours a custom releaseMs and returns a fresh frozen Date", () => {
    const release = frozenReleaseAt(lastPenaltyAt, 1_000);
    expect(release.getTime()).toBe(lastPenaltyAt.getTime() + 1_000);
    expect(release).not.toBe(lastPenaltyAt);
    expect(Object.isFrozen(release)).toBe(true);
    // The input Date is never mutated.
    expect(lastPenaltyAt.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("supports a zero release delay", () => {
    const release = frozenReleaseAt(lastPenaltyAt, 0);
    expect(release.getTime()).toBe(lastPenaltyAt.getTime());
  });

  it("throws INVALID_INPUT for an invalid lastPenaltyAt", () => {
    expectErrorCode(() => frozenReleaseAt(new Date(Number.NaN)), "INVALID_INPUT");
  });

  it("throws INVALID_INPUT for an invalid releaseMs", () => {
    expectErrorCode(() => frozenReleaseAt(lastPenaltyAt, -1), "INVALID_INPUT");
    expectErrorCode(() => frozenReleaseAt(lastPenaltyAt, 2.5), "INVALID_INPUT");
  });
});
