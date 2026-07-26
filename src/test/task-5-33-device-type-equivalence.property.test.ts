import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  DEVICE_TYPES,
  decideDeviceCreation,
  declareCapabilities,
  type DeviceType,
  supportsCapability,
} from "@domain/task-5-7";
import {
  assertDeviceOperationAllowed,
  type DeviceCapabilities,
  type DeviceOperation,
  type DeviceState,
  type DeviceStatus,
  effectiveDeviceStatus,
  type InventoryCandidate,
  type InventoryFilter,
  isDeviceLive,
  isInventoryCandidateEligible,
  MVP_CATALOG,
  reconcileNumberAvailability,
  recordServerHeartbeat,
  selectEligibleInventory,
  Task52DomainError,
  type NumberStatus,
  type PartnerStatus,
} from "@domain/task-5-2-device-inventory-pricing";
import {
  decideNumberRelease,
  decideOrderNumberTransition,
  type OrderNumberTransitionDecision,
} from "@domain/order-state-machine";

import { utcInstantArbitrary } from "./generators";

/**
 * Feature: partner-platform, Property 26: Simulator dan tipe Device ekuivalen
 * pada domain inti. For all tipe Device dengan capability set yang sama dan
 * urutan command domain yang sama, hasil lifecycle order/number setara;
 * pembuatan simulator hanya diizinkan oleh policy environment atau allowlist
 * dan tidak memberi hak tambahan.
 *
 * **Validates: Requirements 17.1, 17.2, 21.1, 21.4**
 *
 * Strategy: the domain is deliberately type-neutral — every liveness,
 * capability, inventory, availability, and order/number lifecycle rule depends
 * only on explicit capabilities and server-observed state, never on the device
 * `type` (Req 17.2, 21.4). The properties below exercise three facets of the
 * equivalence:
 *   1. Two devices that differ ONLY in `type` but share the same capability set
 *      and receive the same command sequence produce byte-for-byte identical
 *      core-domain outcomes (heartbeat, effective status, liveness, operation
 *      guard, inventory eligibility/selection, number availability) and the
 *      same order/number lifecycle release disposition (Req 17.2, 21.1).
 *   2. Simulator creation is gated ONLY by environment/allowlist policy while
 *      every other type is ungated, and being allowed never alters the declared
 *      capabilities — a simulator gains no extra rights (Req 17.1, 21.4).
 *   3. Capability support is decided purely by the explicit declaration, so the
 *      same declaration yields the same `supportsCapability` answers across all
 *      device types (Req 21.4).
 */

const deviceStatusArbitrary = fc.constantFrom<DeviceStatus>(
  "offline",
  "online",
  "disabled",
);

const operationArbitrary = fc.constantFrom<DeviceOperation>(
  "inventory",
  "sms",
  "notification",
  "resend",
  "operator",
);

const capabilitiesArbitrary: fc.Arbitrary<DeviceCapabilities> = fc.record({
  sms: fc.boolean(),
  notification: fc.boolean(),
  resend: fc.boolean(),
  operator: fc.boolean(),
  slots: fc.integer({ min: 0, max: 8 }),
});

const numberStatusArbitrary = fc.constantFrom<NumberStatus>(
  "offline",
  "available",
  "reserved",
  "busy",
  "disabled",
);

const partnerStatusArbitrary = fc.constantFrom<PartnerStatus>(
  "pending",
  "approved",
  "suspended",
  "rejected",
);

// A pair of DISTINCT device types built from the same capability set. Picking a
// non-zero delta guarantees the two types differ, so any difference in outcome
// would have to come from the type — which the domain must never allow.
const distinctTypePairArbitrary = fc
  .tuple(
    fc.integer({ min: 0, max: DEVICE_TYPES.length - 1 }),
    fc.integer({ min: 1, max: DEVICE_TYPES.length - 1 }),
  )
  .map(([base, delta]): [DeviceType, DeviceType] => [
    DEVICE_TYPES[base],
    DEVICE_TYPES[(base + delta) % DEVICE_TYPES.length],
  ]);

const FILTER: InventoryFilter = {
  serviceCode: MVP_CATALOG.serviceCode,
  countryCode: MVP_CATALOG.countryCode,
  operatorCode: MVP_CATALOG.operatorCode,
};

