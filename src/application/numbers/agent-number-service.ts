/**
 * Agent API device-facing number commands (task 11.3).
 *
 * Backs `POST /api/agent/v1/numbers/register` and
 * `POST /api/agent/v1/numbers/{id}/availability`. Both are sensitive inventory
 * mutations initiated by an authenticated *device*, so each command:
 *
 *  - runs the whole effect inside {@link IdempotencyEngine.runIdempotent}, so
 *    the number mutation, its `NumberStateHistory` entry, the audit event, and
 *    the idempotency record commit in one transaction and a retry with the same
 *    key + payload replays the first result verbatim while a different payload
 *    under the same key is a deterministic `IDEMPOTENCY_CONFLICT`
 *    (requirements 18.4, 18.5);
 *  - reuses only the single pure task 5.2 domain for every lifecycle rule
 *    (`normalizeIndonesianNumber`, `assertUniqueActiveNumber`,
 *    `disableIdleNumber`, `reenableNumber`, `reconcileNumberAvailability`), so
 *    the effective state is decided by the domain — never the client
 *    (requirements 7.1, 7.3, 21.1);
 *  - enforces *device* ownership: a number that belongs to another device (or
 *    tenant) is indistinguishable from a missing one (`RESOURCE_NOT_FOUND`),
 *    and a `reserved`/`busy` number cannot have its availability changed
 *    (requirement 7.4).
 *
 * The caller identity (`partnerId`, `deviceId`) is always the authenticated
 * credential resolved by the task 11.1 guard — never a request field. The
 * result is a normalized `{ statusCode, body }` the transport serializes into
 * the shared safe envelope with the current request id.
 */
import {
  assertUniqueActiveNumber,
  disableIdleNumber,
  normalizeIndonesianNumber,
  reconcileNumberAvailability,
  reenableNumber,
  Task52DomainError,
  type NumberStatus,
} from "@domain/task-5-2-device-inventory-pricing";
import { createAuditEvent } from "@domain/task-5-7";
import { mapDomainError, type SafeError } from "@domain/task-5-3/safe-errors";
import type { JsonValue } from "@domain/task-5-3/canonical-request-hash";
import { IdempotencyEngine } from "@application/internal-api";
import { ConcurrencyConflictError } from "@infrastructure/database";

import { ActiveNumberConflictError, type Clock, type IdGenerator, type NumberView } from "./ports";
import type { AgentNumberGateway, RequestedAvailability } from "./agent-ports";

/** MVP catalog country for `+62` numbers; the catalog is `wa/ID/any`. */
const MVP_COUNTRY_CODE = "ID";
/** MVP catalog operator; weighted/per-operator routing is post-MVP. */
const MVP_OPERATOR_CODE = "any";
/** Column limit for `operatorCode` (VarChar(32)). */
const MAX_OPERATOR_LENGTH = 32;

/** Idempotency scope namespaces for the two device number mutations. */
export const AGENT_NUMBER_REGISTER_SCOPE = "agent.numbers.register";
export const AGENT_NUMBER_AVAILABILITY_SCOPE = "agent.numbers.availability";

/** The verified device identity + idempotency envelope for a register call. */
export interface RegisterAgentNumberInput {
  readonly partnerId: string;
  readonly deviceId: string;
  readonly idempotencyKey: string | null;
  readonly method: string;
  readonly path: string;
  readonly requestId: string;
  /** Raw phone number; normalised to canonical E.164 `+62` by the domain. */
  readonly rawNumber: string;
  /** Optional operator label; defaults to the MVP `any`. */
  readonly operatorCode?: string;
}

/** The verified device identity + idempotency envelope for an availability call. */
export interface SetAgentNumberAvailabilityInput {
  readonly partnerId: string;
  readonly deviceId: string;
  readonly numberId: string;
  readonly idempotencyKey: string | null;
  readonly method: string;
  readonly path: string;
  readonly requestId: string;
  /** The requested availability; the domain resolves the actual state. */
  readonly requested: RequestedAvailability;
}

/** A JSON-safe view of a number returned to the device (`type` for JsonValue). */
export type AgentNumberData = {
  readonly id: string;
  readonly deviceId: string;
  readonly canonicalNumber: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly status: NumberStatus;
  readonly enabled: boolean;
  /** The availability the device requested (availability responses only). */
  readonly requested?: RequestedAvailability;
};

/** The persisted / replayed response body (envelope-ready sans `requestId`). */
export type AgentNumberResponseBody =
  | { readonly data: AgentNumberData }
  | { readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean } };

