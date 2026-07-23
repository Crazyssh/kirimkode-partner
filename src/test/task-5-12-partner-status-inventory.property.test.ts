import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  PARTNER_STATUSES,
  PartnerStatus,
  getPartnerSupplyPolicy,
  transitionPartnerStatus,
} from "@domain/task-5-1/partner-status";
import {
  disableIdleNumber,
  InventoryCandidate,
  InventoryFilter,
  isInventoryCandidateEligible,
  MVP_CATALOG,
  selectEligibleInventory,
  Task52DomainError,
} from "@domain/task-5-2-device-inventory-pricing";

import { basePriceIdrArbitrary, partnerStatusArbitrary } from "./generators";

/**
 * Feature: partner-platform, Property 5: Status Partner mengendalikan inventory
 * tanpa merusak history. For all Partner dan urutan perubahan status valid,
 * inventory hanya dapat diaktifkan/dipilih saat status `approved`;
 * suspension/non-approved menghentikan reservasi baru tanpa mengubah order
 * terminal atau riwayat resource.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 16.4**
 */

// Only these representations may be disabled while idle (16.4 keeps the record).
const IDLE_NUMBER_STATUS = fc.constantFrom("offline" as const, "available" as const);
// A number carrying an active/terminal-bound order must never be re-selected or
// destroyed simply because the owning Partner's status changed.
const ACTIVE_NUMBER_STATUS = fc.constantFrom("reserved" as const, "busy" as const);

const REASON = fc.constantFrom(
  "risk review",
  "approved after audit",
  "reactivated",
  "policy violation",
  "resumed operations",
);

const NOW_SERVER = new Date("2024-06-01T00:00:00.000Z");
const FILTER: InventoryFilter = {
  serviceCode: MVP_CATALOG.serviceCode,
  countryCode: MVP_CATALOG.countryCode,
  operatorCode: MVP_CATALOG.operatorCode,
};

/**
 * Build an inventory candidate whose every dimension is eligible except that it
 * inherits `partnerStatus` and a specific `numberStatus`. This isolates the
 * Partner-status gate: eligibility should flip solely on `approved`.
 */
function buildCandidate(
  numberId: string,
  partnerStatus: PartnerStatus,
  numberStatus: "offline" | "available" | "reserved" | "busy" | "disabled",
  basePriceIdr: number,
): InventoryCandidate {
  return {
    numberId,
    partnerStatus,
    device: {
      type: "simulator",
      status: "online",
      lastSeenAt: NOW_SERVER,
      capabilities: { sms: true, notification: false, resend: false, operator: false, slots: 1 },
    },
    number: {
      status: numberStatus,
      enabled: true,
      countryCode: MVP_CATALOG.countryCode,
      operatorCode: MVP_CATALOG.operatorCode,
      hasActiveOrder: numberStatus === "reserved" || numberStatus === "busy",
    },
    offer: {
      serviceCode: MVP_CATALOG.serviceCode,
      countryCode: MVP_CATALOG.countryCode,
      operatorCode: MVP_CATALOG.operatorCode,
      basePriceIdr,
      status: "active",
    },
  };
}

describe("Property 5: Partner status controls inventory without destroying history", () => {
  it("only approved partners can activate/select inventory and status changes preserve history", () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        fc.uuid(),
        fc.array(partnerStatusArbitrary, { maxLength: 8 }),
        REASON,
        IDLE_NUMBER_STATUS,
        ACTIVE_NUMBER_STATUS,
        basePriceIdrArbitrary,
        (partnerId, actorRef, numberId, candidateNextStatuses, reason, idleStatus, activeStatus, basePriceIdr) => {
          // Drive the Partner state machine through a generated sequence of
          // candidate transitions, always starting from `pending`. Only edges the
          // domain accepts advance the status; rejected edges leave state intact.
          let current: PartnerStatus = "pending";
          for (const nextStatus of candidateNextStatuses) {
            const before = current;
            const result = transitionPartnerStatus({
              partnerId,
              currentStatus: current,
              nextStatus,
              actorRef,
              reason,
              occurredAtEpochMs: 1_800_000_000_000,
            });

            if (result.changed) {
              // A valid transition records old and new status in the audit trail
              // (Requirement 3.5 audit descriptor) and never loses the prior value.
              expect(result.status).toBe(nextStatus);
              expect(result.audit.safeMetadata.previousStatus).toBe(before);
              expect(result.audit.safeMetadata.nextStatus).toBe(nextStatus);
              current = result.status;
            } else {
              // Illegal edges are rejected deterministically and do not mutate status.
              expect(result.code).toBe("INVALID_PARTNER_TRANSITION");
            }

            // The resulting status is always a member of the supported set (3.1).
            expect(PARTNER_STATUSES).toContain(current);
          }

          const approved = current === "approved";

          // Requirements 3.1, 3.2, 3.3, 3.4: only approved enables inventory
          // activation and new reservations; every other status halts new supply
          // while still preserving completed order results.
          const policy = getPartnerSupplyPolicy(current);
          expect(policy.canActivateInventory).toBe(approved);
          expect(policy.canReserveNewOrder).toBe(approved);
          expect(policy.preserveExistingOrderResults).toBe(true);

          // An otherwise fully-eligible AVAILABLE number is selectable exactly when
          // the Partner is approved (3.2/3.3 + Requirement 9.1 eligibility gate).
          const availableCandidate = buildCandidate(numberId, current, "available", basePriceIdr);
          const availableSnapshot = JSON.stringify(availableCandidate);
          expect(isInventoryCandidateEligible(availableCandidate, FILTER, NOW_SERVER)).toBe(approved);
          expect(selectEligibleInventory([availableCandidate], FILTER, NOW_SERVER) !== null).toBe(approved);
          // Selection/eligibility is a pure read: it never mutates candidate state.
          expect(JSON.stringify(availableCandidate)).toBe(availableSnapshot);

          // Requirement 3.3/3.4: a number bound to an active order (reserved/busy)
          // is never re-selected regardless of Partner status, so suspending or
          // rejecting a Partner cannot disturb an in-flight/terminal order.
          const activeCandidate = buildCandidate(numberId, current, activeStatus, basePriceIdr);
          const activeSnapshot = JSON.stringify(activeCandidate);
          expect(isInventoryCandidateEligible(activeCandidate, FILTER, NOW_SERVER)).toBe(false);
          expect(selectEligibleInventory([activeCandidate], FILTER, NOW_SERVER)).toBeNull();
          expect(JSON.stringify(activeCandidate)).toBe(activeSnapshot);

          // Requirement 16.4: disabling risky idle inventory keeps the record as
          // `disabled` (not deleted), while active reserved/busy numbers are guarded
          // so their history cannot be destroyed.
          expect(disableIdleNumber(idleStatus)).toBe("disabled");
          expect(() => disableIdleNumber(activeStatus)).toThrow(Task52DomainError);
        },
      ),
      { numRuns: 100 },
    );
  });
});
