export const ORDER_STATUSES = [
  "created",
  "reserved",
  "waiting_sms",
  "success",
  "cancelled",
  "timeout",
  "failed",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type TerminalOrderStatus = Extract<
  OrderStatus,
  "success" | "cancelled" | "timeout" | "failed"
>;
export type NumberStatus =
  | "offline"
  | "available"
  | "reserved"
  | "busy"
  | "disabled";
export type ReleaseDisposition = "available" | "offline";
export type DeviceEffectiveStatus = "online" | "offline" | "disabled";

export interface ServerObservedReleaseContext {
  numberEnabled: boolean;
  deviceStatus: DeviceEffectiveStatus;
  deviceLastSeenAtMs: number | null;
  observedAtMs: number;
  heartbeatTimeoutMs: number;
}

interface TerminalCommandContext {
  release: ServerObservedReleaseContext;
}

export type OrderTransitionCommand =
  | { type: "reserve" }
  | { type: "activate" }
  /**
   * Success carries NO release context: it no longer releases the number. The
   * order keeps holding it while it listens for a repeat OTP, and the hold is
   * released exactly once later — by the buyer completing the order or by the
   * expiry sweep (see `decideListeningHoldRelease` in `order-listening-window`).
   */
  | { type: "succeed" }
  | ({
      type: "cancel";
      reason: string;
      createdAtMs: number;
      observedAtMs: number;
      minimumCancelAgeMs: number;
    } & TerminalCommandContext)
  | ({
      type: "timeout";
      expiresAtMs: number;
      observedAtMs: number;
    } & TerminalCommandContext)
  | ({ type: "fail" } & TerminalCommandContext);


export interface OrderNumberTransitionInput {
  orderId: string;
  orderStatus: OrderStatus;
  numberStatus: NumberStatus;
  otpReceived: boolean;
  command: OrderTransitionCommand;
}

interface DecisionBase {
  operationKey: string;
  targetOrderStatus: OrderStatus;
  nextOrderStatus: OrderStatus;
  nextNumberStatus: NumberStatus;
  releaseDisposition: ReleaseDisposition | null;
}

export interface ApplyTransitionDecision extends DecisionBase {
  kind: "apply";
  expectedOrderStatus: OrderStatus;
  expectedNumberStatus: NumberStatus | null;
  numberChanged: boolean;
}

export interface NoChangeTransitionDecision extends DecisionBase {
  kind: "no_change";
  reason: "already_applied";
}

export interface RejectedTransitionDecision extends DecisionBase {
  kind: "reject";
  code: "STATE_CONFLICT" | "TERMINAL_STATE_CONFLICT" | "CANCEL_NOT_ALLOWED";
  reason:
    | "illegal_transition"
    | "terminal_absorbing"
    | "different_terminal_state"
    | "number_state_mismatch"
    | "cancel_too_early"
    | "otp_already_received"
    | "timeout_not_reached"
    | "invalid_transition_context";
}

export type OrderNumberTransitionDecision =
  | ApplyTransitionDecision
  | NoChangeTransitionDecision
  | RejectedTransitionDecision;

const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "success",
  "cancelled",
  "timeout",
  "failed",
]);

const VALID_SOURCES: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  created: [],
  reserved: ["created"],
  waiting_sms: ["reserved"],
  success: ["waiting_sms"],
  cancelled: ["reserved", "waiting_sms"],
  timeout: ["reserved", "waiting_sms"],
  failed: ["created", "waiting_sms"],
};


function targetStatus(command: OrderTransitionCommand): OrderStatus {
  switch (command.type) {
    case "reserve":
      return "reserved";
    case "activate":
      return "waiting_sms";
    case "succeed":
      return "success";
    case "cancel":
      return "cancelled";
    case "timeout":
      return "timeout";
    case "fail":
      return "failed";
  }
}

export function createOrderTransitionOperationKey(
  orderId: string,
  target: OrderStatus,
): string {
  return `order-transition:${encodeURIComponent(orderId)}:${target}`;
}

export function isTerminalOrderStatus(
  status: OrderStatus,
): status is TerminalOrderStatus {
  return TERMINAL_STATUSES.has(status);
}

function isFiniteTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function hasValidReleaseContext(context: ServerObservedReleaseContext): boolean {
  return (
    isFiniteTimestamp(context.observedAtMs) &&
    Number.isFinite(context.heartbeatTimeoutMs) &&
    context.heartbeatTimeoutMs >= 0 &&
    (context.deviceLastSeenAtMs === null ||
      isFiniteTimestamp(context.deviceLastSeenAtMs))
  );
}

export function decideNumberRelease(
  context: ServerObservedReleaseContext,
): ReleaseDisposition {
  if (
    !context.numberEnabled ||
    context.deviceStatus !== "online" ||
    context.deviceLastSeenAtMs === null ||
    !hasValidReleaseContext(context)
  ) {
    return "offline";
  }

  const heartbeatAgeMs = context.observedAtMs - context.deviceLastSeenAtMs;
  return heartbeatAgeMs >= 0 && heartbeatAgeMs <= context.heartbeatTimeoutMs
    ? "available"
    : "offline";
}

function releaseContextOf(
  command: OrderTransitionCommand,
): ServerObservedReleaseContext | null {
  return "release" in command ? command.release : null;
}


function unchangedDisposition(status: NumberStatus): ReleaseDisposition | null {
  return status === "available" || status === "offline" ? status : null;
}

