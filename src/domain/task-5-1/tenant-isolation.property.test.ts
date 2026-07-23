import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  authorizeTenant,
  hasTenantPermission,
  TENANT_PERMISSION_MATRIX,
  type PartnerMemberRole,
  type TenantOperation,
  type TenantPrincipal,
  type TenantResource,
} from "./tenant-policy";

// ---------------------------------------------------------------------------
// Feature: partner-platform, Property 4: Isolasi tenant dan matriks izin.
//
// For all kombinasi session tenant, role, operasi, dan resource, hasil operasi
// hanya dapat memuat/mengubah resource dengan `partnerId` dari session serta
// hanya bila model izin mengizinkan; ID tenant lain menghasilkan respons
// generik dan state tetap.
//
// Validates: Requirements 2.4, 4.2, 4.3, 4.4
// ---------------------------------------------------------------------------

const roleArbitrary: fc.Arbitrary<PartnerMemberRole> = fc.constantFrom(
  "owner",
  "member",
);

const operationArbitrary: fc.Arbitrary<TenantOperation> = fc.constantFrom(
  "view_operational",
  "manage_inventory",
  "manage_members",
  "manage_api_keys",
  "manage_payout_destination",
  "request_payout",
);

// Two distinct tenant IDs let us exercise same-tenant and cross-tenant access
// without relying on random UUID collisions.
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

const tenantIdArbitrary: fc.Arbitrary<string> = fc.constantFrom(
  TENANT_A,
  TENANT_B,
);

const principalArbitrary: fc.Arbitrary<TenantPrincipal> = fc.record({
  memberId: fc.uuid(),
  partnerId: tenantIdArbitrary,
  role: roleArbitrary,
});

// Resource is either missing (null) or owned by some tenant. A sentinel state
// value lets us prove no mutation leaks through a denied call.
const resourceArbitrary: fc.Arbitrary<TenantResource | null> = fc.option(
  fc.record({ partnerId: tenantIdArbitrary }),
  { nil: null },
);

/**
 * Pure "operation" under test: it mutates the resource state only when the
 * tenant guard allows the call. This mirrors how application services must
 * gate every mutation behind `authorizeTenant`.
 */
function runGuardedMutation(
  principal: TenantPrincipal,
  resource: TenantResource | null,
  operation: TenantOperation,
  state: { value: number },
): { code: "OK" | "RESOURCE_NOT_FOUND" | "FORBIDDEN"; mutated: boolean } {
  const decision = authorizeTenant(principal, resource, operation);
  if (!decision.allowed) {
    return { code: decision.code, mutated: false };
  }
  state.value += 1;
  return { code: "OK", mutated: true };
}

describe("Property 4: tenant isolation and permission matrix", () => {
  it("only loads/mutates same-tenant resources when the matrix allows; cross-tenant is generic and state stays put", () => {
    fc.assert(
      fc.property(
        principalArbitrary,
        resourceArbitrary,
        operationArbitrary,
        (principal, resource, operation) => {
          const initialState = 41;
          const state = { value: initialState };
          const result = runGuardedMutation(
            principal,
            resource,
            operation,
            state,
          );

          const sameTenant =
            resource !== null && resource.partnerId === principal.partnerId;
          const permitted = hasTenantPermission(principal.role, operation);

          if (!sameTenant) {
            // Requirements 2.4, 4.2, 4.3: cross-tenant or missing resources are
            // indistinguishable and never mutate state. The response is the
            // generic RESOURCE_NOT_FOUND regardless of role/operation, so no
            // cross-tenant existence or permission detail can leak.
            expect(result.code).toBe("RESOURCE_NOT_FOUND");
            expect(result.mutated).toBe(false);
            expect(state.value).toBe(initialState);

            // The generic response must not depend on whether the same
            // role/operation would have been permitted within its own tenant.
            const asOwner = authorizeTenant(
              { ...principal, role: "owner" },
              resource,
              operation,
            );
            const asMember = authorizeTenant(
              { ...principal, role: "member" },
              resource,
              operation,
            );
            expect(asOwner.allowed).toBe(false);
            expect(asMember.allowed).toBe(false);
            if (!asOwner.allowed) {
              expect(asOwner.code).toBe("RESOURCE_NOT_FOUND");
            }
            if (!asMember.allowed) {
              expect(asMember.code).toBe("RESOURCE_NOT_FOUND");
            }
            return;
          }

          if (!permitted) {
            // Requirement 4.4: sensitive operations are restricted to
            // authorized roles; denial does not change state.
            expect(result.code).toBe("FORBIDDEN");
            expect(result.mutated).toBe(false);
            expect(state.value).toBe(initialState);
            return;
          }

          // Same tenant + permitted role: the decision follows the frozen
          // matrix exactly and the operation runs exactly once.
          expect(permitted).toBe(TENANT_PERMISSION_MATRIX[principal.role][operation]);
          expect(result.code).toBe("OK");
          expect(result.mutated).toBe(true);
          expect(state.value).toBe(initialState + 1);
        },
      ),
      { numRuns: 100 },
    );
  });
});
