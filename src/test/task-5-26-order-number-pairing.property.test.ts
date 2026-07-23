import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  createOrderTransitionOperationKey,
  decideNumberRelease,
  decideOrderNumberTransition,
  type DeviceEffectiveStatus,
  type NumberStatus,
  type OrderStatus,
  type OrderTransitionCommand,
  type ReleaseDisposition,
  type ServerObservedReleaseContext,
} from "@domain/order-state-machine";

// Feature: partner-platform, Property 19: State order dan number selalu berpasangan
//
// For all aktivasi/cancel/timeout yang valid, `reserved→waiting_sms` selalu
// berpasangan dengan number `reserved→busy`; terminal non-success melepaskan
// number ke `available` bila device online/enabled dengan heartbeat segar atau
// ke `offline` bila tidak, dan retry mempertahankan pasangan state yang sama.
//
// **Validates: Requirements 12.2, 12.4, 12.5**
//
// Design references:
// - Number pairing pada state machine (Components §9 diagram + §3): activation
//   memindahkan order `reserved→waiting_sms` bersamaan number `reserved→busy`.
// - Release disposition terminal non-success (Components §7): number kembali ke
//   `available` hanya jika enabled, device online, dan heartbeat belum stale;
//   selain itu `offline`. Requirement 12.2 mengikat pasangan busy, 12.4 cancel,
//   12.5 timeout, keduanya melepaskan number secara idempotent.
// - CAS + retry mengembalikan state yang sudah tercapai tanpa efek baru
//   (Components §9), sehingga pasangan state tetap konsisten di percobaan ulang.
// - Testing Strategy: order state machine adalah target 500-run pada CI malam.
// - Pure domain test tidak memakai DB/network (Testing Strategy).

const NUM_RUNS = 500;

const ORDER_ID = "order:partner/9a1d";
// A large base timestamp keeps every derived `lastSeenAt` strictly positive so
// the release context always stays well-formed; liveness is varied purely
// through device status, enable flag, and heartbeat age below.
const BASE_MS = Date.parse("2026-05-01T00:00:00.000Z");
const MIN_CANCEL_MS = 3 * 60 * 1_000;
const TIMEOUT_MS = 20 * 60 * 1_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;

// --- Liveness generator: device status, enable flag, and heartbeat freshness -

interface Liveness {
  readonly numberEnabled: boolean;
  readonly deviceStatus: DeviceEffectiveStatus;
  readonly lastSeenMode: "null" | "fresh" | "stale";
  readonly freshAge: number;
  readonly staleAge: number;
}

const livenessArbitrary: fc.Arbitrary<Liveness> = fc.record({
  numberEnabled: fc.boolean(),
  deviceStatus: fc.constantFrom<DeviceEffectiveStatus>(
    "online",
    "offline",
    "disabled",
  ),
  lastSeenMode: fc.constantFrom("null", "fresh", "stale"),
  // Fresh: heartbeat within the 90s window → still alive.
  freshAge: fc.integer({ min: 0, max: HEARTBEAT_TIMEOUT_MS }),
  // Stale: heartbeat older than the window → treated offline.
  staleAge: fc.integer({
    min: HEARTBEAT_TIMEOUT_MS + 1,
    max: HEARTBEAT_TIMEOUT_MS * 10,
  }),
});

function buildRelease(
  liveness: Liveness,
  observedAtMs: number,
): ServerObservedReleaseContext {
  let deviceLastSeenAtMs: number | null;
  if (liveness.lastSeenMode === "null") {
    deviceLastSeenAtMs = null;
  } else if (liveness.lastSeenMode === "fresh") {
    deviceLastSeenAtMs = observedAtMs - liveness.freshAge;
  } else {
    deviceLastSeenAtMs = observedAtMs - liveness.staleAge;
  }
  return {
    numberEnabled: liveness.numberEnabled,
    deviceStatus: liveness.deviceStatus,
    deviceLastSeenAtMs,
    observedAtMs,
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
  };
}

