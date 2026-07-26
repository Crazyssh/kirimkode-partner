/**
 * Listening window after a successful order (repeat-OTP support).
 *
 * A `success` order used to release its number the instant the first OTP was
 * extracted. That ended the buyer's ability to receive a second code — services
 * routinely resend one — and it opened a real misdelivery hole: the number went
 * straight back on sale, so a resent SMS for the previous buyer could land
 * inside a *new* buyer's order window and be handed to the wrong person.
 *
 * The number hold is therefore decoupled from the order's terminal status. An
 * order keeps holding its number while it is **listening**:
 *
 *   - its status is `success` (money already settled, exactly once), AND
 *   - `completedAt` is still unset (the hold was never released), AND
 *   - the observation instant is not past `expiresAt` (the window is open).
 *
 * While listening, further SMS on that number match this same order and refresh
 * its OTP; the Earning is untouched because it is keyed on the order. The hold
 * ends exactly once, through {@link decideListeningHoldRelease}: either the
 * buyer completes the order, or the expiry sweep closes it. Both paths stamp
 * `completedAt`, so completion is idempotent and a swept order is never
 * re-processed.
 *
 * Pure domain: no clock, no I/O — every instant is injected.
 */
import {
  decideNumberRelease,
  type NumberStatus,
  type OrderStatus,
  type ReleaseDisposition,
  type ServerObservedReleaseContext,
} from "./order-state-machine";

/** What asked for the hold to be released. */
export type ListeningReleaseTrigger = "buyer_complete" | "expiry_sweep";

/** The order fields the listening predicate and release decision read. */
export interface ListeningOrderState {
  readonly orderId: string;
  readonly orderStatus: OrderStatus;
  /** Null while the order still holds its number after success. */
  readonly completedAtMs: number | null;
  /** The order's timeout deadline; also closes the listening window. */
  readonly expiresAtMs: number;
}

export interface ListeningHoldReleaseInput {
  readonly order: ListeningOrderState;
  /** Current status of the order's number. */
  readonly numberStatus: NumberStatus;
  /**
   * The order id the number currently points at, or null when it points at
   * none. A number that has moved on to another order is never released here.
   */
  readonly numberCurrentOrderId: string | null;
  readonly trigger: ListeningReleaseTrigger;
  readonly observedAtMs: number;
  /** Server-observed context deciding `available` vs `offline` on release. */
  readonly release: ServerObservedReleaseContext;
}

export interface ApplyListeningReleaseDecision {
  readonly kind: "apply";
  readonly operationKey: string;
  /** Always stamped, so a completed order can never be swept again. */
  readonly completedAtMs: number;
  readonly nextNumberStatus: NumberStatus;
  /** False when this order no longer holds the number (nothing to release). */
  readonly numberChanged: boolean;
  readonly releaseDisposition: ReleaseDisposition | null;
}

export interface NoChangeListeningReleaseDecision {
  readonly kind: "no_change";
  readonly operationKey: string;
  readonly reason: "already_completed";
}

export interface RejectedListeningReleaseDecision {
  readonly kind: "reject";
  readonly operationKey: string;
  readonly code: "STATE_CONFLICT";
  readonly reason:
    | "order_not_successful"
    | "window_still_open"
    | "invalid_transition_context";
}

export type ListeningHoldReleaseDecision =
  | ApplyListeningReleaseDecision
  | NoChangeListeningReleaseDecision
  | RejectedListeningReleaseDecision;

/** Number statuses that mean this order is still physically holding the number. */
const HELD_STATUSES: ReadonlySet<NumberStatus> = new Set<NumberStatus>(["busy", "reserved"]);

function isFiniteTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function createListeningReleaseOperationKey(orderId: string): string {
  return `order-listening-release:${encodeURIComponent(orderId)}`;
}

/**
 * True when the order still holds its number and may still receive another OTP.
 * The window is inclusive of `expiresAtMs`, matching the SMS matcher's window
 * check, so an SMS arriving exactly at the deadline is not silently dropped.
 */
export function isListeningOrder(
  order: ListeningOrderState,
  observedAtMs: number,
): boolean {
  return (
    order.orderStatus === "success"
    && order.completedAtMs === null
    && isFiniteTimestamp(order.expiresAtMs)
    && isFiniteTimestamp(observedAtMs)
    && observedAtMs <= order.expiresAtMs
  );
}

/**
 * Decide whether to release a listening order's number hold.
 *
 * Both triggers converge on one apply shape that always stamps `completedAt`:
 * the buyer may close the window early, and the sweep may only close it once the
 * deadline has passed. When the number has already moved on (another order holds
 * it, or it was released by another path) the decision still completes the order
 * but leaves the number alone — `numberChanged: false` — so a stale row can
 * never strip a live order of its number.
 */
export function decideListeningHoldRelease(
  input: ListeningHoldReleaseInput,
): ListeningHoldReleaseDecision {
  const operationKey = createListeningReleaseOperationKey(input.order.orderId);

  if (
    !isFiniteTimestamp(input.observedAtMs)
    || !isFiniteTimestamp(input.order.expiresAtMs)
    || input.release.observedAtMs !== input.observedAtMs
  ) {
    return { kind: "reject", operationKey, code: "STATE_CONFLICT", reason: "invalid_transition_context" };
  }

  // Idempotent: the hold was already released by the buyer or a prior sweep.
  if (input.order.completedAtMs !== null) {
    return { kind: "no_change", operationKey, reason: "already_completed" };
  }

  // Only a settled order owns a listening window; anything else is a conflict.
  if (input.order.orderStatus !== "success") {
    return { kind: "reject", operationKey, code: "STATE_CONFLICT", reason: "order_not_successful" };
  }

  // The sweep exists to close *expired* windows; closing a live one early is
  // the buyer's call alone.
  if (input.trigger === "expiry_sweep" && input.observedAtMs <= input.order.expiresAtMs) {
    return { kind: "reject", operationKey, code: "STATE_CONFLICT", reason: "window_still_open" };
  }

  const stillHolding =
    HELD_STATUSES.has(input.numberStatus)
    && input.numberCurrentOrderId === input.order.orderId;

  if (!stillHolding) {
    return {
      kind: "apply",
      operationKey,
      completedAtMs: input.observedAtMs,
      nextNumberStatus: input.numberStatus,
      numberChanged: false,
      releaseDisposition: null,
    };
  }

  const disposition = decideNumberRelease(input.release);
  return {
    kind: "apply",
    operationKey,
    completedAtMs: input.observedAtMs,
    nextNumberStatus: disposition,
    numberChanged: disposition !== input.numberStatus,
    releaseDisposition: disposition,
  };
}
