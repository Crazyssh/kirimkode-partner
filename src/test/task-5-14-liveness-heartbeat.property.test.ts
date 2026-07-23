import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  DeviceCapabilities,
  DeviceState,
  DeviceStatus,
  effectiveDeviceStatus,
  InventoryCandidate,
  InventoryFilter,
  isDeviceLive,
  isInventoryCandidateEligible,
  MVP_CATALOG,
  MVP_HEARTBEAT_TIMEOUT_SECONDS,
  recordServerHeartbeat,
} from "@domain/task-5-2-device-inventory-pricing";

import { utcInstantArbitrary } from "./generators";

/**
 * Feature: partner-platform, Property 7: Liveness heartbeat deterministik dan
 * metadata non-otoritatif.
 *
 * For all waktu server, heartbeat history, dan metadata agent, `lastSeenAt`
 * tidak pernah mundur dan Device enabled online tepat ketika umur heartbeat
 * tidak melebihi 90 detik; perubahan metadata saja tidak dapat mengubah tenant,
 * authorization, atau eligibility selain capability tervalidasi.
 *
 * **Validates: Requirements 6.1, 6.2, 6.4, 21.3**
 *
 * Strategy: drive a device through an arbitrary sequence of server-observed
 * heartbeat instants (with only metadata attached) to prove `lastSeenAt` is the
 * running max and therefore monotonic; probe liveness at a generated age around
 * the 90s boundary (with boundary values injected explicitly) to prove online
 * status flips exactly at `now - lastSeenAt <= 90s`; and compare eligibility of
 * two otherwise-identical inventory candidates that differ only by heartbeat
 * metadata to prove metadata is never authoritative over eligibility.
 */

const THRESHOLD_MS = MVP_HEARTBEAT_TIMEOUT_SECONDS * 1_000;

const deviceStatusArbitrary = fc.constantFrom<DeviceStatus>(
  "offline",
  "online",
  "disabled",
);

const capabilitiesArbitrary: fc.Arbitrary<DeviceCapabilities> = fc.record({
  sms: fc.boolean(),
  notification: fc.boolean(),
  resend: fc.boolean(),
  operator: fc.boolean(),
  slots: fc.integer({ min: 0, max: 8 }),
});

// Metadata that always passes `sanitizeHeartbeatMetadata` so we exercise the
// "valid metadata is recorded but never authoritative" branch of the property.
const metadataArbitrary = fc.record(
  {
    agentVersion: fc.string({ maxLength: 64 }),
    signal: fc.integer({ min: -140, max: 40 }),
    operator: fc.string({ maxLength: 64 }),
  },
  { requiredKeys: [] },
);

// Ages around the 90s liveness boundary. Boundary constants are injected so the
// exact `<= 90_000` edge is always exercised alongside random ages.
const ageMsArbitrary = fc.oneof(
  fc.integer({ min: 0, max: 4 * THRESHOLD_MS }),
  fc.constantFrom(0, THRESHOLD_MS - 1, THRESHOLD_MS, THRESHOLD_MS + 1, 2 * THRESHOLD_MS),
);

const FILTER: InventoryFilter = {
  serviceCode: MVP_CATALOG.serviceCode,
  countryCode: MVP_CATALOG.countryCode,
  operatorCode: MVP_CATALOG.operatorCode,
};

/**
 * A fully-eligible candidate (approved, live, SMS-capable, available) whose only
 * varying field is the heartbeat metadata attached to its device. Metadata must
 * not influence eligibility.
 */
function buildCandidate(
  numberId: string,
  lastSeenAt: Date,
  nowServer: Date,
  metadata: Record<string, unknown>,
): InventoryCandidate {
  const device: DeviceState = {
    type: "simulator",
    status: "online",
    lastSeenAt,
    capabilities: { sms: true, notification: false, resend: false, operator: false, slots: 1 },
    heartbeatMetadata: metadata,
  };
  // Keep the candidate live so eligibility is meaningfully `true` when metadata
  // is irrelevant; `nowServer` is chosen within the threshold by the caller.
  void nowServer;
  return {
    numberId,
    partnerStatus: "approved",
    device,
    number: {
      status: "available",
      enabled: true,
      countryCode: MVP_CATALOG.countryCode,
      operatorCode: MVP_CATALOG.operatorCode,
      hasActiveOrder: false,
    },
    offer: {
      serviceCode: MVP_CATALOG.serviceCode,
      countryCode: MVP_CATALOG.countryCode,
      operatorCode: MVP_CATALOG.operatorCode,
      basePriceIdr: 1_000,
      status: "active",
    },
  };
}