/** A normalized command result the transport serializes into an envelope. */
export interface AgentNumberResult {
  readonly statusCode: number;
  readonly body: AgentNumberResponseBody;
}

const NOT_FOUND: SafeError = mapDomainError({ kind: "not_found" });
const STATE_CONFLICT: SafeError = mapDomainError({ kind: "state_conflict" });
const DUPLICATE_ACTIVE_NUMBER: SafeError = Object.freeze({
  status: 409,
  code: "DUPLICATE_ACTIVE_NUMBER",
  message: "An active number already uses this canonical number.",
  retryable: false,
});
const DEPENDENCY_UNAVAILABLE: SafeError = mapDomainError({ kind: "dependency_unavailable" });

/** A dependency (e.g. the authenticated device row) is unexpectedly missing. */
class DependencyUnavailableError extends Error {
  constructor() {
    super("A required dependency is unavailable");
    this.name = "DependencyUnavailableError";
  }
}

export interface AgentNumberServiceDeps<Tx> {
  readonly idempotency: IdempotencyEngine<Tx>;
  readonly gateway: AgentNumberGateway<Tx>;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  /** Liveness threshold in seconds; defaults to the MVP 90s window. */
  readonly heartbeatTimeoutSeconds?: number;
}

export class AgentNumberService<Tx> {
  private readonly deps: AgentNumberServiceDeps<Tx>;
  private readonly heartbeatTimeoutSeconds: number | undefined;

  constructor(deps: AgentNumberServiceDeps<Tx>) {
    this.deps = deps;
    this.heartbeatTimeoutSeconds = deps.heartbeatTimeoutSeconds;
  }

  /**
   * Register a number on the authenticated device. The number starts `offline`
   * (it must heartbeat before serving inventory) and enabled, claiming the
   * global active-canonical slot (requirements 7.1, 7.2).
   */
  async registerNumber(input: RegisterAgentNumberInput): Promise<AgentNumberResult> {
    const payload: JsonValue = {
      deviceId: input.deviceId,
      rawNumber: input.rawNumber,
      operatorCode: input.operatorCode ?? null,
    };

    return this.runMutation({
      scope: AGENT_NUMBER_REGISTER_SCOPE,
      input,
      payload,
      effect: (tx) => this.runRegisterEffect(tx, input),
    });
  }

  /**
   * Request an availability change on a number the device owns. `disabled`
   * takes the number out of service; `available`/`offline` re-enable it and let
   * the pure `reconcileNumberAvailability` domain resolve the actual state from
   * device liveness, an active offer, and any active order (requirement 7.3).
   */
  async setAvailability(input: SetAgentNumberAvailabilityInput): Promise<AgentNumberResult> {
    const payload: JsonValue = {
      numberId: input.numberId,
      requested: input.requested,
    };

    return this.runMutation({
      scope: AGENT_NUMBER_AVAILABILITY_SCOPE,
      input,
      payload,
      effect: (tx) => this.runAvailabilityEffect(tx, input),
    });
  }

  /** Shared idempotent wrapper for both device number mutations. */
  private async runMutation(args: {
    readonly scope: string;
    readonly input: {
      readonly partnerId: string;
      readonly deviceId: string;
      readonly idempotencyKey: string | null;
      readonly method: string;
      readonly path: string;
    };
    readonly payload: JsonValue;
    readonly effect: (tx: Tx) => Promise<{ statusCode: number; response: AgentNumberResponseBody }>;
  }): Promise<AgentNumberResult> {
    try {
      const outcome = await this.deps.idempotency.runIdempotent<AgentNumberResponseBody>({
        scope: args.scope,
        // Namespace the idempotency record by device so two devices never share
        // a key space; the guard already required a key for number mutations.
        principalId: `device:${args.input.deviceId}`,
        idempotencyKey: args.input.idempotencyKey,
        method: args.input.method,
        path: args.input.path,
        payload: args.payload,
        // Inventory mutations are operational, not financial (90-day retention).
        retention: "operational",
        effect: args.effect,
      });

      switch (outcome.kind) {
        case "executed":
        case "replayed":
          return { statusCode: outcome.statusCode, body: outcome.response as AgentNumberResponseBody };
        case "rejected":
          return outcome.code === "IDEMPOTENCY_REQUIRED"
            ? errorResult(mapDomainError({ kind: "idempotency_required" }))
            : errorResult(mapDomainError({ kind: "idempotency_conflict" }));
      }
    } catch {
      // A thrown effect rolled the transaction back with nothing persisted;
      // surface a retryable dependency error so the device can safely retry.
      return errorResult(DEPENDENCY_UNAVAILABLE);
    }
  }

