/**
 * Ports for admin-initiated order recovery (task 15.4, requirement 16.6).
 *
 * Recovery never writes order/number state directly. It drives a stuck order to
 * a terminal state exclusively through the existing compare-and-set transition
 * commands (task 9.4 / 13.2 {@link import("@application/orders").OrderTransitionService}),
 * which own idempotency, the pure state machine, and the paired number release —
 * so a recovery can never double-process or tear down a terminal order. The
 * {@link OrderRecoveryExecutor} port is exactly the subset of those commands the
 * admin service uses; the concrete service instance satisfies it structurally.
 * A separate {@link RecoveryAuditWriter} records the manual transition.
 */
import type {
  CancelCommandInput,
  FailCommandInput,
  TerminalResult,
  TimeoutCommandInput,
} from "@application/orders";
import type { AuditEventDescriptor } from "@domain/task-5-7";

export type { CancelCommandInput, FailCommandInput, TimeoutCommandInput, TerminalResult };

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Generates opaque identifiers (UUIDs) for audit events. */
export interface IdGenerator {
  uuid(): string;
}

/**
 * The compare-and-set terminal transition commands recovery reuses. Each is
 * idempotent (keyed by the supplied idempotency key) and enforces the state
 * machine, so an illegal or already-applied transition is deterministic.
 */
export interface OrderRecoveryExecutor {
  cancel(input: CancelCommandInput): Promise<TerminalResult>;
  timeout(input: TimeoutCommandInput): Promise<TerminalResult>;
  fail(input: FailCommandInput): Promise<TerminalResult>;
}

/** Persists the `order.manual_transition` audit event for a recovery attempt. */
export interface RecoveryAuditWriter {
  record(input: {
    readonly id: string;
    readonly partnerId: string | null;
    readonly requestId: string;
    readonly descriptor: AuditEventDescriptor;
  }): Promise<void>;
}