describe("Property 7: Liveness heartbeat deterministic and metadata non-authoritative", () => {
  it("keeps lastSeenAt monotonic, flips online exactly at the 90s threshold, and ignores metadata for eligibility", () => {
    fc.assert(
      fc.property(
        deviceStatusArbitrary,
        fc.option(utcInstantArbitrary, { nil: null }),
        capabilitiesArbitrary,
        fc.array(utcInstantArbitrary, { minLength: 1, maxLength: 6 }),
        fc.array(metadataArbitrary, { minLength: 1, maxLength: 6 }),
        ageMsArbitrary,
        utcInstantArbitrary,
        fc.uuid(),
        metadataArbitrary,
        metadataArbitrary,
        (
          initialStatus,
          initialLastSeen,
          capabilities,
          serverTimes,
          metadataSequence,
          ageMs,
          anchorInstant,
          numberId,
          metadataA,
          metadataB,
        ) => {
          // ---- Requirement 6.1/6.4: lastSeenAt is the running max => monotonic.
          let device: DeviceState = {
            type: "simulator",
            status: initialStatus,
            lastSeenAt: initialLastSeen,
            capabilities,
            heartbeatMetadata: {},
          };
          let previousLastSeen = device.lastSeenAt?.getTime() ?? Number.NEGATIVE_INFINITY;

          serverTimes.forEach((receivedAtServer, index) => {
            const before = device;
            // Only metadata is attached; capabilities are never mutated here.
            const metadata = metadataSequence[index % metadataSequence.length];
            const next = recordServerHeartbeat(before, receivedAtServer, { metadata });

            const expected = Math.max(
              before.lastSeenAt?.getTime() ?? Number.NEGATIVE_INFINITY,
              receivedAtServer.getTime(),
            );
            // lastSeenAt is exactly max(existing, receivedAtServer) (6.1)...
            expect(next.lastSeenAt?.getTime()).toBe(expected);
            // ...and therefore never moves backward across the whole history.
            expect(next.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(previousLastSeen);

            // A valid heartbeat brings an enabled device online; disabled devices
            // stay disabled — metadata cannot override that authority (6.4/21.3).
            expect(next.status).toBe(before.status === "disabled" ? "disabled" : "online");
            // Metadata-only heartbeat preserves validated capabilities unchanged.
            expect(next.capabilities).toBe(before.capabilities);

            previousLastSeen = next.lastSeenAt!.getTime();
            device = next;
          });

          // ---- Requirement 6.2: online exactly when age does not exceed 90s.
          const lastSeenAt = anchorInstant;
          const nowServer = new Date(lastSeenAt.getTime() + ageMs);
          const withinThreshold = ageMs <= THRESHOLD_MS;

          // An enabled/online device is live iff its heartbeat age <= 90s.
          expect(isDeviceLive({ status: "online", lastSeenAt }, nowServer)).toBe(withinThreshold);
          expect(effectiveDeviceStatus({ status: "online", lastSeenAt }, nowServer)).toBe(
            withinThreshold ? "online" : "offline",
          );

          // offline devices are never live; disabled dominates liveness entirely.
          expect(isDeviceLive({ status: "offline", lastSeenAt }, nowServer)).toBe(false);
          expect(isDeviceLive({ status: "disabled", lastSeenAt }, nowServer)).toBe(false);
          expect(effectiveDeviceStatus({ status: "disabled", lastSeenAt }, nowServer)).toBe("disabled");
          // A device that has never reported (null lastSeenAt) is not live.
          expect(isDeviceLive({ status: "online", lastSeenAt: null }, nowServer)).toBe(false);

          // ---- Requirement 21.3: metadata is non-authoritative for eligibility.
          // Two candidates identical except for heartbeat metadata must yield the
          // same eligibility decision (keep them live via a fresh lastSeenAt).
          const liveLastSeen = new Date(nowServer.getTime() - Math.min(ageMs, THRESHOLD_MS));
          const candidateA = buildCandidate(numberId, liveLastSeen, nowServer, metadataA);
          const candidateB = buildCandidate(numberId, liveLastSeen, nowServer, metadataB);
          expect(isInventoryCandidateEligible(candidateA, FILTER, nowServer)).toBe(
            isInventoryCandidateEligible(candidateB, FILTER, nowServer),
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