  private async runRegisterEffect(
    tx: Tx,
    input: RegisterAgentNumberInput,
  ): Promise<{ statusCode: number; response: AgentNumberResponseBody }> {
    let canonical: string;
    try {
      canonical = normalizeIndonesianNumber(input.rawNumber);
    } catch (error) {
      return effectError(validationError(domainErrorCode(error)));
    }

    const operatorCode = normalizeOperator(input.operatorCode);
    if (operatorCode === null) return effectError(validationError("INVALID_OPERATOR"));

    const device = await this.deps.gateway.findOwnedDevice(tx, input.partnerId, input.deviceId);
    // The device was authenticated moments ago; a missing row is an internal
    // inconsistency, so roll back and let the caller retry.
    if (device === null) throw new DependencyUnavailableError();

    const existing = await this.deps.gateway.listActiveNumbers(tx, input.partnerId);
    try {
      assertUniqueActiveNumber(canonical, existing);
    } catch (error) {
      if (isDuplicateActiveNumber(error)) return effectError(DUPLICATE_ACTIVE_NUMBER);
      return effectError(validationError(domainErrorCode(error)));
    }

    const now = this.deps.clock.nowEpochMs();
    const numberId = this.deps.idGenerator.uuid();
    let number: NumberView;
    try {
      number = await this.deps.gateway.insertNumber(tx, input.partnerId, {
        id: numberId,
        deviceId: input.deviceId,
        canonicalNumber: canonical,
        countryCode: MVP_COUNTRY_CODE,
        operatorCode,
        status: "offline",
        enabled: true,
        activeCanonicalNumber: canonical,
        createdAtEpochMs: now,
      });
    } catch (error) {
      if (error instanceof ActiveNumberConflictError) return effectError(DUPLICATE_ACTIVE_NUMBER);
      throw error;
    }

    await this.deps.gateway.appendStateHistory(tx, {
      id: this.deps.idGenerator.uuid(),
      numberId,
      fromStatus: null,
      toStatus: "offline",
      actorType: "device",
      actorRef: input.deviceId,
      reason: "registered",
      occurredAtEpochMs: now,
    });

    await this.deps.gateway.recordAudit(tx, {
      id: this.deps.idGenerator.uuid(),
      partnerId: input.partnerId,
      requestId: input.requestId,
      descriptor: createAuditEvent({
        actorType: "device",
        actorRef: input.deviceId,
        action: "number.changed",
        targetType: "partner_number",
        targetId: numberId,
        result: "success",
        occurredAtEpochMs: now,
        metadata: {
          change: "registered",
          deviceId: input.deviceId,
          countryCode: MVP_COUNTRY_CODE,
          operatorCode,
        },
      }),
    });

    return { statusCode: 201, response: { data: toAgentNumberData(number) } };
  }

