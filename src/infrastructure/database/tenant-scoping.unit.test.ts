import { describe, expect, it } from "vitest";

import {
  ConcurrencyConflictError,
  ResourceNotFoundError,
} from "./repository-errors";
import { createTenantContext } from "./tenant-context";
import {
  assertAffectedExactlyOne,
  casWhere,
  nextVersion,
  scopedIdWhere,
  scopedWhere,
  withVersionBump,
} from "./tenant-scoping";

const TENANT = createTenantContext("11111111-1111-4111-8111-111111111111");
const OTHER = "22222222-2222-4222-8222-222222222222";

// **Validates: Requirements 4.2, 4.3, 20.1**
describe("tenant scoping helpers", () => {
  it("folds the tenant partnerId into a where predicate", () => {
    expect(scopedWhere(TENANT, { status: "RESERVED" })).toEqual({
      status: "RESERVED",
      partnerId: TENANT.partnerId,
    });
  });

  it("overrides any caller-supplied partnerId with the trusted context value", () => {
    const where = scopedWhere(TENANT, { partnerId: OTHER });
    expect(where.partnerId).toBe(TENANT.partnerId);
  });

  it("pins a row id together with the tenant partnerId", () => {
    expect(scopedIdWhere(TENANT, "order-1")).toEqual({
      id: "order-1",
      partnerId: TENANT.partnerId,
    });
  });

  it("builds a compare-and-set predicate with id, tenant, and version", () => {
    expect(casWhere(TENANT, "order-1", 3)).toEqual({
      id: "order-1",
      partnerId: TENANT.partnerId,
      version: 3,
    });
  });

  it("bumps the version monotonically and controls the version field", () => {
    expect(nextVersion(3)).toBe(4);
    expect(withVersionBump({ status: "SUCCESS", version: 99 }, 3)).toEqual({
      status: "SUCCESS",
      version: 4,
    });
  });

  it("rejects non-positive or unsafe versions", () => {
    expect(() => nextVersion(0)).toThrow();
    expect(() => casWhere(TENANT, "order-1", -1)).toThrow();
    expect(() => casWhere(TENANT, "order-1", 1.5)).toThrow();
  });
});

// **Validates: Requirements 4.2, 4.3**
describe("assertAffectedExactlyOne", () => {
  it("accepts exactly one affected row", () => {
    expect(() =>
      assertAffectedExactlyOne(1, { compareAndSet: false }),
    ).not.toThrow();
  });

  it("maps zero rows to RESOURCE_NOT_FOUND for a plain scoped mutation", () => {
    expect(() =>
      assertAffectedExactlyOne(0, { compareAndSet: false }),
    ).toThrow(ResourceNotFoundError);
  });

  it("maps zero rows to a retryable concurrency conflict for compare-and-set", () => {
    expect(() =>
      assertAffectedExactlyOne(0, { compareAndSet: true }),
    ).toThrow(ConcurrencyConflictError);
  });

  it("rejects an impossible multi-row result", () => {
    expect(() =>
      assertAffectedExactlyOne(2, { compareAndSet: false }),
    ).toThrow(/affected 2 rows/);
  });
});
