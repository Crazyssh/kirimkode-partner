import { describe, expect, it } from "vitest";

import { PartnerEconomicsError } from "./errors";
import {
  findExclusionConflict,
  HEROSMS_REFERENCE_EXCLUSIONS,
  isServiceSellable,
  type ExclusionPair,
} from "./service-exclusion";

describe("HEROSMS_REFERENCE_EXCLUSIONS", () => {
  it("is frozen and encodes the documented HeroSMS examples", () => {
    expect(Object.isFrozen(HEROSMS_REFERENCE_EXCLUSIONS)).toBe(true);
    // Global wa<->gr plus the four country-scoped pairs.
    expect(HEROSMS_REFERENCE_EXCLUSIONS).toContainEqual({ a: "wa", b: "gr" });
    expect(HEROSMS_REFERENCE_EXCLUSIONS).toContainEqual({
      a: "uber",
      b: "yandexgo",
      countryCode: "KZ",
    });
    expect(HEROSMS_REFERENCE_EXCLUSIONS).toContainEqual({
      a: "novaposhta",
      b: "viber",
      countryCode: "UA",
    });
    expect(HEROSMS_REFERENCE_EXCLUSIONS).toContainEqual({
      a: "novaposhta",
      b: "viber",
      countryCode: "PL",
    });
    expect(HEROSMS_REFERENCE_EXCLUSIONS).toContainEqual({
      a: "wa",
      b: "wa_business",
      countryCode: "NL",
    });
  });
});

describe("findExclusionConflict — global pairs", () => {
  it("blocks a global pair regardless of country", () => {
    for (const countryCode of ["ID", "US", "KZ"]) {
      expect(
        findExclusionConflict({
          candidateService: "gr",
          soldServices: ["wa"],
          countryCode,
        }),
      ).toEqual({ blockedBy: "wa" });
    }
  });

  it("is symmetric: the candidate on either side of a<->b is blocked", () => {
    // wa is sold -> gr blocked.
    expect(
      findExclusionConflict({
        candidateService: "gr",
        soldServices: ["wa"],
        countryCode: "ID",
      }),
    ).toEqual({ blockedBy: "wa" });
    // gr is sold -> wa blocked.
    expect(
      findExclusionConflict({
        candidateService: "wa",
        soldServices: ["gr"],
        countryCode: "ID",
      }),
    ).toEqual({ blockedBy: "gr" });
  });
});

describe("findExclusionConflict — country-scoped pairs", () => {
  it("blocks a country-scoped pair inside its country", () => {
    expect(
      findExclusionConflict({
        candidateService: "yandexgo",
        soldServices: ["uber"],
        countryCode: "KZ",
      }),
    ).toEqual({ blockedBy: "uber" });
    // Symmetric direction inside the same country.
    expect(
      findExclusionConflict({
        candidateService: "uber",
        soldServices: ["yandexgo"],
        countryCode: "KZ",
      }),
    ).toEqual({ blockedBy: "yandexgo" });
  });

  it("does not block the same pair in a different country", () => {
    expect(
      findExclusionConflict({
        candidateService: "yandexgo",
        soldServices: ["uber"],
        countryCode: "RU",
      }),
    ).toBeNull();
  });

  it("applies the UA and PL NovaPoshta<->Viber pairs only in their countries", () => {
    for (const countryCode of ["UA", "PL"]) {
      expect(
        findExclusionConflict({
          candidateService: "viber",
          soldServices: ["novaposhta"],
          countryCode,
        }),
      ).toEqual({ blockedBy: "novaposhta" });
    }
    expect(
      findExclusionConflict({
        candidateService: "viber",
        soldServices: ["novaposhta"],
        countryCode: "DE",
      }),
    ).toBeNull();
  });
});

describe("findExclusionConflict — no conflict", () => {
  it("returns null when no pair relates the candidate to any sold service", () => {
    expect(
      findExclusionConflict({
        candidateService: "tg",
        soldServices: ["wa", "uber", "viber"],
        countryCode: "ID",
      }),
    ).toBeNull();
  });

  it("returns null for an empty sold list", () => {
    expect(
      findExclusionConflict({
        candidateService: "gr",
        soldServices: [],
        countryCode: "ID",
      }),
    ).toBeNull();
  });

  it("ignores empty/whitespace sold entries", () => {
    expect(
      findExclusionConflict({
        candidateService: "gr",
        soldServices: ["", "   "],
        countryCode: "ID",
      }),
    ).toBeNull();
  });
});

describe("findExclusionConflict — case-insensitive normalization", () => {
  it("matches regardless of candidate/sold casing and surrounding space", () => {
    expect(
      findExclusionConflict({
        candidateService: "  GR ",
        soldServices: ["WA"],
        countryCode: "id",
      }),
    ).toEqual({ blockedBy: "wa" });
  });

  it("normalizes country casing for scoped pairs", () => {
    expect(
      findExclusionConflict({
        candidateService: "uber",
        soldServices: ["yandexgo"],
        countryCode: "kz",
      }),
    ).toEqual({ blockedBy: "yandexgo" });
  });
});

describe("findExclusionConflict — selection order and custom tables", () => {
  it("returns the first conflicting sold service in list order", () => {
    // Both gr and wa_business conflict with wa in NL; gr comes first.
    expect(
      findExclusionConflict({
        candidateService: "wa",
        soldServices: ["tg", "gr", "wa_business"],
        countryCode: "NL",
      }),
    ).toEqual({ blockedBy: "gr" });
  });

  it("honours a caller-supplied exclusions table over the default", () => {
    const custom: readonly ExclusionPair[] = [{ a: "foo", b: "bar" }];
    // wa<->gr is not in the custom table -> no conflict.
    expect(
      findExclusionConflict({
        candidateService: "gr",
        soldServices: ["wa"],
        countryCode: "ID",
        exclusions: custom,
      }),
    ).toBeNull();
    // The custom pair applies.
    expect(
      findExclusionConflict({
        candidateService: "foo",
        soldServices: ["bar"],
        countryCode: "ID",
        exclusions: custom,
      }),
    ).toEqual({ blockedBy: "bar" });
  });
});

describe("isServiceSellable", () => {
  it("is the negation of a conflict existing", () => {
    expect(
      isServiceSellable({
        candidateService: "gr",
        soldServices: ["wa"],
        countryCode: "ID",
      }),
    ).toBe(false);
    expect(
      isServiceSellable({
        candidateService: "tg",
        soldServices: ["wa"],
        countryCode: "ID",
      }),
    ).toBe(true);
  });

  it("throws on empty candidateService or countryCode", () => {
    expect(() =>
      isServiceSellable({
        candidateService: "",
        soldServices: ["wa"],
        countryCode: "ID",
      }),
    ).toThrow(PartnerEconomicsError);
    expect(() =>
      isServiceSellable({
        candidateService: "gr",
        soldServices: ["wa"],
        countryCode: "   ",
      }),
    ).toThrow(PartnerEconomicsError);
  });
});

describe("findExclusionConflict — input validation", () => {
  it("throws PartnerEconomicsError with INVALID_INPUT on empty candidate", () => {
    try {
      findExclusionConflict({
        candidateService: "  ",
        soldServices: ["wa"],
        countryCode: "ID",
      });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PartnerEconomicsError);
      expect((error as PartnerEconomicsError).code).toBe("INVALID_INPUT");
    }
  });
});
