/**
 * Order cancel/timeout transition service for Internal API v1 (task 9.4).
 *
 * Handles `POST /orders/{id}/cancel` and `POST /orders/{id}/timeout`
 * (Idempotency-Key required). Both turn a Main-initiated request into a
 * deterministic terminal outcome plus the number's `releaseDisposition`,
 * reusing the pieces built earlier so each rule lives in exactly one place:
 *
 *  - **Idempotency (task 9.2).** The whole effect runs inside
 *    {@link IdempotencyEngine.runIdempotent} with `operational` retention (90
 *    days) — cancel/timeout are pure state changes, not money moves. A retry
 *    with the same key + payload replays the first terminal result verbatim, so
 *    a number release can never be applied twice (requirements 10.3–10.5,
 *    12.4, 12.5).
 *  - **State machine (task 5.5).** `decideOrderNumberTransition` owns the
 *    legality of the transition: cancel is allowed only after the configured
 *    minimum age unless the reason is `MAIN_COMPENSATION` on a still-`reserved`
 *    order; a `success` order (OTP received) can never be cancelled or timed
 *    out; a differing terminal state is rejected; and the paired number release
 *    (`→available` when the device is live/enabled, else `→offline`) is decided
 *    by `decideNumberRelease` (requirement 12.6).
 *
 * Determinism for the saga: a already-applied identical terminal transition is
 * reported as success (idempotent), an illegal or conflicting transition maps
 * to a stable safe error, and a transient failure throws to roll the
 * transaction back with nothing persisted so Main may safely retry.
 */
import {
  decideOrderNumberTransition,
  type OrderTransitionCommand,
  type OrderNumberTransitionDecision,
  type ReleaseDisposition,
} from "@domain/order-state-machine";
import { mapDomainError, type SafeError } from "@domain/task-5-3/safe-errors";
import type { JsonValue } from "@domain/task-5-3/canonical-request-hash";
import { IdempotencyEngine } from "@application/internal-api";

import {
  TerminalTransitionContentionError,
  type Clock,
  type OrderOperationsConfig,
  type OrderTransitionContext,
  type OrderTransitionGateway,
} from "./operations-ports";

/** Idempotency scope namespaces for the terminal operations. */
export const CANCEL_SCOPE = "orders.cancel";
export const TIMEOUT_SCOPE = "orders.timeout";
export const FAIL_SCOPE = "orders.fail";

/** The cancel reason that permits pre-activation compensation by Main. */
const MAIN_COMPENSATION = "MAIN_COMPENSATION";

export interface CancelCommandInput {
  readonly orderId: string;
  readonly principalId: string;
  readonly idempotencyKey: string | null;
  readonly method: string;
  readonly path: string;
  readonly reason: string;
  readonly actorRef: string;
}

export interface TimeoutCommandInput {
  readonly orderId: string;
  readonly principalId: string;
  readonly idempotencyKey: string | null;
  readonly method: string;
  readonly path: string;
  readonly observedAtEpochMs: number;
  readonly reason: string;
}

/**
 * A system-initiated fail disposition. Unlike cancel/timeout this is not an
 * Internal API operation exposed to Main; it is an internal terminal
 * transition (e.g. a permanent processing failure or an admin/job recovery)
 * that drives a `created→failed` or `waiting_sms→failed` transition and
 * releases any reserved number per the effective device state. The caller
 * supplies the actor and an idempotency key so a retry is replayed verbatim.
 */
export interface FailCommandInput {
  readonly orderId: string;
  readonly principalId: string;
  readonly idempotencyKey: string | null;
  readonly method: string;
  readonly path: string;
  readonly reason: string;
  readonly actorRef: string;
}

/** The terminal outcome returned to Main. Declared as `type` to satisfy `JsonValue`. */
export type TerminalOrderView = {
  readonly partnerOrderId: string;
  readonly status: "cancelled" | "timeout" | "failed";
  readonly terminalReason: string;
  readonly releaseDisposition: ReleaseDisposition | null;
};

export type TerminalResponseBody =
  | { readonly data: TerminalOrderView }
  | { readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean } };

export interface TerminalResult {
  readonly statusCode: number;
  readonly body: TerminalResponseBody;
}

const DEPENDENCY_UNAVAILABLE: SafeError = mapDomainError({ kind: "dependency_unavailable" });
const NOT_FOUND: SafeError = mapDomainError({ kind: "not_found" });

/** A required dependency (e.g. missing active config) is unavailable. */
class DependencyUnavailableError extends Error {
  constructor() {
    super("A required dependency is unavailable");
    this.name = "DependencyUnavailableError";
  }
}

export interface OrderTransitionServiceDeps<Tx> {
  readonly idempotency: IdempotencyEngine<Tx>;
  readonly gateway: OrderTransitionGateway<Tx>;
  readonly clock: Clock;
}

