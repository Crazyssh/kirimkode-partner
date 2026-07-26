import { describe, expect, it } from "vitest";

import {
  createListeningReleaseOperationKey,
  decideListeningHoldRelease,
  isListeningOrder,
  type ListeningHoldReleaseInput,
  type ListeningOrderState,
} from "./order-listening-window";
import type { ServerObservedReleaseContext } from "./order-state-machine";

const NOW = Date.UTC(2026, 6, 26, 10, 0, 0);
const EXPIRES = NOW + 20 * 60_000;
const ORDER_ID = "order-1";

const order = (over: Partial<ListeningOrderState> = {}): ListeningOrderState => ({
  orderId: ORDER_ID,
  orderStatus: "success",
  completedAtMs: null,
  expiresAtMs: EXPIRES,
  ...over,
});

/** An online device seen just now: release lands the number back on `available`. */
const onlineRelease = (observedAtMs: number): ServerObservedReleaseContext => ({
  numberEnabled: true,
  deviceStatus: "online",
  deviceLastSeenAtMs: observedAtMs - 1_000,
  observedAtMs,
  heartbeatTimeoutMs: 90_000,
});

const input = (over: Partial<ListeningHoldReleaseInput> = {}): ListeningHoldReleaseInput => {
  const observedAtMs = over.observedAtMs ?? NOW;
  return {
    order: order(),
    numberStatus: "busy",
    numberCurrentOrderId: ORDER_ID,
    trigger: "buyer_complete",
    observedAtMs,
    release: onlineRelease(observedAtMs),
    ...over,
  };
};

describe("isListeningOrder", () => {
  it("is true for a successful, uncompleted order inside its window", () => {
    expect(isListeningOrder(order(), NOW)).toBe(true);
    // The window is inclusive of the deadline, matching the SMS matcher.
    expect(isListeningOrder(order(), EXPIRES)).toBe(true);
  });

  it("is false once the hold was released, the window closed, or before success", () => {
    expect(isListeningOrder(order({ completedAtMs: NOW }), NOW)).toBe(false);
    expect(isListeningOrder(order(), EXPIRES + 1)).toBe(false);
    for (const orderStatus of ["waiting_sms", "reserved", "cancelled", "timeout", "failed"] as const) {
      expect(isListeningOrder(order({ orderStatus }), NOW)).toBe(false);
    }
  });

  it("is false for non-finite instants", () => {
    expect(isListeningOrder(order({ expiresAtMs: Number.NaN }), NOW)).toBe(false);
    expect(isListeningOrder(order(), Number.NaN)).toBe(false);
  });
});

describe("decideListeningHoldRelease", () => {
  it("releases the hold on buyer completion and stamps completedAt", () => {
    const decision = decideListeningHoldRelease(input());
    expect(decision).toEqual({
      kind: "apply",
      operationKey: createListeningReleaseOperationKey(ORDER_ID),
      completedAtMs: NOW,
      nextNumberStatus: "available",
      numberChanged: true,
      releaseDisposition: "available",
    });
  });

  it("parks the number offline when the device is no longer beating", () => {
    const decision = decideListeningHoldRelease(input({
      release: { ...onlineRelease(NOW), deviceLastSeenAtMs: NOW - 10 * 60_000 },
    }));
    expect(decision).toMatchObject({
      kind: "apply", nextNumberStatus: "offline", releaseDisposition: "offline",
    });
  });

  it("is idempotent once the hold was already released", () => {
    const decision = decideListeningHoldRelease(input({ order: order({ completedAtMs: NOW - 1 }) }));
    expect(decision).toEqual({
      kind: "no_change",
      operationKey: createListeningReleaseOperationKey(ORDER_ID),
      reason: "already_completed",
    });
  });

  it("refuses an order that never succeeded", () => {
    for (const orderStatus of ["waiting_sms", "reserved", "cancelled", "timeout", "failed"] as const) {
      expect(decideListeningHoldRelease(input({ order: order({ orderStatus }) }))).toMatchObject({
        kind: "reject", code: "STATE_CONFLICT", reason: "order_not_successful",
      });
    }
  });

  it("lets the sweep close only an expired window", () => {
    // Still open: the sweep must not steal the buyer's remaining time.
    expect(decideListeningHoldRelease(input({ trigger: "expiry_sweep" }))).toMatchObject({
      kind: "reject", reason: "window_still_open",
    });
    expect(decideListeningHoldRelease(input({
      trigger: "expiry_sweep", observedAtMs: EXPIRES,
    }))).toMatchObject({ kind: "reject", reason: "window_still_open" });
    // One millisecond past the deadline the sweep may close it.
    expect(decideListeningHoldRelease(input({
      trigger: "expiry_sweep", observedAtMs: EXPIRES + 1,
    }))).toMatchObject({ kind: "apply", numberChanged: true, releaseDisposition: "available" });
  });

  it("completes without touching a number that has moved on", () => {
    // Another order already holds it, or it was released by another path: the
    // order still completes, but this decision never strips a live holder.
    for (const over of [
      { numberCurrentOrderId: "order-2" },
      { numberCurrentOrderId: null },
      { numberStatus: "available" as const, numberCurrentOrderId: null },
      { numberStatus: "disabled" as const, numberCurrentOrderId: ORDER_ID },
    ]) {
      const decision = decideListeningHoldRelease(input(over));
      expect(decision).toMatchObject({
        kind: "apply",
        completedAtMs: NOW,
        numberChanged: false,
        releaseDisposition: null,
      });
      if (decision.kind !== "apply") throw new Error("unreachable");
      expect(decision.nextNumberStatus).toBe(over.numberStatus ?? "busy");
    }
  });

  it("rejects an inconsistent or non-finite context", () => {
    // The release context must be observed at the same instant as the decision.
    expect(decideListeningHoldRelease(input({
      release: onlineRelease(NOW - 5_000),
    }))).toMatchObject({ kind: "reject", reason: "invalid_transition_context" });
    expect(decideListeningHoldRelease(input({
      order: order({ expiresAtMs: Number.NaN }),
    }))).toMatchObject({ kind: "reject", reason: "invalid_transition_context" });
  });

  it("derives a stable, url-safe operation key", () => {
    expect(createListeningReleaseOperationKey("a b/c")).toBe("order-listening-release:a%20b%2Fc");
  });
});
