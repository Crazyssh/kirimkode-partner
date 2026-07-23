import { describe, expect, it } from "vitest";

import {
  createOrderTransitionOperationKey,
  decideNumberRelease,
  decideOrderNumberTransition,
  type NumberStatus,
  type OrderStatus,
  type ServerObservedReleaseContext,
} from "./order-state-machine";

const ORDER_ID = "order:partner/42";
const CREATED_AT = Date.parse("2026-05-01T00:00:00.000Z");
const THREE_MINUTES = 3 * 60 * 1_000;

function release(
  overrides: Partial<ServerObservedReleaseContext> = {},
): ServerObservedReleaseContext {
  const observedAtMs = CREATED_AT + THREE_MINUTES;
  return {
    numberEnabled: true,
    deviceStatus: "online",
    deviceLastSeenAtMs: observedAtMs - 30_000,
    observedAtMs,
    heartbeatTimeoutMs: 90_000,
    ...overrides,
  };
}

function decide(
  orderStatus: OrderStatus,
  numberStatus: NumberStatus,
  command: Parameters<typeof decideOrderNumberTransition>[0]["command"],
  otpReceived = false,
) {
  return decideOrderNumberTransition({
    orderId: ORDER_ID,
    orderStatus,
    numberStatus,
    otpReceived,
    command,
  });
}

