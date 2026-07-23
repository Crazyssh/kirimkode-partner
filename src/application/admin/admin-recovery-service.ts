/**
 * Admin-initiated order recovery service (task 15.4, requirement 16.6).
 *
 * Lets an admin drive a stuck order to a terminal state — release/fail, cancel,
 * or timeout — but only ever through the existing compare-and-set transition
 * commands (task 9.4 / 13.2), never an ad-hoc write. Each recovery:
 *   - requires the {@link RECOVERY_ADMIN_PERMISSION} (least privilege);
 *   - requires a non-empty reason;
 *   - runs the chosen CAS command, which is idempotent (keyed by the request id)
 *     and enforced by the pure state machine, so a retry replays the first
 *     outcome and a `success` order can never be recovered — the command is the
 *     double-processing protection (requirement 16.6);
 *   - writes an `order.manual_transition` audit event capturing the actor,
 *     operation, reason, and outcome (requirement 19.1).
 *
 * The command result is mapped onto a small tagged union so the transport never
 * relies on thrown control flow or leaks internal detail.
 */
import { createAuditEvent } from "@domain/task-5-7";
import {
  adminHasPermission,
  RECOVERY_ADMIN_PERMISSION,
  type AuthenticatedAdmin,
} from "@domain/task-7-5";

import type {
  Clock,
  IdGenerator,
  OrderRecoveryExecutor,
  RecoveryAuditWriter,
  TerminalResult,
} from "./recovery-ports";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LENGTH = 500;

/** The three recovery operations, each backed by a CAS transition command. */
export type RecoveryOperation = "fail" | "cancel" | "timeout";

const RECOVERY_OPERATIONS: ReadonlySet<string> = new Set<RecoveryOperation>([
  "fail",
  "cancel",
  "timeout",
]);

export interface AdminRecoveryInput {
  readonly admin: AuthenticatedAdmin;
  readonly orderId: string;
  readonly operation: string;
  readonly reason: string;
  /** Request identity: used as both the idempotency key and audit request id. */
  readonly requestId: string;
}

export type AdminRecoveryOutcome =
  | { readonly ok: true; readonly status: string; readonly terminalReason: string }
  | { readonly ok: false; readonly reason: "forbidden" }
  | { readonly ok: false; readonly reason: "validation"; readonly code: string }
  | { readonly ok: false; readonly reason: "command_failed"; readonly code: string; readonly retryable: boolean };

export interface AdminRecoveryServiceDeps {
  readonly executor: OrderRecoveryExecutor;
  readonly audit: RecoveryAuditWriter;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export class AdminRecoveryService {
  private readonly deps: AdminRecoveryServiceDeps;

  constructor(deps: AdminRecoveryServiceDeps) {
    this.deps = deps;
  }

  async recover(input: AdminRecoveryInput): Promise<AdminRecoveryOutcome> {
    if (!adminHasPermission(input.admin.permissions, RECOVERY_ADMIN_PERMISSION)) {
      return { ok: false, reason: "forbidden" };
    }
    if (!UUID_PATTERN.test(input.orderId)) {
      return { ok: false, reason: "validation", code: "INVALID_ORDER_ID" };
    }
    if (!RECOVERY_OPERATIONS.has(input.operation)) {
      return { ok: false, reason: "validation", code: "INVALID_OPERATION" };
    }
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
      return { ok: false, reason: "validation", code: "INVALID_REASON" };
    }
    const operation = input.operation as RecoveryOperation;

    const now = this.deps.clock.nowEpochMs();
    const result = await this.runCommand(operation, input, reason, now);
    const outcome = interpret(result);

    // Audit every recovery attempt (success or failure) — the state itself was
    // only ever changed by the CAS command, this records who tried what.
    await this.deps.audit.record({
      id: this.deps.idGenerator.uuid(),
      partnerId: null,
      requestId: input.requestId,
      descriptor: createAuditEvent({
        actorType: "partner_admin",
        actorRef: input.admin.adminId,
        action: "order.manual_transition",
        targetType: "partner_order",
        targetId: input.orderId,
        result: outcome.ok ? "success" : "failure",
        occurredAtEpochMs: now,
        metadata: outcome.ok
          ? { operation, reason, resultStatus: outcome.status }
          : { operation, reason, errorCode: outcome.code },
      }),
    });

    return outcome;
  }

  private runCommand(
    operation: RecoveryOperation,
    input: AdminRecoveryInput,
    reason: string,
    now: number,
  ): Promise<TerminalResult> {
    const base = {
      orderId: input.orderId,
      principalId: input.admin.adminId,
      idempotencyKey: input.requestId,
      method: "POST",
      path: `/admin/recovery/${operation}`,
    } as const;

    switch (operation) {
      case "cancel":
        return this.deps.executor.cancel({ ...base, reason, actorRef: input.admin.adminId });
      case "timeout":
        return this.deps.executor.timeout({ ...base, observedAtEpochMs: now, reason });
      case "fail":
        return this.deps.executor.fail({ ...base, reason, actorRef: input.admin.adminId });
    }
  }
}

/** The subset of outcomes a command result can produce (never forbidden/validation). */
type RecoveryCommandOutcome =
  | { readonly ok: true; readonly status: string; readonly terminalReason: string }
  | { readonly ok: false; readonly reason: "command_failed"; readonly code: string; readonly retryable: boolean };

/** Map a {@link TerminalResult} onto the admin recovery outcome union. */
function interpret(result: TerminalResult): RecoveryCommandOutcome {
  if (result.statusCode === 200 && "data" in result.body) {
    return {
      ok: true,
      status: result.body.data.status,
      terminalReason: result.body.data.terminalReason,
    };
  }
  if ("error" in result.body) {
    return {
      ok: false,
      reason: "command_failed",
      code: result.body.error.code,
      retryable: result.body.error.retryable,
    };
  }
  return { ok: false, reason: "command_failed", code: "UNKNOWN", retryable: false };
}
