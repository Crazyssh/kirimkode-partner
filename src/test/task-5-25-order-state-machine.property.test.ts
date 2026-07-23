import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  createOrderTransitionOperationKey,
  decideNumberRelease,
  decideOrderNumberTransition,
  isTerminalOrderStatus,
  ORDER_STATUSES,
  type NumberStatus,
  type OrderStatus,
  type OrderTransitionCommand,
  type ServerObservedReleaseContext,
} from "@domain/order-state-machine";

// Feature: partner-platform, Property 18: State machine order menolak transisi ilegal
//
// For all status order dan sequence command, transition function hanya menerima
// edge yang ada pada state machine order; seluruh terminal bersifat absorbing,
// terminal berbeda ditolak (`TERMINAL_STATE_CONFLICT`), dan pengulangan command
// terminal yang sama tidak menghasilkan efek baru (no_change idempotent). Order
// tidak pernah berpindah ke status yang bukan hasil edge legal, sehingga refund
// atau earning tidak dapat digandakan.
//
// **Validates: Requirements 12.1, 12.3, 12.6**
//
// Design references:
// - Order state machine edges (Components §9 "Partner Order" diagram): only
//   created→reserved, reserved→waiting_sms, created→failed, reserved→cancelled,
//   reserved→timeout, waiting_sms→{success,cancelled,timeout,failed} exist.
// - Terminal = success|cancelled|timeout|failed; success cannot be cancelled or
//   timed out; every transition is CAS on expected state; retry of the same
//   transition returns the already-reached state; a different terminal yields
//   TERMINAL_STATE_CONFLICT with no second money effect (Components §9).
// - Requirement 12.1 enumerates the supported statuses; 12.3 makes the success
//   transition idempotent; 12.6 forbids conflicting terminal transitions.
// - Testing Strategy: the order state machine is a 500-run target on nightly CI.
// - Pure domain test tidak memakai DB/network (Testing Strategy).

const NUM_RUNS = 500;

const ORDER_ID = "order:partner/7f3c";
const CREATED_AT = Date.parse("2026-05-01T00:00:00.000Z");
const MIN_CANCEL_MS = 3 * 60 * 1_000;
const TIMEOUT_MS = 20 * 60 * 1_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;

const ALL_NUMBER_STATUSES: readonly NumberStatus[] = [
  "offline",
  "available",
  "reserved",
  "busy",
  "disabled",
];

// A release context that is always well-formed and, with an online device seen
// 30s ago, always resolves to an "available" disposition. Number release policy
// is Property 19's concern; here we only need the terminal transitions to reach
// the "apply" branch so the order-machine edge is genuinely exercised.
function validRelease(observedAtMs: number): ServerObservedReleaseContext {
  return {
    numberEnabled: true,
    deviceStatus: "online",
    deviceLastSeenAtMs: observedAtMs - 30_000,
    observedAtMs,
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
  };
}

// Command generators are deliberately guard-satisfying: timestamps are finite,
// cancel is past the minimum age, timeout is at/after expiry, and the release
// observed time matches the command observed time. This isolates the property
// to state-machine edge legality + terminal semantics, keeping timing/number
// guards (Properties 19+) out of scope while still allowing legal edges to
// apply and illegal ones to reject.
const commandArbitrary: fc.Arbitrary<OrderTransitionCommand> = fc.oneof(
  fc.constant<OrderTransitionCommand>({ type: "reserve" }),
  fc.constant<OrderTransitionCommand>({ type: "activate" }),
  fc
    .constant(CREATED_AT + TIMEOUT_MS)
    .map<OrderTransitionCommand>((observedAtMs) => ({
      type: "succeed",
      release: validRelease(observedAtMs),
    })),
  fc
    .record({
      reason: fc.constantFrom("BUYER_REQUEST", "MAIN_COMPENSATION"),
      createdAtMs: fc.integer({ min: 0, max: CREATED_AT }),
      age: fc.integer({ min: MIN_CANCEL_MS, max: MIN_CANCEL_MS + TIMEOUT_MS }),
    })
    .map<OrderTransitionCommand>(({ reason, createdAtMs, age }) => {
      const observedAtMs = createdAtMs + age;
      return {
        type: "cancel",
        reason,
        createdAtMs,
        observedAtMs,
        minimumCancelAgeMs: MIN_CANCEL_MS,
        release: validRelease(observedAtMs),
      };
    }),
  fc
    .record({
      expiresAtMs: fc.integer({ min: CREATED_AT, max: CREATED_AT + TIMEOUT_MS }),
      delta: fc.integer({ min: 0, max: TIMEOUT_MS }),
    })
    .map<OrderTransitionCommand>(({ expiresAtMs, delta }) => {
      const observedAtMs = expiresAtMs + delta;
      return {
        type: "timeout",
        expiresAtMs,
        observedAtMs,
        release: validRelease(observedAtMs),
      };
    }),
  fc
    .constant(CREATED_AT + TIMEOUT_MS)
    .map<OrderTransitionCommand>((observedAtMs) => ({
      type: "fail",
      release: validRelease(observedAtMs),
    })),
);