export class OrderTransitionService<Tx> {
  private readonly deps: OrderTransitionServiceDeps<Tx>;

  constructor(deps: OrderTransitionServiceDeps<Tx>) {
    this.deps = deps;
  }

  /** `POST /orders/{id}/cancel`: cancel an order per the task 5.5 rules. */
  async cancel(input: CancelCommandInput): Promise<TerminalResult> {
    const payload: JsonValue = {
      orderId: input.orderId,
      reason: input.reason,
      actorRef: input.actorRef,
    };
    return this.runTerminal({
      scope: CANCEL_SCOPE,
      orderId: input.orderId,
      principalId: input.principalId,
      idempotencyKey: input.idempotencyKey,
      method: input.method,
      path: input.path,
      payload,
      terminalReason: input.reason,
      actorRef: input.actorRef,
      buildCommand: (ctx, config, nowEpochMs) => ({
        type: "cancel",
        reason: input.reason,
        createdAtMs: ctx.createdAtEpochMs,
        observedAtMs: nowEpochMs,
        minimumCancelAgeMs:
          input.reason === MAIN_COMPENSATION ? 0 : config.cancelMinimumSeconds * 1000,
        release: this.releaseContext(ctx, config, nowEpochMs),
      }),
    });
  }

  /** `POST /orders/{id}/timeout`: time an order out at the observed instant. */
  async timeout(input: TimeoutCommandInput): Promise<TerminalResult> {
    const payload: JsonValue = {
      orderId: input.orderId,
      observedAt: input.observedAtEpochMs,
      reason: input.reason,
    };
    return this.runTerminal({
      scope: TIMEOUT_SCOPE,
      orderId: input.orderId,
      principalId: input.principalId,
      idempotencyKey: input.idempotencyKey,
      method: input.method,
      path: input.path,
      payload,
      terminalReason: input.reason,
      actorRef: MAIN_COMPENSATION,
      buildCommand: (ctx, config) => ({
        type: "timeout",
        expiresAtMs: ctx.expiresAtEpochMs,
        observedAtMs: input.observedAtEpochMs,
        release: this.releaseContext(ctx, config, input.observedAtEpochMs),
      }),
    });
  }

  /**
   * Fail an order (`created→failed` or `waiting_sms→failed`), releasing any
   * reserved number per the effective device state. This is an internal
   * disposition, not a Main-facing operation: the release is observed at the
   * server `now`, a `success` order can never be failed (the state machine
   * rejects the differing terminal), and a retry replays the first outcome.
   */
  async fail(input: FailCommandInput): Promise<TerminalResult> {
    const payload: JsonValue = {
      orderId: input.orderId,
      reason: input.reason,
      actorRef: input.actorRef,
    };
    return this.runTerminal({
      scope: FAIL_SCOPE,
      orderId: input.orderId,
      principalId: input.principalId,
      idempotencyKey: input.idempotencyKey,
      method: input.method,
      path: input.path,
      payload,
      terminalReason: input.reason,
      actorRef: input.actorRef,
      buildCommand: (ctx, config, nowEpochMs) => ({
        type: "fail",
        release: this.releaseContext(ctx, config, nowEpochMs),
      }),
    });
  }

  /**
   * Build the server-observed release context the state machine uses to decide
   * whether a released number returns to `available` or `offline`. The
   * `observedAtMs` must match the command's observed instant (the state machine
   * enforces this), so cancel passes the server `now` and timeout passes the
   * client-observed instant.
   */
  private releaseContext(
    ctx: OrderTransitionContext,
    config: OrderOperationsConfig,
    observedAtMs: number,
  ) {
    return {
      numberEnabled: ctx.numberEnabled,
      deviceStatus: ctx.deviceStatus,
      deviceLastSeenAtMs: ctx.deviceLastSeenAtEpochMs,
      observedAtMs,
      heartbeatTimeoutMs: config.heartbeatTimeoutSeconds * 1000,
    };
  }

  private async runTerminal(args: {
    readonly scope: string;
    readonly orderId: string;
    readonly principalId: string;
    readonly idempotencyKey: string | null;
    readonly method: string;
    readonly path: string;
    readonly payload: JsonValue;
    readonly terminalReason: string;
    readonly actorRef: string;
    readonly buildCommand: (
      ctx: OrderTransitionContext,
      config: OrderOperationsConfig,
      nowEpochMs: number,
    ) => OrderTransitionCommand;
  }): Promise<TerminalResult> {
    try {
      const outcome = await this.deps.idempotency.runIdempotent<TerminalResponseBody>({
        scope: args.scope,
        principalId: args.principalId,
        idempotencyKey: args.idempotencyKey,
        method: args.method,
        path: args.path,
        payload: args.payload,
        retention: "operational",
        effect: (tx) => this.runTerminalEffect(tx, args),
      });

      switch (outcome.kind) {
        case "executed":
        case "replayed":
          return { statusCode: outcome.statusCode, body: outcome.response as TerminalResponseBody };
        case "rejected":
          return outcome.code === "IDEMPOTENCY_REQUIRED"
            ? errorResult(mapDomainError({ kind: "idempotency_required" }))
            : errorResult(mapDomainError({ kind: "idempotency_conflict" }));
      }
    } catch (error) {
      // A thrown effect rolled the transaction back with nothing persisted.
      // Write contention is a retryable state conflict; anything else is a
      // retryable dependency error. Either way Main may safely re-attempt.
      if (error instanceof TerminalTransitionContentionError) {
        return errorResult(mapDomainError({ kind: "state_conflict", retryableStateConflict: true }));
      }
      return errorResult(DEPENDENCY_UNAVAILABLE);
    }
  }

