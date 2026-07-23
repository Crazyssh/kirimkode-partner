import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseAgentAuthorizationHeader } from "@domain/task-11-1/agent-api-auth";
import {
  assertDeviceOperationAllowed,
  DeviceCapabilities,
  DeviceOperation,
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
  selectEligibleInventory,
  Task52DomainError,
} from "@domain/task-5-2-device-inventory-pricing";

import { utcInstantArbitrary } from "./generators";

/**
 * Feature: partner-platform, Property 6: Credential dan status Device bersifat
 * fail-closed. For all request perubahan inventory/SMS, bila Device disabled
 * atau principal tidak valid maka tidak ada state domain yang berubah; setiap
 * Device aktif selalu mempunyai effective status tepat satu dari
 * `offline|online`, sedangkan disabled mendominasi heartbeat.
 *
 * **Validates: Requirements 5.4, 5.6, 18.5**
 *
 * Strategy: vary principal (Authorization credential shape), device status,
 * capabilities, heartbeat instants, and the mutating operation to prove three
 * fail-closed invariants:
 *   1. A malformed principal parses to `null` — the caller can never establish a
 *      device identity, so the request is refused before any domain call
 *      (Req 18.5). A well-formed principal is parsed deterministically with no
 *      side effects.
 *   2. `disabled` dominates every inventory/SMS mutation and heartbeat: the
 *      operation guard always throws `DEVICE_DISABLED`, the device is never
 *      mutated, a disabled device's numbers are never eligible inventory, and a
 *      fresh heartbeat cannot resurrect a disabled device (Req 5.6).
 *   3. Every active (non-disabled) device has an effective status of exactly one
 *      of `offline|online`, decided solely by liveness — never `disabled`
 *      (Req 5.4).
 */

const THRESHOLD_MS = MVP_HEARTBEAT_TIMEOUT_SECONDS * 1_000;

const deviceStatusArbitrary = fc.constantFrom<DeviceStatus>("offline", "online", "disabled");

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

// base64url is the alphabet used for both device public ids and secrets (task
// 8.1); neither ever contains a `.`, so the first `.` unambiguously separates
// them in `Device <publicId>.<secret>`.
const base64UrlCharArbitrary = fc.constantFrom(
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split(""),
);
const validPublicIdArbitrary = fc
  .array(base64UrlCharArbitrary, { minLength: 1, maxLength: 80 })
  .map((chars) => chars.join(""));
const validSecretArbitrary = fc
  .array(base64UrlCharArbitrary, { minLength: 16, maxLength: 256 })
  .map((chars) => chars.join(""));

// A well-formed principal: `Device <publicId>.<secret>` with a case-insensitive
// scheme (the wire is case-insensitive on the scheme token).
const validCredentialArbitrary = fc
  .tuple(validPublicIdArbitrary, validSecretArbitrary, fc.constantFrom("Device", "device", "DEVICE"))
  .map(([publicId, secret, scheme]) => ({ header: `${scheme} ${publicId}.${secret}`, publicId, secret }));

// Structurally invalid principals that must all parse to `null` before any
// domain mutation can be attempted.
const invalidCredentialArbitrary = fc.oneof(
  fc.constant(null),
  fc.constant(""),
  fc.constant("   "),
  fc.constant("Device"),
  fc.constant("Device "),
  fc.constant("Bearer abc.def"), // wrong scheme
  fc.constant("Device nodothere"), // missing separator
  fc.constant("Device .secretonly"), // empty public id
  fc.constant("Device publiconly."), // empty secret
  // A secret using a character outside the base64url alphabet is refused.
  validPublicIdArbitrary.map((publicId) => `Device ${publicId}.has space`),
);

const FILTER: InventoryFilter = {
  serviceCode: MVP_CATALOG.serviceCode,
  countryCode: MVP_CATALOG.countryCode,
  operatorCode: MVP_CATALOG.operatorCode,
};

/**
 * A candidate whose every dimension is otherwise eligible, parameterised only by
 * device status/lastSeenAt so the disabled gate can be isolated.
 */