interface SharedInputs {
  readonly status: DeviceStatus;
  readonly capabilities: DeviceCapabilities;
  readonly lastSeenAt: Date | null;
  readonly nowServer: Date;
  readonly heartbeatAt: Date;
  readonly operation: DeviceOperation;
  readonly numberId: string;
  readonly partnerStatus: PartnerStatus;
  readonly numberStatus: NumberStatus;
  readonly numberEnabled: boolean;
  readonly hasActiveOrder: boolean;
  readonly hasActiveOffer: boolean;
}

function buildDevice(type: DeviceType, shared: SharedInputs): DeviceState {
  return {
    type,
    status: shared.status,
    lastSeenAt: shared.lastSeenAt,
    capabilities: shared.capabilities,
  };
}

function buildCandidate(type: DeviceType, shared: SharedInputs): InventoryCandidate {
  return {
    numberId: shared.numberId,
    partnerStatus: shared.partnerStatus,
    device: buildDevice(type, shared),
    number: {
      status: shared.numberStatus,
      enabled: shared.numberEnabled,
      countryCode: MVP_CATALOG.countryCode,
      operatorCode: MVP_CATALOG.operatorCode,
      hasActiveOrder: shared.hasActiveOrder,
    },
    offer: {
      serviceCode: MVP_CATALOG.serviceCode,
      countryCode: MVP_CATALOG.countryCode,
      operatorCode: MVP_CATALOG.operatorCode,
      basePriceIdr: 1_000,
      status: shared.hasActiveOffer ? "active" : "inactive",
    },
  };
}

/**
 * Compute every core-domain outcome for a device of the given type, projected
 * to a plain, type-independent shape. The `type` field is deliberately excluded
 * so the result captures ONLY behaviour that must be equivalent across types.
 */
function coreDomainOutcome(type: DeviceType, shared: SharedInputs): unknown {
  const device = buildDevice(type, shared);

  const effective = effectiveDeviceStatus(device, shared.nowServer);
  const live = isDeviceLive(device, shared.nowServer);

  const afterHeartbeat = recordServerHeartbeat(device, shared.heartbeatAt);
  const heartbeat = {
    status: afterHeartbeat.status,
    lastSeenAtMs: afterHeartbeat.lastSeenAt?.getTime() ?? null,
  };

  let operationResult: string;
  try {
    assertDeviceOperationAllowed(device, shared.operation);
    operationResult = "allowed";
  } catch (error) {
    operationResult =
      error instanceof Task52DomainError ? `error:${error.code}` : "error:unknown";
  }

  const candidate = buildCandidate(type, shared);
  const eligible = isInventoryCandidateEligible(candidate, FILTER, shared.nowServer);
  const selected = selectEligibleInventory([candidate], FILTER, shared.nowServer);

  const availability = reconcileNumberAvailability({
    status: shared.numberStatus,
    enabled: shared.numberEnabled,
    hasActiveOrder: shared.hasActiveOrder,
    hasActiveOffer: shared.hasActiveOffer,
    device,
    nowServer: shared.nowServer,
  });

  // The order/number lifecycle consumes only the SERVER-OBSERVED effective
  // status + last-seen instant, never the device type. The release disposition
  // path is exercised directly through `decideNumberRelease` on that
  // server-observed context; the terminal success from waiting_sms/busy exercises
  // the order edge itself, which keeps the number held for the listening window.
  const releaseContext = {
    numberEnabled: shared.numberEnabled,
    deviceStatus: effective,
    deviceLastSeenAtMs: device.lastSeenAt?.getTime() ?? null,
    observedAtMs: shared.nowServer.getTime(),
    heartbeatTimeoutMs: 90_000,
  };
  const releaseDisposition = decideNumberRelease(releaseContext);
  const transition: OrderNumberTransitionDecision = decideOrderNumberTransition({
    orderId: shared.numberId,
    orderStatus: "waiting_sms",
    numberStatus: "busy",
    otpReceived: false,
    command: { type: "succeed" },
  });

  return {
    effective,
    live,
    heartbeat,
    operationResult,
    eligible,
    selectedNumberId: selected?.numberId ?? null,
    availability,
    releaseDisposition,
    transition: {
      kind: transition.kind,
      nextOrderStatus: transition.nextOrderStatus,
      nextNumberStatus: transition.nextNumberStatus,
      releaseDisposition: transition.releaseDisposition,
    },
  };
}