  private async runTerminalEffect(
    tx: Tx,
    args: {
      readonly orderId: string;
      readonly terminalReason: string;
      readonly actorRef: string;
      readonly buildCommand: (
        ctx: OrderTransitionContext,
        config: OrderOperationsConfig,
        nowEpochMs: number,
      ) => OrderTransitionCommand;
    },
  ): Promise<{ statusCode: number; response: TerminalResponseBody }> {
    const config = await this.deps.gateway.loadActiveConfig(tx);
    if (config === null) {
      throw new DependencyUnavailableError();
    }

    const ctx = await this.deps.gateway.loadTransitionContext(tx, args.orderId);
    if (ctx === null) {
      return effectError(NOT_FOUND);
    }

    const nowEpochMs = this.deps.clock.nowEpochMs();
    const command = args.buildCommand(ctx, config, nowEpochMs);
    const decision = decideOrderNumberTransition({
      orderId: ctx.orderId,
      orderStatus: ctx.orderStatus,
      numberStatus: ctx.numberStatus,
      otpReceived: ctx.otpReceived,
      command,
    });

    if (decision.kind === "no_change") {
      // Already at the requested terminal state: idempotent success. Report the
      // number's current disposition without writing anything.
      return terminalSuccess(ctx.orderId, decision.targetOrderStatus, args.terminalReason, decision.releaseDisposition);
    }
    if (decision.kind === "reject") {
      return effectError(rejectionError(decision));
    }

    // `decision.kind === "apply"`: persist the terminal write + number release.
    // A `TerminalTransitionContentionError` (the order/number moved on since it
    // was read) is a retryable state conflict, so we let it propagate out of the
    // effect: the idempotency transaction rolls back and no record is persisted,
    // allowing Main to genuinely re-attempt rather than replay a stale conflict.
    await this.deps.gateway.applyTerminalTransition(tx, {
      orderId: ctx.orderId,
      partnerId: ctx.partnerId,
      numberId: ctx.numberId,
      expectedVersion: ctx.version,
      fromOrderStatus: decision.expectedOrderStatus,
      toOrderStatus: decision.targetOrderStatus as "cancelled" | "timeout" | "failed",
      fromNumberStatus: ctx.numberStatus,
      toNumberStatus: decision.nextNumberStatus,
      numberChanged: decision.numberChanged,
      terminalReason: args.terminalReason,
      actorRef: args.actorRef,
      operationKey: decision.operationKey,
      nowEpochMs,
    });

    return terminalSuccess(ctx.orderId, decision.targetOrderStatus, args.terminalReason, decision.releaseDisposition);
  }
}

/** Map a rejected transition decision to a stable, safe client error. */
function rejectionError(decision: Extract<OrderNumberTransitionDecision, { kind: "reject" }>): SafeError {
  switch (decision.code) {
    case "CANCEL_NOT_ALLOWED":
      return mapDomainError({ kind: "cancel_not_allowed" });
    case "TERMINAL_STATE_CONFLICT":
      return mapDomainError({ kind: "terminal_state_conflict" });
    case "STATE_CONFLICT":
      return mapDomainError({ kind: "state_conflict" });
  }
}

function terminalSuccess(
  orderId: string,
  status: string,
  terminalReason: string,
  releaseDisposition: ReleaseDisposition | null,
): { statusCode: number; response: TerminalResponseBody } {
  const view: TerminalOrderView = {
    partnerOrderId: orderId,
    status: status as "cancelled" | "timeout" | "failed",
    terminalReason,
    releaseDisposition,
  };
  return { statusCode: 200, response: { data: view } };
}

function effectError(error: SafeError): { statusCode: number; response: TerminalResponseBody } {
  return { statusCode: error.status, response: bodyFor(error) };
}

function errorResult(error: SafeError): TerminalResult {
  return { statusCode: error.status, body: bodyFor(error) };
}

function bodyFor(error: SafeError): TerminalResponseBody {
  return { error: { code: error.code, message: error.message, retryable: error.retryable } };
}
