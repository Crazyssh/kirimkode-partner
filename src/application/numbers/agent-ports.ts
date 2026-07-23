/**
 * Application-owned ports for the Agent API device-facing number commands
 * (task 11.3).
 *
 * The Agent API `POST /numbers/register` and `POST /numbers/{id}/availability`
 * endpoints let an authenticated *device* register a number it owns and request
 * an availability change. Unlike the portal member commands (task 8.3), the
 * caller is a device credential — not a human session — so these commands run
 * with a `device` audit actor and enforce *device* ownership on top of tenant
 * scope. Every lifecycle rule still comes from the single pure task 5.2 domain
 * (`normalizeIndonesianNumber`, `assertUniqueActiveNumber`,
 * `assertNumberMoveOrDeleteAllowed`, `disableIdleNumber`, `reenableNumber`,
 * `reconcileNumberAvailability`), so the simulator, APK, modem, and direct API
 * all share one contract (requirements 17.2, 21.1).
 *
 * The gateway is parameterized by the transaction handle `Tx` the task 9.2
 * idempotency engine also writes through (mirroring the reservation gateway),
 * so the number mutation, its `NumberStateHistory` entry (requirement 7.6), the
 * audit event, and the idempotency record all commit in one transaction and a
 * retry with the same key + payload replays the first result verbatim
 * (requirement 18.4/18.5). Raw Prisma never leaves the adapter; tenant scoping
 * is applied inside it from the trusted `partnerId`.
 */
import type { DeviceStatus, NumberStatus } from "@domain/task-5-2-device-inventory-pricing";

import type {
  AuditWriteInput,
  NewNumberRecord,
  NumberStateHistoryRecord,
  NumberStatusMutation,
  NumberView,
} from "./ports";

/** A requested availability transition a device can ask for on its number. */
export type RequestedAvailability = "available" | "offline" | "disabled";

/** A minimal reference confirming the authenticated device exists in the tenant. */
export interface AgentDeviceRef {
  readonly id: string;
}

/** The tenant's own non-disabled number identities, for the duplicate check. */
export interface ActiveNumberIdentity {
  readonly id: string;
  readonly canonicalNumber: string;
  readonly status: NumberStatus;
}

/**
 * Everything the availability command needs to let the pure domain resolve the
 * *effective* state of a number: its current lifecycle, ownership, and the
 * device liveness + active offer/order signals `reconcileNumberAvailability`
 * consumes. Loaded tenant-scoped; a cross-tenant id yields `null`.
 */
export interface AgentNumberAvailabilityContext {
  readonly numberId: string;
  /** The owning device — must equal the authenticated device (ownership). */
  readonly deviceId: string;
  readonly canonicalNumber: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly status: NumberStatus;
  readonly enabled: boolean;
  /** True when the number still points at an active order. */
  readonly hasActiveOrder: boolean;
  /** True when an active offer covers the number's catalog dimension. */
  readonly hasActiveOffer: boolean;
  /** The owning device's persisted effective status + last liveness stamp. */
  readonly device: {
    readonly status: DeviceStatus;
    readonly lastSeenAtEpochMs: number | null;
  };
}

/**
 * Transactional persistence for the Agent API number commands, parameterized by
 * the transaction handle `Tx` the idempotency engine also writes through. Every
 * method runs on the caller-provided `tx` and folds the trusted `partnerId`
 * into its query predicate (task 7.1), so a cross-tenant id is indistinguishable
 * from a missing row and the effect commits atomically with the idempotency
 * record.
 */
export interface AgentNumberGateway<Tx> {
  /** Confirm the authenticated device exists within the tenant. */
  findOwnedDevice(tx: Tx, partnerId: string, deviceId: string): Promise<AgentDeviceRef | null>;
  /** The tenant's non-disabled numbers, for the same-tenant duplicate check. */
  listActiveNumbers(tx: Tx, partnerId: string): Promise<readonly ActiveNumberIdentity[]>;
  /** Insert a number; throws `ActiveNumberConflictError` on a global collision. */
  insertNumber(tx: Tx, partnerId: string, record: NewNumberRecord): Promise<NumberView>;
  /** Load a number with the signals the pure availability domain consumes. */
  loadNumberForAvailability(
    tx: Tx,
    partnerId: string,
    numberId: string,
  ): Promise<AgentNumberAvailabilityContext | null>;
  /**
   * Apply a status/enable change; throws `ActiveNumberConflictError` when a
   * re-enable re-claims a canonical slot now held by another active number.
   */
  applyNumberStatus(
    tx: Tx,
    partnerId: string,
    numberId: string,
    mutation: NumberStatusMutation,
  ): Promise<NumberView>;
  /** Append a `NumberStateHistory` row (requirement 7.6). */
  appendStateHistory(tx: Tx, record: NumberStateHistoryRecord): Promise<void>;
  /** Persist an audit event alongside the mutation (requirement 19.1). */
  recordAudit(tx: Tx, input: AuditWriteInput): Promise<void>;
}
