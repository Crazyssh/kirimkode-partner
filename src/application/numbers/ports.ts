/**
 * Application-owned ports for the PartnerNumber lifecycle commands (task 8.3).
 *
 * The number-management service orchestrates the pure task 5.2 number domain
 * (`normalizeIndonesianNumber`, `assertUniqueActiveNumber`,
 * `assertNumberMoveOrDeleteAllowed`, `disableIdleNumber`, `reenableNumber`)
 * over these ports; infrastructure supplies the Prisma adapter built on the
 * task 7.1 tenant-scoped repositories + unit of work. Registering a number,
 * moving it to another device, disabling/re-enabling it, and deleting it each
 * run inside a single tenant-scoped transaction so the `PartnerNumber` mutation,
 * its `NumberStateHistory` entry (requirement 7.6), and the audit event commit
 * atomically. Raw Prisma never leaves the adapter.
 *
 * Global uniqueness of the *active* canonical number for the MVP (requirement
 * 7.2) is enforced by a database unique constraint on the number's
 * `activeCanonicalNumber` slot (set while non-disabled, cleared on disable). A
 * cross-tenant collision therefore surfaces as {@link ActiveNumberConflictError}
 * from the adapter, which the service maps to a stable `duplicate_active_number`
 * outcome. The pure domain additionally rejects same-tenant duplicates early.
 */
import type { AuditActorType, AuditEventDescriptor } from "@domain/task-5-7";
import type { NumberStatus } from "@domain/task-5-2-device-inventory-pricing";
import type { TenantContext } from "@infrastructure/database";

export type { AuditActorType, NumberStatus };

/**
 * Raised by the persistence adapter when the global unique-active-canonical
 * slot is already taken (requirement 7.2). Declared here, in the application
 * port, so the adapter can throw a layer-neutral error the service catches
 * without importing Prisma error types.
 */
export class ActiveNumberConflictError extends Error {
  constructor() {
    super("An active number already uses this canonical number");
    this.name = "ActiveNumberConflictError";
  }
}

/** A safe, tenant-scoped view of a `PartnerNumber` (never internal columns). */
export interface NumberView {
  readonly id: string;
  readonly partnerId: string;
  readonly deviceId: string;
  readonly canonicalNumber: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly status: NumberStatus;
  readonly enabled: boolean;
  /** True when the number still points at an active order. */
  readonly hasActiveOrder: boolean;
}

/** A minimal reference used to confirm a device belongs to the tenant. */
export interface DeviceRef {
  readonly id: string;
}

/** The row to insert when registering a number. */
export interface NewNumberRecord {
  readonly id: string;
  readonly deviceId: string;
  readonly canonicalNumber: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly status: NumberStatus;
  readonly enabled: boolean;
  /**
   * The globally unique active-canonical slot. Set to the canonical number
   * while the number is non-disabled; `null` frees the slot on disable.
   */
  readonly activeCanonicalNumber: string | null;
  readonly createdAtEpochMs: number;
}

/** A status/enable mutation applied to an existing number. */
export interface NumberStatusMutation {
  /**
   * The status the caller read before deciding this mutation. It is folded into
   * the update predicate as a compare-and-set guard: if the number has since
   * moved off it (e.g. a concurrent reservation flipped `available -> reserved`),
   * the write matches no row and the adapter raises a concurrency conflict
   * instead of clobbering the newer state (requirement 7.4).
   */
  readonly expectedStatus: NumberStatus;
  readonly status: NumberStatus;
  readonly enabled: boolean;
  readonly activeCanonicalNumber: string | null;
}

/** A `NumberStateHistory` row appended on every status change (req 7.6). */
export interface NumberStateHistoryRecord {
  readonly id: string;
  readonly numberId: string;
  readonly fromStatus: NumberStatus | null;
  readonly toStatus: NumberStatus;
  readonly actorType: AuditActorType;
  /** Raw actor reference (the member id); the adapter stores only its hash. */
  readonly actorRef: string;
  readonly reason: string;
  readonly occurredAtEpochMs: number;
}

/** An audit event to persist alongside a number mutation (requirement 19.1). */
export interface AuditWriteInput {
  readonly id: string;
  readonly partnerId: string;
  readonly requestId: string;
  readonly descriptor: AuditEventDescriptor;
}

/**
 * Operations available inside a tenant-scoped number-management transaction.
 * Every read/write is folded with the tenant's `partnerId` (task 7.1), so a
 * cross-tenant id is indistinguishable from a missing row (`null`).
 */
export interface NumberManagementTransaction {
  /** Confirm a device exists within the tenant (register / move target). */
  findDeviceRef(deviceId: string): Promise<DeviceRef | null>;
  findNumberById(id: string): Promise<NumberView | null>;
  /** The tenant's own non-disabled numbers, for the same-tenant duplicate check. */
  listTenantActiveNumbers(): Promise<
    readonly { readonly id: string; readonly canonicalNumber: string; readonly status: NumberStatus }[]
  >;
  /** Insert a number; throws {@link ActiveNumberConflictError} on collision. */
  insertNumber(record: NewNumberRecord): Promise<NumberView>;
  /**
   * Apply a status/enable change; throws {@link ActiveNumberConflictError} when
   * re-activating a canonical number now held by another active number.
   */
  updateNumberStatus(id: string, mutation: NumberStatusMutation): Promise<NumberView>;
  /**
   * Re-home a number onto another device of the same tenant. `expectedStatus`
   * is the status the caller read before the move; it is a compare-and-set guard
   * so a number that was reserved/busied under us is never re-homed mid-order.
   */
  moveNumberDevice(id: string, deviceId: string, expectedStatus: NumberStatus): Promise<NumberView>;
  /** Hard-delete a number and its state history. */
  deleteNumberById(id: string): Promise<void>;
  appendStateHistory(record: NumberStateHistoryRecord): Promise<void>;
  recordAudit(input: AuditWriteInput): Promise<void>;
}

/**
 * Runs number-management work inside a single tenant-scoped transaction bound
 * to a validated {@link TenantContext} (task 7.1 unit of work).
 */
export interface NumberManagementGateway {
  runInTenant<T>(
    tenant: TenantContext,
    work: (tx: NumberManagementTransaction) => Promise<T>,
  ): Promise<T>;
}

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Generates opaque identifiers (UUIDs) for new numbers/history/audit rows. */
export interface IdGenerator {
  uuid(): string;
}
