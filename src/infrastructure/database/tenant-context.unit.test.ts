import { describe, expect, it } from "vitest";

import {
  assertTenantContext,
  createTenantContext,
  InvalidTenantContextError,
} from "./tenant-context";

const VALID = "11111111-1111-4111-8111-111111111111";

// **Validates: Requirements 4.2, 4.3, 20.1**
describe("tenant context", () => {
  it("creates a frozen context from a valid UUID partnerId", () => {
    const tenant = createTenantContext(VALID);
    expect(tenant.partnerId).toBe(VALID);
    expect(Object.isFrozen(tenant)).toBe(true);
  });

  it("rejects a non-UUID partnerId", () => {
    expect(() => createTenantContext("")).toThrow(InvalidTenantContextError);
    expect(() => createTenantContext("not-a-uuid")).toThrow(
      InvalidTenantContextError,
    );
    expect(() => createTenantContext("1; DROP TABLE partners")).toThrow(
      InvalidTenantContextError,
    );
  });

  it("asserts a valid context and rejects malformed ones", () => {
    expect(() => assertTenantContext(createTenantContext(VALID))).not.toThrow();
    expect(() => assertTenantContext(null)).toThrow(InvalidTenantContextError);
    expect(() =>
      assertTenantContext({ partnerId: "bad" }),
    ).toThrow(InvalidTenantContextError);
  });
});