// Independent oracle for the release disposition, restated from Components §7:
// a released number becomes `available` only when it is enabled, the device is
// online, and the last heartbeat is within the timeout window; otherwise it is
// parked `offline`. This mirror is intentionally separate from the production
// `decideNumberRelease`.
function expectedDisposition(ctx: ServerObservedReleaseContext): ReleaseDisposition {
  if (!ctx.numberEnabled) return "offline";
  if (ctx.deviceStatus !== "online") return "offline";
  if (ctx.deviceLastSeenAtMs === null) return "offline";
  const heartbeatAgeMs = ctx.observedAtMs - ctx.deviceLastSeenAtMs;
  return heartbeatAgeMs >= 0 && heartbeatAgeMs <= ctx.heartbeatTimeoutMs
    ? "available"
    : "offline";
}

// --- Scenario generators: activation vs terminal non-success releases --------

type Scenario =
  | { readonly kind: "activate" }
  | {
      readonly kind: "cancel";
      readonly sourceOrder: "reserved" | "waiting_sms";
      readonly reason: "BUYER_REQUEST" | "MAIN_COMPENSATION";
      readonly age: number;
      readonly liveness: Liveness;
    }
  | {
      readonly kind: "timeout";
      readonly sourceOrder: "reserved" | "waiting_sms";
      readonly delta: number;
      readonly liveness: Liveness;
    }
  | { readonly kind: "fail"; readonly liveness: Liveness };

const terminalSourceArbitrary = fc.constantFrom<"reserved" | "waiting_sms">(
  "reserved",
  "waiting_sms",
);

const scenarioArbitrary: fc.Arbitrary<Scenario> = fc.oneof(
  fc.constant<Scenario>({ kind: "activate" }),
  fc.record({
    kind: fc.constant("cancel" as const),
    sourceOrder: terminalSourceArbitrary,
    reason: fc.constantFrom("BUYER_REQUEST" as const, "MAIN_COMPENSATION" as const),
    // Past the minimum cancel age so the cancel guard is always satisfied.
    age: fc.integer({ min: MIN_CANCEL_MS, max: MIN_CANCEL_MS + TIMEOUT_MS }),
    liveness: livenessArbitrary,
  }),
  fc.record({
    kind: fc.constant("timeout" as const),
    sourceOrder: terminalSourceArbitrary,
    // observed at/after expiry so the timeout guard is always satisfied.
    delta: fc.integer({ min: 0, max: TIMEOUT_MS }),
    liveness: livenessArbitrary,
  }),
  fc.record({
    kind: fc.constant("fail" as const),
    liveness: livenessArbitrary,
  }),
);

// The number status paired with an active order source: reserved order holds a
// reserved number; waiting_sms order holds a busy number.
function pairedNumber(sourceOrder: "reserved" | "waiting_sms"): NumberStatus {
  return sourceOrder === "reserved" ? "reserved" : "busy";
}