  private async runAvailabilityEffect(
    tx: Tx,
    input: SetAgentNumberAvailabilityInput,
  ): Promise<{ statusCode: number; response: AgentNumberResponseBody }> {
    const context = await this.deps.gateway.loadNumberForAvailability(
      tx,
      input.partnerId,
      input.numberId,
    );
    // Cross-tenant OR cross-device access both collapse to RESOURCE_NOT_FOUND:
    // a device may only manage its own numbers (ownership, requirement 18.5).
    if (context === null || context.deviceId !== input.deviceId) {
      return effectError(NOT_FOUND);
    }

    // A reserved/busy number cannot have its availability changed until the
    // order completes or is released (requirement 7.4). The domain owns this
    // guard; the effective state is never overridden by the request.
    if (context.status === "reserved" || context.status === "busy") {
      return effectError(STATE_CONFLICT);
    }

    const now = this.deps.clock.nowEpochMs();
    let mutation: {
      status: NumberStatus;
      enabled: boolean;
      activeCanonicalNumber: string | null;
      // The status read above; the compare-and-set basis for the write below.
      expectedStatus: NumberStatus;
    };

    if (input.requested === "disabled") {
      let nextStatus: NumberStatus;
      try {
        nextStatus = disableIdleNumber(context.status);
      } catch (error) {
        if (isStateGuard(error)) return effectError(STATE_CONFLICT);
        return effectError(validationError(domainErrorCode(error)));
      }
      mutation = {
        status: nextStatus,
        enabled: false,
        activeCanonicalNumber: null,
        expectedStatus: context.status,
      };
    } else {
      // available/offline: ensure the number is enabled (re-enabling a disabled
      // number returns it to `offline` first), then let the domain resolve the
      // effective state. A plain `offline` request parks the number; an
      // `available` request only *becomes* available when the domain agrees.
      const baseStatus: NumberStatus =
        context.status === "disabled" ? reenableNumber() : context.status;

      const target: NumberStatus =
        input.requested === "offline"
          ? "offline"
          : reconcileNumberAvailability({
              status: baseStatus,
              enabled: true,
              hasActiveOrder: context.hasActiveOrder,
              hasActiveOffer: context.hasActiveOffer,
              device: {
                status: context.device.status,
                lastSeenAt:
                  context.device.lastSeenAtEpochMs === null
                    ? null
                    : new Date(context.device.lastSeenAtEpochMs),
              },
              nowServer: new Date(now),
              ...(this.heartbeatTimeoutSeconds === undefined
                ? {}
                : { heartbeatTimeoutSeconds: this.heartbeatTimeoutSeconds }),
            });

      mutation = {
        status: target,
        enabled: true,
        activeCanonicalNumber: context.canonicalNumber,
        expectedStatus: context.status,
      };
    }

    let number: NumberView;
    try {
      number = await this.deps.gateway.applyNumberStatus(
        tx,
        input.partnerId,
        input.numberId,
        mutation,
      );
    } catch (error) {
      if (error instanceof ActiveNumberConflictError) return effectError(DUPLICATE_ACTIVE_NUMBER);
      // The number was reserved/busied between the read and this write: the same
      // guard as a reserved/busy number applies (requirement 7.4). We report the
      // conflict rather than overwrite the concurrent reservation.
      if (error instanceof ConcurrencyConflictError) return effectError(STATE_CONFLICT);
      throw error;
    }

    // Record a state-history entry only on an actual status change (req 7.6),
    // and always an audit event for the availability request (requirement 19.1).
    if (mutation.status !== context.status) {
      await this.deps.gateway.appendStateHistory(tx, {
        id: this.deps.idGenerator.uuid(),
        numberId: input.numberId,
        fromStatus: context.status,
        toStatus: mutation.status,
        actorType: "device",
        actorRef: input.deviceId,
        reason: `availability_${input.requested}`,
        occurredAtEpochMs: now,
      });
    }

    await this.deps.gateway.recordAudit(tx, {
      id: this.deps.idGenerator.uuid(),
      partnerId: input.partnerId,
      requestId: input.requestId,
      descriptor: createAuditEvent({
        actorType: "device",
        actorRef: input.deviceId,
        action: "number.changed",
        targetType: "partner_number",
        targetId: input.numberId,
        result: "success",
        occurredAtEpochMs: now,
        metadata: {
          change: "availability_requested",
          requested: input.requested,
          previousStatus: context.status,
          nextStatus: mutation.status,
        },
      }),
    });

    return {
      statusCode: 200,
      response: { data: { ...toAgentNumberData(number), requested: input.requested } },
    };
  }
}

/** Project a `NumberView` onto the JSON-safe device response shape. */
function toAgentNumberData(number: NumberView): AgentNumberData {
  return {
    id: number.id,
    deviceId: number.deviceId,
    canonicalNumber: number.canonicalNumber,
    countryCode: number.countryCode,
    operatorCode: number.operatorCode,
    status: number.status,
    enabled: number.enabled,
  };
}

/** Validate and default the optional operator label to the MVP `any`. */
function normalizeOperator(operator: string | undefined): string | null {
  if (operator === undefined) return MVP_OPERATOR_CODE;
  const trimmed = operator.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_OPERATOR_LENGTH) return null;
  return trimmed;
}

/** Map a task 5.2 domain failure onto a stable validation code. */
function domainErrorCode(error: unknown): string {
  return error instanceof Task52DomainError ? error.code : "INVALID_PHONE_NUMBER";
}

function isDuplicateActiveNumber(error: unknown): boolean {
  return error instanceof Task52DomainError && error.code === "DUPLICATE_ACTIVE_NUMBER";
}

function isStateGuard(error: unknown): boolean {
  return error instanceof Task52DomainError && error.code === "NUMBER_STATE_GUARD";
}

function validationError(code: string): SafeError {
  const base = mapDomainError({ kind: "validation" });
  return { ...base, code };
}

function effectError(error: SafeError): { statusCode: number; response: AgentNumberResponseBody } {
  return { statusCode: error.status, response: bodyFor(error) };
}

function errorResult(error: SafeError): AgentNumberResult {
  return { statusCode: error.status, body: bodyFor(error) };
}

function bodyFor(error: SafeError): AgentNumberResponseBody {
  return { error: { code: error.code, message: error.message, retryable: error.retryable } };
}