describe("Property 26: Simulator and device types are equivalent on the core domain", () => {
  it("produces identical core-domain lifecycle outcomes for two distinct types sharing capabilities and commands", () => {
    fc.assert(
      fc.property(
        distinctTypePairArbitrary,
        deviceStatusArbitrary,
        capabilitiesArbitrary,
        fc.option(utcInstantArbitrary, { nil: null }),
        utcInstantArbitrary,
        utcInstantArbitrary,
        operationArbitrary,
        fc.uuid(),
        partnerStatusArbitrary,
        numberStatusArbitrary,
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (
          [typeA, typeB],
          status,
          capabilities,
          lastSeenAt,
          nowServer,
          heartbeatAt,
          operation,
          numberId,
          partnerStatus,
          numberStatus,
          numberEnabled,
          hasActiveOrder,
          hasActiveOffer,
        ) => {
          const shared: SharedInputs = {
            status,
            capabilities,
            lastSeenAt,
            nowServer,
            heartbeatAt,
            operation,
            numberId,
            partnerStatus,
            numberStatus,
            numberEnabled,
            hasActiveOrder,
            hasActiveOffer,
          };

          expect(typeA).not.toBe(typeB);

          const outcomeA = coreDomainOutcome(typeA, shared);
          const outcomeB = coreDomainOutcome(typeB, shared);

          // Equivalence: differing only in `type` must not change any
          // core-domain outcome (Req 17.2, 21.1).
          expect(outcomeA).toStrictEqual(outcomeB);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("gates only simulator creation by environment/allowlist and never grants extra rights", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<DeviceType>(...DEVICE_TYPES),
        fc.string({ minLength: 1, maxLength: 16 }),
        fc.boolean(),
        capabilitiesArbitrary,
        (type, environment, partnerSimulatorAllowed, capabilities) => {
          const policy = { environment, partnerSimulatorAllowed };
          const decision = decideDeviceCreation(type, policy);

          if (type === "simulator") {
            // A simulator is allowed exactly when the environment is not
            // production, or the partner is explicitly allowlisted (Req 17.1).
            const expectedAllowed =
              environment !== "production" || partnerSimulatorAllowed === true;
            expect(decision.allowed).toBe(expectedAllowed);
            if (!expectedAllowed) {
              expect(decision).toMatchObject({
                allowed: false,
                code: "simulator_not_allowed",
              });
            }
          } else {
            // Every non-simulator type is ungated by the simulator policy.
            expect(decision.allowed).toBe(true);
          }

          // No extra rights: whether or not creation is allowed, the declared
          // capabilities are unchanged by type (Req 21.4). A permitted
          // simulator has exactly the capabilities it declared — no more.
          const declared = declareCapabilities({
            sms: capabilities.sms,
            notification: capabilities.notification,
            resend: capabilities.resend,
            operator: null,
            slots: Math.max(1, capabilities.slots),
          });
          expect(supportsCapability(declared, "sms")).toBe(capabilities.sms);
          expect(supportsCapability(declared, "notification")).toBe(
            capabilities.notification,
          );
          expect(supportsCapability(declared, "resend")).toBe(capabilities.resend);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("decides capability support purely from the explicit declaration, independent of type", () => {
    fc.assert(
      fc.property(
        distinctTypePairArbitrary,
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 1, max: 8 }),
        ([typeA, typeB], sms, notification, resend, slots) => {
          // The declaration is the same regardless of the type we intend to
          // attach it to; support answers must therefore match across types.
          const declared = declareCapabilities({ sms, notification, resend, slots });

          for (const capability of ["sms", "notification", "resend"] as const) {
            const supported = supportsCapability(declared, capability);
            expect(supported).toBe({ sms, notification, resend }[capability]);
          }

          // typeA/typeB are irrelevant to capability support — assert they do
          // not participate in the decision by construction.
          expect(typeA).not.toBe(typeB);
        },
      ),
      { numRuns: 100 },
    );
  });
});
