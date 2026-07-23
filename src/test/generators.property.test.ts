import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { indonesianPhoneArbitrary, partnerIdentityArbitrary } from "./generators";

// **Validates: Requirements 1.1, 20.2**
describe("domain generators", () => {
  it("only emits canonical Indonesian phone numbers", () => {
    fc.assert(
      fc.property(indonesianPhoneArbitrary, (phone) => {
        expect(phone).toMatch(/^\+628[1-9]\d{8,11}$/);
      }),
      { numRuns: 100 },
    );
  });

  it("emits isolated identities with stable domain status values", () => {
    fc.assert(
      fc.property(partnerIdentityArbitrary, (identity) => {
        expect(identity.id).toMatch(/^[0-9a-f-]{36}$/i);
        expect(["pending", "approved", "suspended", "rejected"]).toContain(
          identity.status,
        );
      }),
      { numRuns: 100 },
    );
  });
});