function rejectTransition(
  input: OrderNumberTransitionInput,
  target: OrderStatus,
  code: RejectedTransitionDecision["code"],
  reason: RejectedTransitionDecision["reason"],
): RejectedTransitionDecision {
  return {
    kind: "reject",
    code,
    reason,
    operationKey: createOrderTransitionOperationKey(input.orderId, target),
    targetOrderStatus: target,
    nextOrderStatus: input.orderStatus,
    nextNumberStatus: input.numberStatus,
    releaseDisposition: null,
  };
}

export function decideOrderNumberTransition(
  input: OrderNumberTransitionInput,
): OrderNumberTransitionDecision {
  const target = targetStatus(input.command);
  const operationKey = createOrderTransitionOperationKey(input.orderId, target);

  if (input.orderStatus === target) {
    return {
      kind: "no_change",
      reason: "already_applied",
      operationKey,
      targetOrderStatus: target,
      nextOrderStatus: input.orderStatus,
      nextNumberStatus: input.numberStatus,
      releaseDisposition: isTerminalOrderStatus(target)
        ? unchangedDisposition(input.numberStatus)
        : null,
    };
  }

  if (isTerminalOrderStatus(input.orderStatus)) {
    if (isTerminalOrderStatus(target)) {
      return rejectTransition(
        input,
        target,
        "TERMINAL_STATE_CONFLICT",
        "different_terminal_state",
      );
    }
    return rejectTransition(input, target, "STATE_CONFLICT", "terminal_absorbing");
  }

  if (!VALID_SOURCES[target].includes(input.orderStatus)) {
    return rejectTransition(input, target, "STATE_CONFLICT", "illegal_transition");
  }

  if (input.command.type === "cancel") {
    const { createdAtMs, minimumCancelAgeMs, observedAtMs, reason, release } =
      input.command;
    if (
      !isFiniteTimestamp(createdAtMs) ||
      !isFiniteTimestamp(observedAtMs) ||
      !Number.isFinite(minimumCancelAgeMs) ||
      minimumCancelAgeMs < 0 ||
      release.observedAtMs !== observedAtMs
    ) {
      return rejectTransition(
        input,
        target,
        "STATE_CONFLICT",
        "invalid_transition_context",
      );
    }
    if (input.otpReceived) {
      return rejectTransition(
        input,
        target,
        "CANCEL_NOT_ALLOWED",
        "otp_already_received",
      );
    }
    const isPreActivationCompensation =
      reason === "MAIN_COMPENSATION" && input.orderStatus === "reserved";
    if (
      !isPreActivationCompensation &&
      observedAtMs - createdAtMs < minimumCancelAgeMs
    ) {
      return rejectTransition(
        input,
        target,
        "CANCEL_NOT_ALLOWED",
        "cancel_too_early",
      );
    }
  }

  if (input.command.type === "timeout") {
    const { expiresAtMs, observedAtMs, release } = input.command;
    if (
      !isFiniteTimestamp(expiresAtMs) ||
      !isFiniteTimestamp(observedAtMs) ||
      release.observedAtMs !== observedAtMs
    ) {
      return rejectTransition(
        input,
        target,
        "STATE_CONFLICT",
        "invalid_transition_context",
      );
    }
    if (input.otpReceived) {
      return rejectTransition(
        input,
        target,
        "STATE_CONFLICT",
        "otp_already_received",
      );
    }
    if (observedAtMs < expiresAtMs) {
      return rejectTransition(
        input,
        target,
        "STATE_CONFLICT",
        "timeout_not_reached",
      );
    }
  }


  let expectedNumberStatus: NumberStatus | null = null;
  let nextNumberStatus = input.numberStatus;
  let releaseDisposition: ReleaseDisposition | null = null;

  if (target === "reserved") {
    expectedNumberStatus = "available";
    nextNumberStatus = "reserved";
  } else if (target === "waiting_sms") {
    expectedNumberStatus = "reserved";
    nextNumberStatus = "busy";
  } else if (target === "success") {
    // Success settles the money but keeps the number held: the order stays bound
    // to it for the listening window so a repeat OTP can still arrive, and so the
    // number cannot be resold while a resent SMS for this buyer is in flight.
    expectedNumberStatus = "busy";
    nextNumberStatus = input.numberStatus;
  } else if (
    isTerminalOrderStatus(target) &&
    input.orderStatus !== "created"
  ) {
    expectedNumberStatus =
      input.orderStatus === "reserved" ? "reserved" : "busy";
    const release = releaseContextOf(input.command);
    if (release === null || !hasValidReleaseContext(release)) {
      return rejectTransition(
        input,
        target,
        "STATE_CONFLICT",
        "invalid_transition_context",
      );
    }
    releaseDisposition = decideNumberRelease(release);
    nextNumberStatus = releaseDisposition;
  }

  if (
    expectedNumberStatus !== null &&
    input.numberStatus !== expectedNumberStatus
  ) {
    return rejectTransition(
      input,
      target,
      "STATE_CONFLICT",
      "number_state_mismatch",
    );
  }

  return {
    kind: "apply",
    operationKey,
    targetOrderStatus: target,
    expectedOrderStatus: input.orderStatus,
    expectedNumberStatus,
    nextOrderStatus: target,
    nextNumberStatus,
    numberChanged: nextNumberStatus !== input.numberStatus,
    releaseDisposition,
  };
}
