/**
 * PartnerNumber lifecycle commands (task 8.3).
 *
 * Register / move / disable / re-enable / delete a number that belongs to a
 * device in the caller's tenant. Every command is a sensitive inventory
 * operation gated by the pure permission matrix (task 5.1, `manage_inventory`),
 * re-checks the permission itself (defense-in-depth), operates only within the
 * caller's tenant scope (task 7.1 — a cross-tenant target is indistinguishable
 * from a missing one), and — for status changes — appends a `NumberStateHistory`
 * entry in the same transaction as the mutation (requirement 7.6). Each command
 * also writes an audit event (requirement 19.1).
 *
 * All number invariants come from the pure task 5.2 domain:
 *   - `normalizeIndonesianNumber` canonicalises E.164 `+62` input (req 7.1).
 *   - `assertUniqueActiveNumber` rejects same-tenant active duplicates, and the
 *     database `activeCanonicalNumber` unique slot enforces the MVP-global
 *     uniqueness across tenants (req 7.2) — a collision surfaces as
 *     `duplicate_active_number`.
 *   - `assertNumberMoveOrDeleteAllowed` blocks moving a device or deleting a
 *     number while it is `reserved`/`busy` (req 7.4).
 *   - `disableIdleNumber` / `reenableNumber` drive the disable/re-enable
 *     transitions across the `offline|available|reserved|busy|disabled` states
 *     (req 7.3, 7.5).
 *
 * Every outcome is a tagged union so the transport layer maps results to safe
 * responses without relying on thrown control flow.
 */
import {
  assertNumberMoveOrDeleteAllowed,
  assertUniqueActiveNumber,
  disableIdleNumber,
  normalizeIndonesianNumber,
  reenableNumber,
  Task52DomainError,
  type NumberStatus,
} from "@domain/task-5-2-device-inventory-pricing";
import { createAuditEvent, type AuditEventDescriptor } from "@domain/task-5-7";
import { ConcurrencyConflictError } from "@infrastructure/database";

import { checkPermission, type SessionContext } from "../authorization/session-context";
import {
  ActiveNumberConflictError,
  type Clock,
  type IdGenerator,
  type NumberManagementGateway,
  type NumberManagementTransaction,
  type NumberView,
} from "./ports";

/** MVP catalog country for `+62` numbers; the catalog is `wa/ID/any`. */
const MVP_COUNTRY_CODE = "ID";
/** MVP catalog operator; weighted/per-operator routing is post-MVP. */
const MVP_OPERATOR_CODE = "any";
/** Column limit for `operatorCode` (VarChar(32)). */
const MAX_OPERATOR_LENGTH = 32;

export interface RegisterNumberInput {
  readonly caller: SessionContext;
  readonly deviceId: string;
  /** Raw phone number; normalised to canonical E.164 `+62` by the domain. */
  readonly rawNumber: string;
  /** Optional operator label; defaults to the MVP `any`. */
  readonly operatorCode?: string;
  /** Request identity for the audit trail (uuid). */
  readonly requestId: string;
}

export interface NumberIdInput {
  readonly caller: SessionContext;
  readonly numberId: string;
  readonly requestId: string;
}

export interface DisableNumberInput extends NumberIdInput {
  readonly reason?: string;
}

export interface MoveNumberInput extends NumberIdInput {
  /** The target device (must belong to the caller's tenant). */
  readonly targetDeviceId: string;
}

export type NumberCommandOutcome =
  | { readonly ok: true; readonly number: NumberView }
  | { readonly ok: false; readonly reason: "forbidden" }
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "device_not_found" }
  | { readonly ok: false; readonly reason: "duplicate_active_number" }
  | { readonly ok: false; readonly reason: "state_guarded"; readonly status: NumberStatus }
  | { readonly ok: false; readonly reason: "validation"; readonly code: string };

