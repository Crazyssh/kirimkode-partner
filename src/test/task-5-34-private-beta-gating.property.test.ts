import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  decidePlutoPolicy,
  type PlutoOperation,
  type PlutoPolicyInput,
} from "@domain/task-5-3/private-beta-policy";

/**
 * Feature: partner-platform, Property 27: Private beta gating reversibel
 *
 * For all buyer, feature flag, dan allowlist, Pluto dapat ditemukan/dipesan
 * tepat ketika flag aktif dan buyer diizinkan; menonaktifkan flag menghapus
 * eligibility baru tanpa mengubah data atau lifecycle order existing.
 *
 * **Validates: Requirements 17.4, 17.6, 22.7**
 *
 * Strategy: `decidePlutoPolicy` is the single pure gate that Main consults
 * before exposing or transacting Pluto supply. The generator produces a buyer,
 * a feature flag, an allowlist (which may or may not contain the buyer), an
 * existing-order marker, and every operation kind (new discovery/purchase vs.
 * operations on an already-placed Pluto order). One property proves the whole
 * reversibility invariant by exercising the SAME input under both flag states:
 *
 *   1. NEW eligibility (discover/purchase) is granted exactly when the flag is
 *      enabled AND the buyer is allowlisted (Req 17.4); any other combination is
 *      refused with a stable, specific reason.
 *   2. Turning the flag OFF always removes new eligibility (never a new
 *      allow), and turning it back ON restores the exact prior decision — so
 *      gating is reversible, not a one-way data change (Req 17.6, 22.7).
 *   3. EXISTING-order operations (status/cancel) depend only on whether the
 *      order exists; they are invariant to the flag and allowlist, so disabling
 *      private beta never disturbs an in-flight order's lifecycle (Req 17.6).
 *   4. The decision is a pure, deterministic function that never mutates the
 *      buyer, flag, allowlist, or order inputs it is given (Req 17.6, 22.7).
 */

const NEW_OPERATIONS: readonly PlutoOperation[] = ["discover", "purchase"];
const EXISTING_OPERATIONS: readonly PlutoOperation[] = [
  "existing-order-status",
  "existing-order-cancel",
];

const operationArbitrary = fc.constantFrom<PlutoOperation>(
  ...NEW_OPERATIONS,
  ...EXISTING_OPERATIONS,
);

// A small pool of buyer references keeps collisions (buyer present/absent in the
// allowlist) frequent enough to exercise both branches densely.
const buyerRefArbitrary = fc.constantFrom(
  "buyer-a",
  "buyer-b",
  "buyer-c",
  "buyer-d",
);

const allowlistArbitrary = fc.uniqueArray(buyerRefArbitrary, { maxLength: 4 });

/**
 * Evaluate the gate for a given flag state while holding every other input
 * fixed, snapshotting the inputs first so any accidental mutation is caught.
 */
function decideWithFlag(
  base: Omit<PlutoPolicyInput, "partnerSupplyEnabled">,
  partnerSupplyEnabled: boolean,
) {
  const input: PlutoPolicyInput = { ...base, partnerSupplyEnabled };
  const allowlistBefore = [...input.allowlistedBuyerAccountRefs];
  const inputBefore = { ...input, allowlistedBuyerAccountRefs: allowlistBefore };

  const decision = decidePlutoPolicy(input);

  // Purity: the gate must not mutate the buyer, flag, allowlist, or order data.
  expect(input.buyerAccountRef).toBe(inputBefore.buyerAccountRef);
  expect(input.partnerSupplyEnabled).toBe(inputBefore.partnerSupplyEnabled);
  expect(input.existingPlutoOrder).toBe(inputBefore.existingPlutoOrder);
  expect([...input.allowlistedBuyerAccountRefs]).toEqual(allowlistBefore);

  // Determinism: a second call on the same input yields the same decision.
  expect(decidePlutoPolicy({ ...input })).toEqual(decision);

  return decision;
}

describe("Property 27: Private beta gating is reversible", () => {
  it("gates new eligibility on flag+allowlist while leaving existing orders and data untouched", () => {
    fc.assert(
      fc.property(
        operationArbitrary,
        buyerRefArbitrary,
        allowlistArbitrary,
        fc.boolean(),
        (operation, buyerAccountRef, allowlistedBuyerAccountRefs, existingPlutoOrder) => {
          const base = {
            operation,
            buyerAccountRef,
            allowlistedBuyerAccountRefs,
            existingPlutoOrder,
          } as const;

          const enabled = decideWithFlag(base, true);
          const disabled = decideWithFlag(base, false);

          const isNewOperation = NEW_OPERATIONS.includes(operation);
          const buyerAllowed = allowlistedBuyerAccountRefs.includes(buyerAccountRef);

          if (isNewOperation) {
            // (1) New eligibility is granted exactly when flag AND allowlist
            // permit it; every other case is a specific, stable refusal.
            if (buyerAllowed) {
              expect(enabled).toEqual({ allowed: true, reason: "PRIVATE_BETA_ELIGIBLE" });
            } else {
              expect(enabled).toEqual({ allowed: false, reason: "BUYER_NOT_ALLOWLISTED" });
            }

            // (2) Disabling the flag always removes new eligibility outright.
            expect(disabled).toEqual({ allowed: false, reason: "FEATURE_DISABLED" });
            expect(disabled.allowed).toBe(false);

            // Reversibility: re-enabling the flag restores the exact prior
            // decision — gating is a toggle, not a one-way change.
            expect(decideWithFlag(base, true)).toEqual(enabled);
          } else {
            // (3) Existing-order operations depend only on whether the order
            // exists; they are invariant to the flag and the allowlist, so
            // disabling private beta never disturbs an in-flight order.
            const expected = existingPlutoOrder
              ? { allowed: true, reason: "EXISTING_ORDER_OPERATION" }
              : { allowed: false, reason: "ORDER_NOT_FOUND" };
            expect(enabled).toEqual(expected);
            expect(disabled).toEqual(expected);
            expect(disabled).toEqual(enabled);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