describe("Property 19: state order dan number selalu berpasangan", () => {
  it("pairs activation reserved→busy and releases terminals by device liveness, keeping retries effect-free", () => {
    fc.assert(
      fc.property(scenarioArbitrary, (scenario) => {
        if (scenario.kind === "activate") {
          // (12.2) Activation moves the order reserved→waiting_sms in lockstep
          // with the number reserved→busy; no release disposition is produced.
          const input = {
            orderId: ORDER_ID,
            orderStatus: "reserved" as OrderStatus,
            numberStatus: "reserved" as NumberStatus,
            otpReceived: false,
            command: { type: "activate" } as OrderTransitionCommand,
          };

          const decision = decideOrderNumberTransition(input);
          expect(decision.kind).toBe("apply");
          if (decision.kind === "apply") {
            expect(decision.expectedOrderStatus).toBe("reserved");
            expect(decision.expectedNumberStatus).toBe("reserved");
            expect(decision.nextOrderStatus).toBe("waiting_sms");
            expect(decision.nextNumberStatus).toBe("busy");
            expect(decision.releaseDisposition).toBeNull();
            expect(decision.numberChanged).toBe(true);
            // Biconditional pairing: the order reaches waiting_sms exactly when
            // the number reaches busy.
            expect(decision.nextOrderStatus === "waiting_sms").toBe(
              decision.nextNumberStatus === "busy",
            );
            expect(decision.operationKey).toBe(
              createOrderTransitionOperationKey(ORDER_ID, "waiting_sms"),
            );
          }

          // Retry after activation: order already at waiting_sms with a busy
          // number is an idempotent no-op that preserves the pair.
          const retry = decideOrderNumberTransition({
            ...input,
            orderStatus: "waiting_sms",
            numberStatus: "busy",
          });
          expect(retry.kind).toBe("no_change");
          expect(retry.nextOrderStatus).toBe("waiting_sms");
          expect(retry.nextNumberStatus).toBe("busy");
          expect(retry.releaseDisposition).toBeNull();
          return;
        }

        // Terminal non-success (cancel / timeout / fail) from an active order.
        let sourceOrder: OrderStatus;
        let command: OrderTransitionCommand;
        let release: ServerObservedReleaseContext;
        let target: OrderStatus;

        if (scenario.kind === "fail") {
          // fail is only a legal edge from waiting_sms (busy number).
          sourceOrder = "waiting_sms";
          const observedAtMs = BASE_MS + TIMEOUT_MS;
          release = buildRelease(scenario.liveness, observedAtMs);
          command = { type: "fail", release };
          target = "failed";
        } else if (scenario.kind === "cancel") {
          sourceOrder = scenario.sourceOrder;
          const createdAtMs = BASE_MS;
          const observedAtMs = createdAtMs + scenario.age;
          release = buildRelease(scenario.liveness, observedAtMs);
          command = {
            type: "cancel",
            reason: scenario.reason,
            createdAtMs,
            observedAtMs,
            minimumCancelAgeMs: MIN_CANCEL_MS,
            release,
          };
          target = "cancelled";
        } else {
          sourceOrder = scenario.sourceOrder;
          const expiresAtMs = BASE_MS;
          const observedAtMs = expiresAtMs + scenario.delta;
          release = buildRelease(scenario.liveness, observedAtMs);
          command = { type: "timeout", expiresAtMs, observedAtMs, release };
          target = "timeout";
        }

        const sourceNumber = pairedNumber(
          sourceOrder as "reserved" | "waiting_sms",
        );
        const disposition = expectedDisposition(release);

        const input = {
          orderId: ORDER_ID,
          orderStatus: sourceOrder,
          numberStatus: sourceNumber,
          otpReceived: false,
          command,
        };

        const decision = decideOrderNumberTransition(input);
        expect(decision.kind).toBe("apply");
        if (decision.kind === "apply") {
          // The CAS still requires the paired source number state.
          expect(decision.expectedOrderStatus).toBe(sourceOrder);
          expect(decision.expectedNumberStatus).toBe(sourceNumber);
          expect(decision.nextOrderStatus).toBe(target);

          // (12.4, 12.5) The number is released to the liveness-driven
          // disposition; it matches both the independent oracle and the pure
          // release policy, and the number ends up exactly at that disposition.
          expect(decision.releaseDisposition).toBe(disposition);
          expect(decision.releaseDisposition).toBe(decideNumberRelease(release));
          expect(decision.nextNumberStatus).toBe(disposition);

          // A released number is `available` iff the device is enabled, online,
          // and its heartbeat is fresh; otherwise it is parked `offline`.
          const alive =
            release.numberEnabled &&
            release.deviceStatus === "online" &&
            release.deviceLastSeenAtMs !== null &&
            release.observedAtMs - release.deviceLastSeenAtMs >= 0 &&
            release.observedAtMs - release.deviceLastSeenAtMs <=
              release.heartbeatTimeoutMs;
          expect(decision.nextNumberStatus === "available").toBe(alive);
        }

        // Retry of the same terminal command: order already terminal is an
        // idempotent no-op that preserves the released pair unchanged.
        const retry = decideOrderNumberTransition({
          ...input,
          orderStatus: target,
          numberStatus: disposition,
        });
        expect(retry.kind).toBe("no_change");
        expect(retry.nextOrderStatus).toBe(target);
        expect(retry.nextNumberStatus).toBe(disposition);
        expect(retry.releaseDisposition).toBe(disposition);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