export interface NumberManagementServiceDeps {
  readonly gateway: NumberManagementGateway;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export class NumberManagementService {
  private readonly deps: NumberManagementServiceDeps;

  constructor(deps: NumberManagementServiceDeps) {
    this.deps = deps;
  }

  /**
   * Register a number on one of the caller's devices. The number starts
   * `offline` (it must heartbeat before it can serve inventory) and enabled,
   * and claims the global active-canonical slot (requirement 7.1, 7.2).
   */
  async registerNumber(input: RegisterNumberInput): Promise<NumberCommandOutcome> {
    const denied = this.requireManageInventory(input.caller);
    if (denied) return denied;

    let canonical: string;
    try {
      canonical = normalizeIndonesianNumber(input.rawNumber);
    } catch (error) {
      return { ok: false, reason: "validation", code: domainErrorCode(error) };
    }

    const operatorCode = normalizeOperator(input.operatorCode);
    if (operatorCode === null) {
      return { ok: false, reason: "validation", code: "INVALID_OPERATOR" };
    }

    return this.deps.gateway.runInTenant(input.caller.tenant, async (tx) => {
      const device = await tx.findDeviceRef(input.deviceId);
      if (device === null) return { ok: false, reason: "device_not_found" } as const;

      // Fast, friendly same-tenant duplicate check; the DB unique slot enforces
      // the MVP-global rule across tenants (handled by the catch below).
      const existing = await tx.listTenantActiveNumbers();
      try {
        assertUniqueActiveNumber(canonical, existing);
      } catch (error) {
        if (isDuplicateActiveNumber(error)) {
          return { ok: false, reason: "duplicate_active_number" } as const;
        }
        return { ok: false, reason: "validation", code: domainErrorCode(error) } as const;
      }

      const now = this.deps.clock.nowEpochMs();
      const numberId = this.deps.idGenerator.uuid();
      let number: NumberView;
      try {
        number = await tx.insertNumber({
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
        if (error instanceof ActiveNumberConflictError) {
          return { ok: false, reason: "duplicate_active_number" } as const;
        }
        throw error;
      }

      await tx.appendStateHistory({
        id: this.deps.idGenerator.uuid(),
        numberId,
        fromStatus: null,
        toStatus: "offline",
        actorType: "partner_member",
        actorRef: input.caller.principal.memberId,
        reason: "registered",
        occurredAtEpochMs: now,
      });

      await this.writeAudit(tx, {
        caller: input.caller,
        requestId: input.requestId,
        descriptor: createAuditEvent({
          actorType: "partner_member",
          actorRef: input.caller.principal.memberId,
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

      return { ok: true, number } as const;
    });
  }

  /**
   * Disable an idle number, excluding it from new inventory (requirement 7.5).
   * A `reserved`/`busy` number is guarded: it cannot be disabled until the order
   * completes or is released (requirement 7.4). Disabling frees the global
   * active-canonical slot.
   */
  async disableNumber(input: DisableNumberInput): Promise<NumberCommandOutcome> {
    const denied = this.requireManageInventory(input.caller);
    if (denied) return denied;

    return this.deps.gateway.runInTenant(input.caller.tenant, async (tx) => {
      const existing = await tx.findNumberById(input.numberId);
      if (existing === null) return { ok: false, reason: "not_found" } as const;

      let nextStatus: NumberStatus;
      try {
        nextStatus = disableIdleNumber(existing.status);
      } catch (error) {
        if (isStateGuard(error)) {
          return { ok: false, reason: "state_guarded", status: existing.status } as const;
        }
        return { ok: false, reason: "validation", code: domainErrorCode(error) } as const;
      }

      const now = this.deps.clock.nowEpochMs();
      let number: NumberView;
      try {
        number = await tx.updateNumberStatus(input.numberId, {
          expectedStatus: existing.status,
          status: nextStatus,
          enabled: false,
          activeCanonicalNumber: null,
        });
      } catch (error) {
        // The number was reserved/busied between our read and write: the guard
        // (requirement 7.4) now applies, so we report its fresh state rather than
        // overwrite the concurrent reservation.
        if (error instanceof ConcurrencyConflictError) {
          return this.guardedByConcurrentChange(tx, input.numberId);
        }
        throw error;
      }

      await this.recordStatusChange(tx, {
        caller: input.caller,
        requestId: input.requestId,
        numberId: input.numberId,
        fromStatus: existing.status,
        toStatus: nextStatus,
        change: "disabled",
        reason: input.reason ?? "disabled",
        occurredAtEpochMs: now,
      });

      return { ok: true, number } as const;
    });
  }

  /**
   * Re-enable a previously disabled number, returning it to `offline` (it must
   * heartbeat before serving inventory again). Re-claiming the active-canonical
   * slot can collide if another number took it while this one was disabled.
   */
  async reEnableNumber(input: NumberIdInput): Promise<NumberCommandOutcome> {
    const denied = this.requireManageInventory(input.caller);
    if (denied) return denied;

    return this.deps.gateway.runInTenant(input.caller.tenant, async (tx) => {
      const existing = await tx.findNumberById(input.numberId);
      if (existing === null) return { ok: false, reason: "not_found" } as const;
      if (existing.status !== "disabled") {
        return { ok: false, reason: "validation", code: "NUMBER_NOT_DISABLED" } as const;
      }

      const nextStatus = reenableNumber();
      const now = this.deps.clock.nowEpochMs();
      let number: NumberView;
      try {
        number = await tx.updateNumberStatus(input.numberId, {
          expectedStatus: existing.status,
          status: nextStatus,
          enabled: true,
          activeCanonicalNumber: existing.canonicalNumber,
        });
      } catch (error) {
        if (error instanceof ActiveNumberConflictError) {
          return { ok: false, reason: "duplicate_active_number" } as const;
        }
        // The number stopped being `disabled` between our read and write (another
        // request re-enabled it, or it was removed). Report it as no longer
        // re-enable-able rather than overwrite the concurrent change.
        if (error instanceof ConcurrencyConflictError) {
          return { ok: false, reason: "validation", code: "NUMBER_NOT_DISABLED" } as const;
        }
        throw error;
      }

      await this.recordStatusChange(tx, {
        caller: input.caller,
        requestId: input.requestId,
        numberId: input.numberId,
        fromStatus: existing.status,
        toStatus: nextStatus,
        change: "re_enabled",
        reason: "re_enabled",
        occurredAtEpochMs: now,
      });

      return { ok: true, number } as const;
    });
  }

  /**
   * Move a number to another device of the same tenant. Blocked while the
   * number is `reserved`/`busy` (requirement 7.4). Moving a device does not
   * change the number's status, so no state-history entry is written — only an
   * audit event.
   */
  async moveNumberToDevice(input: MoveNumberInput): Promise<NumberCommandOutcome> {
    const denied = this.requireManageInventory(input.caller);
    if (denied) return denied;

    return this.deps.gateway.runInTenant(input.caller.tenant, async (tx) => {
      const existing = await tx.findNumberById(input.numberId);
      if (existing === null) return { ok: false, reason: "not_found" } as const;

      try {
        assertNumberMoveOrDeleteAllowed(existing.status);
      } catch (error) {
        if (isStateGuard(error)) {
          return { ok: false, reason: "state_guarded", status: existing.status } as const;
        }
        return { ok: false, reason: "validation", code: domainErrorCode(error) } as const;
      }

      const targetDevice = await tx.findDeviceRef(input.targetDeviceId);
      if (targetDevice === null) return { ok: false, reason: "device_not_found" } as const;

      const now = this.deps.clock.nowEpochMs();
      let number: NumberView;
      try {
        number = await tx.moveNumberDevice(input.numberId, input.targetDeviceId, existing.status);
      } catch (error) {
        // The number was reserved/busied between our read and the move: the guard
        // (requirement 7.4) now applies, so we report its fresh state rather than
        // re-home a number bound to an active order.
        if (error instanceof ConcurrencyConflictError) {
          return this.guardedByConcurrentChange(tx, input.numberId);
        }
        throw error;
      }

      await this.writeAudit(tx, {
        caller: input.caller,
        requestId: input.requestId,
        descriptor: createAuditEvent({
          actorType: "partner_member",
          actorRef: input.caller.principal.memberId,
          action: "number.changed",
          targetType: "partner_number",
          targetId: input.numberId,
          result: "success",
          occurredAtEpochMs: now,
          metadata: {
            change: "moved",
            fromDeviceId: existing.deviceId,
            toDeviceId: input.targetDeviceId,
          },
        }),
      });

      return { ok: true, number } as const;
    });
  }

  /**
   * Delete a number. Blocked while `reserved`/`busy` (requirement 7.4). The
   * number's state history is removed together with the number in the same
   * transaction.
   */
  async deleteNumber(input: NumberIdInput): Promise<NumberCommandOutcome> {
    const denied = this.requireManageInventory(input.caller);
    if (denied) return denied;

    return this.deps.gateway.runInTenant(input.caller.tenant, async (tx) => {
      const existing = await tx.findNumberById(input.numberId);
      if (existing === null) return { ok: false, reason: "not_found" } as const;

      try {
        assertNumberMoveOrDeleteAllowed(existing.status);
      } catch (error) {
        if (isStateGuard(error)) {
          return { ok: false, reason: "state_guarded", status: existing.status } as const;
        }
        return { ok: false, reason: "validation", code: domainErrorCode(error) } as const;
      }

      const now = this.deps.clock.nowEpochMs();
      await tx.deleteNumberById(input.numberId);

      await this.writeAudit(tx, {
        caller: input.caller,
        requestId: input.requestId,
        descriptor: createAuditEvent({
          actorType: "partner_member",
          actorRef: input.caller.principal.memberId,
          action: "number.changed",
          targetType: "partner_number",
          targetId: input.numberId,
          result: "success",
          occurredAtEpochMs: now,
          metadata: {
            change: "deleted",
            deviceId: existing.deviceId,
            canonicalNumber: existing.canonicalNumber,
          },
        }),
      });

      return { ok: true, number: existing } as const;
    });
  }

  /**
   * Resolve a compare-and-set conflict on a status/device write. The number
   * moved off the status the command decided against — typically a concurrent
   * reservation flipped it `available -> reserved` — so we re-read its current
   * state (tenant-scoped) and report it as guarded, never overwriting the newer
   * state. A row deleted under us collapses to `not_found`.
   */
  private async guardedByConcurrentChange(
    tx: NumberManagementTransaction,
    numberId: string,
  ): Promise<NumberCommandOutcome> {
    const current = await tx.findNumberById(numberId);
    if (current === null) return { ok: false, reason: "not_found" };
    return { ok: false, reason: "state_guarded", status: current.status };
  }

  /** `manage_inventory` gate shared by every number command (requirement 4.4). */
  private requireManageInventory(
    caller: SessionContext,
  ): { readonly ok: false; readonly reason: "forbidden" } | null {
    const permission = checkPermission(caller, "manage_inventory");
    return permission.allowed ? null : { ok: false, reason: "forbidden" };
  }

  /** Append a state-history entry (req 7.6) and an audit event for a status change. */
  private async recordStatusChange(
    tx: NumberManagementTransaction,
    args: {
      readonly caller: SessionContext;
      readonly requestId: string;
      readonly numberId: string;
      readonly fromStatus: NumberStatus;
      readonly toStatus: NumberStatus;
      readonly change: string;
      readonly reason: string;
      readonly occurredAtEpochMs: number;
    },
  ): Promise<void> {
    await tx.appendStateHistory({
      id: this.deps.idGenerator.uuid(),
      numberId: args.numberId,
      fromStatus: args.fromStatus,
      toStatus: args.toStatus,
      actorType: "partner_member",
      actorRef: args.caller.principal.memberId,
      reason: args.reason,
      occurredAtEpochMs: args.occurredAtEpochMs,
    });

    await this.writeAudit(tx, {
      caller: args.caller,
      requestId: args.requestId,
      descriptor: createAuditEvent({
        actorType: "partner_member",
        actorRef: args.caller.principal.memberId,
        action: "number.changed",
        targetType: "partner_number",
        targetId: args.numberId,
        result: "success",
        occurredAtEpochMs: args.occurredAtEpochMs,
        metadata: {
          change: args.change,
          previousStatus: args.fromStatus,
          nextStatus: args.toStatus,
        },
      }),
    });
  }

  private async writeAudit(
    tx: NumberManagementTransaction,
    args: {
      readonly caller: SessionContext;
      readonly requestId: string;
      readonly descriptor: AuditEventDescriptor;
    },
  ): Promise<void> {
    await tx.recordAudit({
      id: this.deps.idGenerator.uuid(),
      partnerId: args.caller.tenant.partnerId,
      requestId: args.requestId,
      descriptor: args.descriptor,
    });
  }
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
