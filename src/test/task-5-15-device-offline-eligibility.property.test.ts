import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  DeviceState,
  DeviceStatus,
  effectiveDeviceStatus,
  InventoryCandidate,
  InventoryFilter,
  isDeviceLive,
  isInventoryCandidateEligible,
  MVP_CATALOG,
  MVP_HEARTBEAT_TIMEOUT_SECONDS,
  NumberStatus,
  reconcileNumberAvailability,
  selectEligibleInventory,
} from "@domain/task-5-2-device-inventory-pricing";

import { utcInstantArbitrary } from "./generators";

/**
 * Feature: partner-platform, Property 8: Device offline meniadakan eligibility.
 *
 * For all himpunan Device dan PartnerNumber, setiap nomor dari Device
 * offline/disabled tidak terdapat dalam hasil eligible inventory, dan nomor
 * offline hanya pulih menjadi available bila enabled, tanpa order aktif, serta
 * offer aktif.
 *
 * **Validates: Requirements 6.3**
 *
 * Strategy: generate a Device-number-offer-order graph where each candidate's
 * device liveness is driven by an age around the 90s heartbeat boundary (with
 * null/boundary instants injected). Prove that (a) any candidate whose device
 * is effectively offline or disabled is never eligible and is never chosen by
 * the deterministic selector, that (b) selection is a pure read, and that (c)
 * an offline number recovers to `available` exactly when it is enabled, has an
 * active offer, has no active order, and its device is live again.
 */

const THRESHOLD_MS = MVP_HEARTBEAT_TIMEOUT_SECONDS * 1_000;

const FILTER: InventoryFilter = {
  serviceCode: MVP_CATALOG.serviceCode,
  countryCode: MVP_CATALOG.countryCode,
  operatorCode: MVP_CATALOG.operatorCode,
};

const partnerStatusArbitrary = fc.constantFrom(
  "pending" as const,
  "approved" as const,
  "suspended" as const,
  "rejected" as const,
);

const deviceStatusArbitrary = fc.constantFrom<DeviceStatus>(
  "offline",
  "online",
  "disabled",
);

const numberStatusArbitrary = fc.constantFrom<NumberStatus>(
  "offline",
  "available",
  "reserved",
  "busy",
  "disabled",
);

// Ages around the 90s liveness boundary so the exact `<= 90_000` edge — the
// online/offline flip that gates eligibility — is always exercised.
const ageMsArbitrary = fc.oneof(
  fc.integer({ min: 0, max: 4 * THRESHOLD_MS }),
  fc.constantFrom(0, THRESHOLD_MS - 1, THRESHOLD_MS, THRESHOLD_MS + 1, 2 * THRESHOLD_MS),
);

// A dimension that is usually the MVP catalog value but occasionally drifts, so
// eligibility is not trivially always-true or always-false.
const operatorDimensionArbitrary = fc.constantFrom(MVP_CATALOG.operatorCode, "xl");

interface CandidateSpec {
  readonly numberId: string;
  readonly partnerStatus: "pending" | "approved" | "suspended" | "rejected";
  readonly deviceStatus: DeviceStatus;
  readonly ageMs: number;
  readonly hasLastSeen: boolean;
  readonly sms: boolean;
  readonly numberStatus: NumberStatus;
  readonly enabled: boolean;
  readonly hasActiveOrder: boolean;
  readonly offerActive: boolean;
  readonly operatorCode: string;
}

const candidateSpecArbitrary: fc.Arbitrary<CandidateSpec> = fc.record({
  numberId: fc.uuid(),
  partnerStatus: partnerStatusArbitrary,
  deviceStatus: deviceStatusArbitrary,
  ageMs: ageMsArbitrary,
  hasLastSeen: fc.boolean(),
  sms: fc.boolean(),
  numberStatus: numberStatusArbitrary,
  enabled: fc.boolean(),
  hasActiveOrder: fc.boolean(),
  offerActive: fc.boolean(),
  operatorCode: operatorDimensionArbitrary,
});