// **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.6**
describe("order and number state machine", () => {
  it("pairs reservation and activation with their number CAS transitions", () => {
    expect(decide("created", "available", { type: "reserve" })).toMatchObject({
      kind: "apply",
      expectedOrderStatus: "created",
      expectedNumberStatus: "available",
      nextOrderStatus: "reserved",
      nextNumberStatus: "reserved",
    });


    expect(decide("reserved", "reserved", { type: "activate" })).toMatchObject({
      kind: "apply",
      expectedOrderStatus: "reserved",
      expectedNumberStatus: "reserved",
      nextOrderStatus: "waiting_sms",
      nextNumberStatus: "busy",
    });
  });

  it("rejects a transition when the paired number cannot satisfy its CAS predicate", () => {
    expect(decide("reserved", "available", { type: "activate" })).toMatchObject({
      kind: "reject",
      code: "STATE_CONFLICT",
      reason: "number_state_mismatch",
      nextOrderStatus: "reserved",
      nextNumberStatus: "available",
    });
  });

  it("accepts cancel at the minimum boundary and releases a live number", () => {
    const result = decide("waiting_sms", "busy", {
      type: "cancel",
      reason: "BUYER_REQUEST",
      createdAtMs: CREATED_AT,
      observedAtMs: CREATED_AT + THREE_MINUTES,
      minimumCancelAgeMs: THREE_MINUTES,
      release: release(),
    });

    expect(result).toMatchObject({
      kind: "apply",
      nextOrderStatus: "cancelled",
      nextNumberStatus: "available",
      releaseDisposition: "available",
    });
  });

  it("rejects cancel before the minimum age or after OTP receipt", () => {
    const earlyCommand = {
      type: "cancel" as const,
      reason: "BUYER_REQUEST",
      createdAtMs: CREATED_AT,
      observedAtMs: CREATED_AT + THREE_MINUTES - 1,
      minimumCancelAgeMs: THREE_MINUTES,
      release: release({
        observedAtMs: CREATED_AT + THREE_MINUTES - 1,
      }),
    };

    expect(decide("waiting_sms", "busy", earlyCommand)).toMatchObject({
      kind: "reject",
      code: "CANCEL_NOT_ALLOWED",
      reason: "cancel_too_early",
    });
    expect(decide("waiting_sms", "busy", {
      ...earlyCommand,
      observedAtMs: CREATED_AT + THREE_MINUTES,
      release: release(),
    }, true)).toMatchObject({
      kind: "reject",
      code: "CANCEL_NOT_ALLOWED",
      reason: "otp_already_received",
    });
  });


  it("allows MAIN_COMPENSATION to bypass timing only before activation", () => {
    const command = {
      type: "cancel" as const,
      reason: "MAIN_COMPENSATION",
      createdAtMs: CREATED_AT,
      observedAtMs: CREATED_AT + 1,
      minimumCancelAgeMs: THREE_MINUTES,
      release: release({ observedAtMs: CREATED_AT + 1, deviceLastSeenAtMs: CREATED_AT }),
    };

    expect(decide("reserved", "reserved", command)).toMatchObject({
      kind: "apply",
      nextOrderStatus: "cancelled",
    });
    expect(decide("waiting_sms", "busy", command)).toMatchObject({
      kind: "reject",
      code: "CANCEL_NOT_ALLOWED",
      reason: "cancel_too_early",
    });
  });

  it("times out at expiry, rejects an early timeout, and never times out after OTP", () => {
    const expiresAtMs = CREATED_AT + 20 * 60 * 1_000;
    const command = {
      type: "timeout" as const,
      expiresAtMs,
      observedAtMs: expiresAtMs,
      release: release({ observedAtMs: expiresAtMs, deviceLastSeenAtMs: expiresAtMs - 30_000 }),
    };

    expect(decide("waiting_sms", "busy", command)).toMatchObject({
      kind: "apply",
      nextOrderStatus: "timeout",
      nextNumberStatus: "available",
    });
    expect(decide("waiting_sms", "busy", { ...command, observedAtMs: expiresAtMs - 1, release: { ...command.release, observedAtMs: expiresAtMs - 1 } })).toMatchObject({
      kind: "reject",
      reason: "timeout_not_reached",
    });
    expect(decide("waiting_sms", "busy", command, true)).toMatchObject({
      kind: "reject",
      reason: "otp_already_received",
    });
  });

  it("moves valid OTP success to a terminal state and releases the number", () => {
    expect(decide("waiting_sms", "busy", { type: "succeed", release: release() })).toMatchObject({
      kind: "apply",
      nextOrderStatus: "success",
      nextNumberStatus: "available",
    });
  });


  it("treats terminal states as absorbing and same-terminal retries as no-ops", () => {
    const cancel = {
      type: "cancel" as const,
      reason: "BUYER_REQUEST",
      createdAtMs: CREATED_AT,
      observedAtMs: CREATED_AT + THREE_MINUTES,
      minimumCancelAgeMs: THREE_MINUTES,
      release: release(),
    };

    expect(decide("cancelled", "available", cancel)).toMatchObject({
      kind: "no_change",
      reason: "already_applied",
      nextOrderStatus: "cancelled",
      nextNumberStatus: "available",
    });
    expect(decide("success", "available", cancel)).toMatchObject({
      kind: "reject",
      code: "TERMINAL_STATE_CONFLICT",
      reason: "different_terminal_state",
    });
    expect(decide("success", "available", { type: "activate" })).toMatchObject({
      kind: "reject",
      code: "STATE_CONFLICT",
      reason: "terminal_absorbing",
    });
  });

  it("rejects edges not present in the order state machine", () => {
    expect(decide("created", "available", { type: "succeed", release: release() })).toMatchObject({
      kind: "reject",
      reason: "illegal_transition",
    });
    expect(decide("reserved", "reserved", { type: "fail", release: release() })).toMatchObject({
      kind: "reject",
      reason: "illegal_transition",
    });
  });

  it.each([
    ["disabled device", release({ deviceStatus: "disabled" })],
    ["stale heartbeat", release({ deviceLastSeenAtMs: CREATED_AT + THREE_MINUTES - 90_001 })],
    ["future heartbeat", release({ deviceLastSeenAtMs: CREATED_AT + THREE_MINUTES + 1 })],
    ["disabled number", release({ numberEnabled: false })],
    ["missing heartbeat", release({ deviceLastSeenAtMs: null })],
  ])("releases offline for %s", (_case, context) => {
    expect(decideNumberRelease(context)).toBe("offline");
  });

  it("uses the inclusive heartbeat boundary from server-observed time", () => {
    expect(decideNumberRelease(release({
      deviceLastSeenAtMs: CREATED_AT + THREE_MINUTES - 90_000,
    }))).toBe("available");
  });

  it("creates stable operation keys from the order and target state", () => {
    expect(createOrderTransitionOperationKey(ORDER_ID, "cancelled")).toBe(
      "order-transition:order%3Apartner%2F42:cancelled",
    );
    expect(createOrderTransitionOperationKey(ORDER_ID, "cancelled")).toBe(
      createOrderTransitionOperationKey(ORDER_ID, "cancelled"),
    );
    expect(createOrderTransitionOperationKey(ORDER_ID, "timeout")).not.toBe(
      createOrderTransitionOperationKey(ORDER_ID, "cancelled"),
    );
  });
});