const scenarioArbitrary = fc.record({
  orderStatus: fc.constantFrom(...ORDER_STATUSES),
  numberStatus: fc.constantFrom(...ALL_NUMBER_STATUSES),
  otpReceived: fc.boolean(),
  commands: fc.array(commandArbitrary, { minLength: 1, maxLength: 6 }),
});

// --- Independent oracle restated from the design §9 order state machine ------

// Legal edges transcribed directly from the "Partner Order" diagram, keyed by
// the target state (not reusing the production VALID_SOURCES table).
const LEGAL_SOURCES: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  created: [],
  reserved: ["created"],
  waiting_sms: ["reserved"],
  success: ["waiting_sms"],
  cancelled: ["reserved", "waiting_sms"],
  timeout: ["reserved", "waiting_sms"],
  failed: ["created", "waiting_sms"],
};

function commandTarget(command: OrderTransitionCommand): OrderStatus {
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

// Number status the CAS predicate requires for a legal edge to apply. `null`
// means the edge imposes no number-state precondition (created→failed).
function requiredNumberSource(
  orderStatus: OrderStatus,
  target: OrderStatus,
): NumberStatus | null {
  if (target === "reserved") return "available";
  if (target === "waiting_sms") return "reserved";
  // Terminal targets from an active order require the paired number state.
  if (orderStatus === "reserved") return "reserved";
  if (orderStatus === "waiting_sms") return "busy";
  return null; // created→failed
}

type Predicted =
  | { kind: "no_change" }
  | {
      kind: "reject";
      code: "STATE_CONFLICT" | "TERMINAL_STATE_CONFLICT" | "CANCEL_NOT_ALLOWED";
      reason: string;
    }
  | { kind: "apply" };

function classify(
  orderStatus: OrderStatus,
  numberStatus: NumberStatus,
  otpReceived: boolean,
  command: OrderTransitionCommand,
): Predicted {
  const target = commandTarget(command);

  // Retry of the already-reached state (12.3/12.6): idempotent no-op.
  if (orderStatus === target) {
    return { kind: "no_change" };
  }

  // Terminal states are absorbing (12.6).
  if (isTerminalOrderStatus(orderStatus)) {
    if (isTerminalOrderStatus(target)) {
      return {
        kind: "reject",
        code: "TERMINAL_STATE_CONFLICT",
        reason: "different_terminal_state",
      };
    }
    return { kind: "reject", code: "STATE_CONFLICT", reason: "terminal_absorbing" };
  }

  // Only edges present on the state machine are accepted (12.1).
  if (!LEGAL_SOURCES[target].includes(orderStatus)) {
    return { kind: "reject", code: "STATE_CONFLICT", reason: "illegal_transition" };
  }

  // Legal edge from a non-terminal source. OTP receipt blocks cancel/timeout
  // before the number CAS is evaluated.
  if (command.type === "cancel" && otpReceived) {
    return {
      kind: "reject",
      code: "CANCEL_NOT_ALLOWED",
      reason: "otp_already_received",
    };
  }
  if (command.type === "timeout" && otpReceived) {
    return { kind: "reject", code: "STATE_CONFLICT", reason: "otp_already_received" };
  }

  const required = requiredNumberSource(orderStatus, target);
  if (required !== null && numberStatus !== required) {
    return { kind: "reject", code: "STATE_CONFLICT", reason: "number_state_mismatch" };
  }

  return { kind: "apply" };
}

// Expected next number status for an applied edge, derived independently.
function appliedNextNumber(
  orderStatus: OrderStatus,
  target: OrderStatus,
  currentNumber: NumberStatus,
  command: OrderTransitionCommand,
): NumberStatus {
  if (target === "reserved") return "reserved";
  if (target === "waiting_sms") return "busy";
  if (orderStatus === "created") return currentNumber; // created→failed: number untouched
  // Terminal from an active order releases via the release context.
  const release = "release" in command ? command.release : null;
  return release === null ? currentNumber : decideNumberRelease(release);
}

describe("Property 18: state machine order menolak transisi ilegal", () => {
  it("accepts only legal edges, keeps terminals absorbing, and makes retries effect-free across command sequences", () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ orderStatus, numberStatus, otpReceived, commands }) => {
        let currentOrder: OrderStatus = orderStatus;
        let currentNumber: NumberStatus = numberStatus;

        for (const command of commands) {
          const target = commandTarget(command);
          const prevOrder = currentOrder;
          const prevNumber = currentNumber;
          const wasTerminal = isTerminalOrderStatus(prevOrder);

          const commandSnapshot = structuredClone(command);
          const input = {
            orderId: ORDER_ID,
            orderStatus: prevOrder,
            numberStatus: prevNumber,
            otpReceived,
            command,
          };

          const decision = decideOrderNumberTransition(input);

          // Determinism: a repeated call on identical inputs is deep-equal, and
          // evaluating the transition never mutates its inputs.
          expect(decideOrderNumberTransition(input)).toStrictEqual(decision);
          expect(command).toStrictEqual(commandSnapshot);

          // Operation key is a stable function of orderId + target state.
          expect(decision.operationKey).toBe(
            createOrderTransitionOperationKey(ORDER_ID, target),
          );
          expect(decision.targetOrderStatus).toBe(target);

          const predicted = classify(prevOrder, prevNumber, otpReceived, command);

          if (predicted.kind === "no_change") {
            // (12.3, 12.6) Retrying the reached state is an idempotent no-op.
            expect(decision.kind).toBe("no_change");
            expect(decision.nextOrderStatus).toBe(prevOrder);
            expect(decision.nextNumberStatus).toBe(prevNumber);
          } else if (predicted.kind === "reject") {
            // (12.1, 12.6) Illegal or conflicting transitions are rejected and
            // never advance the order or number state.
            expect(decision.kind).toBe("reject");
            if (decision.kind === "reject") {
              expect(decision.code).toBe(predicted.code);
              expect(decision.reason).toBe(predicted.reason);
            }
            expect(decision.nextOrderStatus).toBe(prevOrder);
            expect(decision.nextNumberStatus).toBe(prevNumber);
            expect(decision.releaseDisposition).toBeNull();
          } else {
            // (12.1) Only legal edges apply; the order advances exactly to the
            // command target and the paired number CAS is honored.
            expect(decision.kind).toBe("apply");
            if (decision.kind === "apply") {
              expect(decision.expectedOrderStatus).toBe(prevOrder);
              expect(decision.nextOrderStatus).toBe(target);
              expect(decision.nextNumberStatus).toBe(
                appliedNextNumber(prevOrder, target, prevNumber, command),
              );
              const required = requiredNumberSource(prevOrder, target);
              expect(decision.expectedNumberStatus).toBe(required);
            }
          }

          // (12.6) A terminal order is absorbing: no command can move it and no
          // second effect is produced.
          if (wasTerminal) {
            expect(decision.kind).not.toBe("apply");
            expect(decision.nextOrderStatus).toBe(prevOrder);
          }

          if (decision.kind === "apply") {
            // An apply only ever targets a legal, non-terminal-source edge.
            expect(isTerminalOrderStatus(prevOrder)).toBe(false);
            expect(LEGAL_SOURCES[target]).toContain(prevOrder);
            currentOrder = decision.nextOrderStatus;
            currentNumber = decision.nextNumberStatus;
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