function buildDevice(spec: CandidateSpec, nowServer: Date): DeviceState {
  return {
    type: "simulator",
    status: spec.deviceStatus,
    lastSeenAt: spec.hasLastSeen ? new Date(nowServer.getTime() - spec.ageMs) : null,
    capabilities: {
      sms: spec.sms,
      notification: false,
      resend: false,
      operator: false,
      slots: 1,
    },
  };
}

function buildCandidate(spec: CandidateSpec, nowServer: Date): InventoryCandidate {
  return {
    numberId: spec.numberId,
    partnerStatus: spec.partnerStatus,
    device: buildDevice(spec, nowServer),
    number: {
      status: spec.numberStatus,
      enabled: spec.enabled,
      countryCode: MVP_CATALOG.countryCode,
      operatorCode: spec.operatorCode,
      hasActiveOrder: spec.hasActiveOrder,
    },
    offer: {
      serviceCode: MVP_CATALOG.serviceCode,
      countryCode: MVP_CATALOG.countryCode,
      operatorCode: spec.operatorCode,
      basePriceIdr: 1_000,
      status: spec.offerActive ? "active" : "inactive",
    },
  };
}

describe("Property 8: Device offline meniadakan eligibility", () => {
  it("excludes every number of an offline/disabled device and recovers offline numbers only when live, enabled, offered, and idle", () => {
    fc.assert(
      fc.property(
        // The Device-number-offer-order graph and a single authoritative server clock.
        fc.array(candidateSpecArbitrary, { minLength: 1, maxLength: 8 }),
        utcInstantArbitrary,
        // A dedicated offline-number recovery scenario.
        deviceStatusArbitrary,
        ageMsArbitrary,
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (
          specs,
          nowServer,
          recoveryDeviceStatus,
          recoveryAgeMs,
          recoveryHasLastSeen,
          recoveryEnabled,
          recoveryHasOffer,
          recoveryHasOrder,
        ) => {
          const candidates = specs.map((spec) => buildCandidate(spec, nowServer));
          const snapshot = JSON.stringify(candidates);

          for (const candidate of candidates) {
            const effective = effectiveDeviceStatus(candidate.device, nowServer);
            const eligible = isInventoryCandidateEligible(candidate, FILTER, nowServer);

            // Requirement 6.3: while a device is offline or disabled, none of its
            // numbers may appear in available inventory — regardless of number,
            // offer, or order state.
            if (effective !== "online") {
              expect(eligible).toBe(false);
            }
            // Contrapositive: eligibility implies a live (online) device.
            if (eligible) {
              expect(effective).toBe("online");
            }
          }

          // The deterministic selector can only ever return an eligible member,
          // so it never surfaces a number whose device is offline/disabled.
          const selected = selectEligibleInventory(candidates, FILTER, nowServer);
          if (selected !== null) {
            expect(isInventoryCandidateEligible(selected, FILTER, nowServer)).toBe(true);
            expect(effectiveDeviceStatus(selected.device, nowServer)).toBe("online");
          }

          // Eligibility and selection are pure reads: candidate state is untouched.
          expect(JSON.stringify(candidates)).toBe(snapshot);

          // ---- Recovery: an offline number only returns to `available` when it is
          // enabled, has an active offer, has no active order, and its device is live.
          const recoveryDevice: Pick<DeviceState, "status" | "lastSeenAt"> = {
            status: recoveryDeviceStatus,
            lastSeenAt: recoveryHasLastSeen
              ? new Date(nowServer.getTime() - recoveryAgeMs)
              : null,
          };
          const live = isDeviceLive(recoveryDevice, nowServer);
          const recovered = reconcileNumberAvailability({
            status: "offline",
            enabled: recoveryEnabled,
            hasActiveOrder: recoveryHasOrder,
            hasActiveOffer: recoveryHasOffer,
            device: recoveryDevice,
            nowServer,
          });

          const expected: NumberStatus = !recoveryEnabled
            ? "disabled"
            : !live
              ? "offline"
              : recoveryHasOffer && !recoveryHasOrder
                ? "available"
                : "offline";
          expect(recovered).toBe(expected);
          // The "available" recovery must never happen for a non-live device.
          if (recovered === "available") {
            expect(live).toBe(true);
            expect(recoveryEnabled).toBe(true);
            expect(recoveryHasOffer).toBe(true);
            expect(recoveryHasOrder).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