function buildCandidate(
  numberId: string,
  status: DeviceStatus,
  lastSeenAt: Date | null,
  capabilities: DeviceCapabilities,
): InventoryCandidate {
  return {
    numberId,
    partnerStatus: "approved",
    device: { type: "simulator", status, lastSeenAt, capabilities: { ...capabilities, sms: true } },
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

describe("Property 6: Device credential and status are fail-closed", () => {
  it("refuses invalid principals, lets disabled dominate mutations/heartbeat, and keeps active status to offline|online", () => {
    fc.assert(
      fc.property(
        deviceStatusArbitrary,
        capabilitiesArbitrary,
        operationArbitrary,
        fc.option(utcInstantArbitrary, { nil: null }),
        utcInstantArbitrary,
        utcInstantArbitrary,
        validCredentialArbitrary,
        invalidCredentialArbitrary,
        fc.uuid(),
        (
          status,
          capabilities,
          operation,
          lastSeenAt,
          nowServer,
          heartbeatAt,
          validCredential,
          invalidCredential,
          numberId,
        ) => {
          // ---- Requirement 18.5: an invalid principal never resolves, so a
          // request cannot proceed to mutate state; a valid one is parsed purely.
          expect(parseAgentAuthorizationHeader(invalidCredential)).toBeNull();

          const parsed = parseAgentAuthorizationHeader(validCredential.header);
          expect(parsed).not.toBeNull();
          expect(parsed).toEqual({ publicId: validCredential.publicId, secret: validCredential.secret });
          // Parsing is pure/deterministic: repeating it yields an equal token.
          expect(parseAgentAuthorizationHeader(validCredential.header)).toEqual(parsed);

          const device: DeviceState = { type: "simulator", status, lastSeenAt, capabilities };
          const deviceSnapshot = JSON.stringify(device);

          if (status === "disabled") {
            // ---- Requirement 5.6: a disabled device is refused for EVERY
            // inventory/SMS mutation, ahead of any capability check, and throwing
            // means no domain state is produced (fail-closed).
            expect(() => assertDeviceOperationAllowed(device, operation)).toThrow(Task52DomainError);
            try {
              assertDeviceOperationAllowed(device, operation);
            } catch (error) {
              expect(error).toBeInstanceOf(Task52DomainError);
              expect((error as Task52DomainError).code).toBe("DEVICE_DISABLED");
            }
            // The guard never mutates the (frozen) device it inspects.
            expect(JSON.stringify(device)).toBe(deviceSnapshot);

            // ---- Requirement 5.4: disabled dominates effective status entirely,
            // regardless of how recent the heartbeat is.
            expect(effectiveDeviceStatus(device, nowServer)).toBe("disabled");
            expect(isDeviceLive(device, nowServer)).toBe(false);

            // Disabled dominates the heartbeat: a fresh heartbeat updates
            // lastSeenAt but can never resurrect the device to online.
            const afterHeartbeat = recordServerHeartbeat(device, heartbeatAt);
            expect(afterHeartbeat.status).toBe("disabled");
            expect(effectiveDeviceStatus(afterHeartbeat, afterHeartbeat.lastSeenAt!)).toBe("disabled");

            // A disabled device's numbers are excluded from eligible inventory.
            const candidate = buildCandidate(numberId, "disabled", lastSeenAt, capabilities);
            const candidateSnapshot = JSON.stringify(candidate);
            expect(isInventoryCandidateEligible(candidate, FILTER, nowServer)).toBe(false);
            expect(selectEligibleInventory([candidate], FILTER, nowServer)).toBeNull();
            // Eligibility is a pure read — it never mutates the candidate.
            expect(JSON.stringify(candidate)).toBe(candidateSnapshot);
          } else {
            // ---- Requirement 5.4: an active device's effective status is always
            // exactly one of offline|online, decided solely by liveness.
            const effective = effectiveDeviceStatus(device, nowServer);
            expect(effective).not.toBe("disabled");
            expect(["offline", "online"]).toContain(effective);
            expect(effective).toBe(isDeviceLive(device, nowServer) ? "online" : "offline");

            // A valid heartbeat brings an enabled device online (never disabled).
            const afterHeartbeat = recordServerHeartbeat(device, heartbeatAt);
            expect(afterHeartbeat.status).toBe("online");
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
