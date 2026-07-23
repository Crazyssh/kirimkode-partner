/**
 * Application-owned ports for the recovery cron jobs (task 16.2).
 *
 * These jobs plug into the task 16.1 {@link import("@application/cron").CronBatchRunner}
 * (lease + resumable cursor + crash-safe re-run) and implement the async
 * boundary described in the design ("Boundary Async dan Recovery" / section 7):
 *
 *  - `offline-sweep` — mark a live device `online → offline` once
 *    `now - lastSeenAt` exceeds the 90s heartbeat timeout, and propagate the
 *    outage only to the device's *idle* (`available`) numbers, flipping them
 *    `available → offline`. A `reserved`/`busy` number backing an active order
 *    is never touched, so an active order is never relocated (requirements 6.2,
 *    6.3, 12.5).
 *  - `reservation-recovery` — promote a reservation stuck in `reserved` beyond
 *    the 30s recovery window to `waiting_sms` (completing activation) when it is
 *    still valid, or release it (`→ cancelled`, freeing the number) when it is
 *    not (the state machine only allows `reserved → cancelled|timeout`).
 *  - `order-timeout` — drive orders past their 20-minute expiry to `timeout`
 *    through the shared task 9.4 transition command.
 *
 * Every batch is bounded, selects its work with `FOR UPDATE SKIP LOCKED` /
 * conditional update, and is idempotent under retry: the offline sweep guards
 * each write with a compare-and-set on the source status, and the two order
 * jobs carry a deterministic per-item operation key so a re-run after a crash
 * reprocesses each item as a no-op (requirements 20.2, 20.5). Infrastructure
 * supplies the Prisma adapters; raw Prisma never leaves them.
 */
import type {
  DeviceEffectiveStatus,
  NumberStatus,
} from "@domain/order-state-machine";
import type { RetentionConfig } from "@domain/task-5-7";
import type {
  PersistedFinding,
  ReconcilePartnerInput,
} from "@domain/task-16-4";

export type { DeviceEffectiveStatus, NumberStatus };

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Generates opaque identifiers (UUIDs) for history rows. */
export interface IdGenerator {
  uuid(): string;
}

// --- offline-sweep ----------------------------------------------------------

/** A live device that has gone stale (its last heartbeat is older than 90s). */
export interface StaleDeviceRow {
  readonly id: string;
}

/**
 * An idle number owned by a swept device. Only `available` numbers are
 * surfaced; `reserved`/`busy` numbers (which back an active order) and
 * `disabled` numbers are excluded by the query so the sweep can never relocate
 * an active order (requirement 12.5).
 */
export interface IdleNumberRow {
  readonly id: string;
  readonly status: NumberStatus;
}

/** A number `available → offline` propagation to persist with its history. */
export interface NumberOfflineChange {
  readonly numberId: string;
  readonly historyId: string;
  /** Raw actor reference (the job name); the adapter persists only its hash. */
  readonly actorRef: string;
  readonly reason: string;
  readonly occurredAtEpochMs: number;
}

/**
 * Operations available inside a single offline-sweep batch transaction. The
 * device liveness flip and each idle-number propagation commit atomically per
 * batch. All writes are compare-and-set on the source status, so a re-run after
 * a crash is a no-op.
 */
export interface OfflineSweepTransaction {
  /**
   * Row-lock up to `limit` live (`online`) devices whose last heartbeat is
   * older than `timeoutMs` (or never set), ordered by `id ASC` after
   * `afterId`, with `FOR UPDATE SKIP LOCKED`.
   */
  lockStaleOnlineDevices(input: {
    readonly nowEpochMs: number;
    readonly timeoutMs: number;
    readonly limit: number;
    readonly afterId: string | null;
  }): Promise<readonly StaleDeviceRow[]>;
  /** Compare-and-set the device `online → offline`; `true` when it changed. */
  markDeviceOffline(deviceId: string): Promise<boolean>;
  /** The device's idle (`available`) numbers, which the outage takes offline. */
  listIdleAvailableNumbers(deviceId: string): Promise<readonly IdleNumberRow[]>;
  /**
   * Compare-and-set an `available → offline` number and append its state
   * history only when the flip actually changed a row. Returns `true` when the
   * number was taken offline.
   */
  applyNumberOffline(change: NumberOfflineChange): Promise<boolean>;
}

/** Runs one offline-sweep batch inside a single platform-global transaction. */
export interface OfflineSweepGateway {
  /** The configured heartbeat liveness window in seconds, or `null` if unset. */
  loadHeartbeatTimeoutSeconds(): Promise<number | null>;
  runInTransaction<T>(
    work: (tx: OfflineSweepTransaction) => Promise<T>,
  ): Promise<T>;
}

// --- reservation-recovery ---------------------------------------------------

/**
 * The order + number + device projection the reservation-recovery decision
 * needs. Loaded under the row lock so the read and the subsequent conditional
 * write are consistent.
 */
export interface StuckReservationContext {
  readonly orderId: string;
  readonly partnerId: string;
  readonly numberId: string;
  readonly version: number;
  /** The number's status; a valid stuck reservation still holds it `reserved`. */
  readonly numberStatus: NumberStatus;
  /** True when the number is still bound to this order (`currentOrderId`). */
  readonly numberBound: boolean;
  readonly numberEnabled: boolean;
  /** True when the owning partner has an active offer for the number's dimension. */
  readonly hasActiveOffer: boolean;
  readonly deviceStatus: DeviceEffectiveStatus;
  readonly deviceLastSeenAtEpochMs: number | null;
}

/** Inputs to apply a recovery `reserved → waiting_sms` promotion (activation). */
export interface PromoteReservationInput {
  readonly orderId: string;
  readonly partnerId: string;
  readonly numberId: string;
  readonly expectedVersion: number;
  /** Raw actor reference (the job name); the adapter persists only its hash. */
  readonly actorRef: string;
  readonly reason: string;
  /** Deterministic domain operation key for the `reserved → waiting_sms` step. */
  readonly operationKey: string;
  readonly nowEpochMs: number;
}

/**
 * Inputs to apply a recovery `reserved → cancelled` release and the paired
 * number release (`reserved → available|offline`).
 */
export interface ReleaseReservationInput {
  readonly orderId: string;
  readonly partnerId: string;
  readonly numberId: string;
  readonly expectedVersion: number;
  readonly fromNumberStatus: NumberStatus;
  readonly toNumberStatus: NumberStatus;
  /** False when the order has no reserved number to release (defensive). */
  readonly numberChanged: boolean;
  readonly actorRef: string;
  readonly reason: string;
  readonly operationKey: string;
  readonly nowEpochMs: number;
}

/**
 * Operations available inside a single reservation-recovery batch transaction.
 * The order transition, the paired number transition, and the history rows all
 * commit atomically per item. Every write is compare-and-set on the order
 * version + source statuses, so a re-run after a crash is a no-op and an active
 * order is never relocated.
 */
export interface ReservationRecoveryTransaction {
  /**
   * Row-lock up to `limit` orders stuck in `reserved` whose `reservedAt` is
   * older than `staleBeforeEpochMs`, ordered by `id ASC` after `afterId`, with
   * `FOR UPDATE SKIP LOCKED`, returning the recovery context for each.
   */
  lockStuckReservations(input: {
    readonly staleBeforeEpochMs: number;
    readonly limit: number;
    readonly afterId: string | null;
  }): Promise<readonly StuckReservationContext[]>;
  /** Apply the `reserved → waiting_sms` / number `reserved → busy` promotion. */
  promote(input: PromoteReservationInput): Promise<void>;
  /** Apply the `reserved → cancelled` release and the paired number release. */
  release(input: ReleaseReservationInput): Promise<void>;
}

/** Runs one reservation-recovery batch inside a platform-global transaction. */
export interface ReservationRecoveryGateway {
  /** The reservation recovery window in seconds, or `null` if unset. */
  loadReservationRecoverySeconds(): Promise<number | null>;
  /** The heartbeat liveness window in seconds, used to decide a number release. */
  loadHeartbeatTimeoutSeconds(): Promise<number | null>;
  runInTransaction<T>(
    work: (tx: ReservationRecoveryTransaction) => Promise<T>,
  ): Promise<T>;
}

// --- order-timeout ----------------------------------------------------------

/**
 * Read port for the order-timeout job. Resolves a bounded, ordered page of
 * order ids that are past their expiry and not yet terminal, so the job can
 * drive each to `timeout` through the shared task 9.4 transition command.
 */
export interface OrderTimeoutGateway {
  /**
   * Ids of up to `limit` orders in `reserved`/`waiting_sms` whose `expiresAt`
   * is at or before `nowEpochMs` and which have not received an OTP, ordered by
   * `id ASC` after `afterId`.
   */
  listExpiredOrderIds(input: {
    readonly nowEpochMs: number;
    readonly limit: number;
    readonly afterId: string | null;
  }): Promise<readonly string[]>;
}

// --- earning-release --------------------------------------------------------

/**
 * A pending Earning whose 24h hold has elapsed and is a candidate for release.
 * The `partnerId` is carried alongside the id because the shared task 14.2
 * hold-release command is tenant-scoped and re-checks the hold itself.
 */
export interface ReleasableEarningRow {
  readonly earningId: string;
  readonly partnerId: string;
}

/**
 * Read port for the `earning-release` job. Resolves a bounded, id-ordered page
 * of `pending` Earnings whose `availableAt` is at or before `nowEpochMs`, so the
 * job can drive each `pending → available` through the shared task 14.2
 * hold-release command. This gateway only reads; the release (projection CAS +
 * zero-sum ledger append) lives entirely in the shared command.
 */
export interface EarningReleaseGateway {
  listReleasableEarnings(input: {
    readonly nowEpochMs: number;
    readonly limit: number;
    readonly afterId: string | null;
  }): Promise<readonly ReleasableEarningRow[]>;
}

// --- retention-redaction ----------------------------------------------------

/**
 * The disposable retention categories this job processes, in pass order. The
 * protected financial/audit categories (`audit`, `ledger`, `payout`) are
 * deliberately absent: their pure-domain disposal is `protect`, so the
 * retention job must never redact or delete them (requirement 19.5). The job
 * asserts `isProtectedEvidence(category) === false` before every pass as
 * defence-in-depth.
 */
export const RETENTION_PASS_CATEGORIES = [
  "sms_raw",
  "otp",
  "heartbeat_metadata",
  "security_log",
] as const;

export type RetentionPassCategory = (typeof RETENTION_PASS_CATEGORIES)[number];

export type { RetentionConfig };

/** Inputs to one bounded retention batch for a single category. */
export interface RetentionBatchInput {
  /**
   * The retention boundary: only records whose reference instant (SMS
   * `receivedAtServer`, order `terminalAt`, heartbeat `receivedAt`, security
   * event `createdAt`) is at or before this instant are disposed of. The job
   * computes it as `now - window`, so a record is only ever touched once its
   * window has fully elapsed (mirrors the pure `decideRetention` boundary).
   */
  readonly olderThanEpochMs: number;
  /** Current server time; used to stamp the redaction instant (`redactedAt`). */
  readonly nowEpochMs: number;
  readonly limit: number;
  readonly afterId: string | null;
}

/** The result of one bounded retention batch. */
export interface RetentionBatchResult {
  /** How many records this batch redacted/deleted. */
  readonly processed: number;
  /** The largest id examined this batch, for the resumable cursor, or `null`. */
  readonly lastId: string | null;
  /** `true` when fewer than `limit` candidates remained (backlog drained). */
  readonly drained: boolean;
}

/**
 * Runs the per-category retention passes. Each op selects a bounded, id-ordered
 * page of due candidates and disposes of them idempotently:
 *
 *  - `redactRawSms` — overwrite the SMS sender/body ciphertext and stamp
 *    `redactedAt`; the `redactedAt IS NULL` filter makes a re-run a no-op and
 *    keeps the SMS row (and its match/audit linkage) intact.
 *  - `redactOtp` — null out the order's OTP ciphertext/key/fingerprint on a
 *    terminal order; the `otpCiphertext IS NOT NULL` filter makes a re-run a
 *    no-op and the order/earning/ledger records are untouched.
 *  - `pruneHeartbeatMetadata` — delete stale `DeviceHeartbeat` samples; the
 *    authoritative `lastSeenAt` liveness on the device is a separate column and
 *    is preserved.
 *  - `pruneSecurityEvents` — delete stale `SecurityEvent` rows.
 *
 * The financial/audit evidence tables are never touched here (requirement
 * 19.5). Infrastructure supplies the Prisma adapter; raw Prisma never leaves it.
 */
export interface RetentionGateway {
  /**
   * The active platform retention windows (as durations in ms), or `null` when
   * no config is active (the job then falls back to the design defaults).
   */
  loadRetentionConfig(): Promise<RetentionConfig | null>;
  redactRawSms(input: RetentionBatchInput): Promise<RetentionBatchResult>;
  redactOtp(input: RetentionBatchInput): Promise<RetentionBatchResult>;
  pruneHeartbeatMetadata(
    input: RetentionBatchInput,
  ): Promise<RetentionBatchResult>;
  pruneSecurityEvents(input: RetentionBatchInput): Promise<RetentionBatchResult>;
}

// --- reconcile --------------------------------------------------------------

/**
 * A single tenant's persisted state, loaded for the reconciler. It is exactly
 * the pure {@link ReconcilePartnerInput} minus the two values the job supplies
 * from its clock and platform config (`nowEpochMs`, `heartbeatTimeoutMs`), so
 * the gateway concerns itself only with reading DB state.
 */
export type PartnerReconciliationState = Omit<
  ReconcilePartnerInput,
  "nowEpochMs" | "heartbeatTimeoutMs"
>;

/** The outcome of persisting a batch of findings for one tenant. */
export interface ReconciliationRecordResult {
  /** How many findings were newly recorded as `open` issues. */
  readonly recorded: number;
  /** How many findings matched an already-open issue and were deduped. */
  readonly duplicates: number;
}

export type { PersistedFinding };

/**
 * Read + record port for the `reconcile` job (task 16.4).
 *
 * A job lease is platform-global (task 16.1), so the adapter scans every
 * tenant. The reconciler pages by partner id: {@link listPartnerIds} yields a
 * bounded, id-ordered page; {@link loadPartnerState} loads that tenant's
 * financial and operational projection for the pure {@link ReconcilePartnerInput};
 * and {@link recordIssues} persists the classified findings through the shared
 * {@link import("@infrastructure/database").PrismaReconciliationIssueRepository},
 * which dedupes each `(partnerId, type, referenceId)` open issue so a re-run
 * records nothing new. The reconciler only ever reads state and records issues;
 * it never repairs money (requirement 20.6). Infrastructure supplies the Prisma
 * adapter; raw Prisma never leaves it.
 */
export interface ReconciliationGateway {
  /** The configured heartbeat liveness window in seconds, or `null` if unset. */
  loadHeartbeatTimeoutSeconds(): Promise<number | null>;
  /**
   * Ids of up to `limit` partners ordered by `id ASC` after `afterId`, so the
   * reconciler can bound each batch to a page of tenants.
   */
  listPartnerIds(input: {
    readonly limit: number;
    readonly afterId: string | null;
  }): Promise<readonly string[]>;
  /** Load one tenant's financial + operational reconciliation state. */
  loadPartnerState(partnerId: string): Promise<PartnerReconciliationState>;
  /**
   * Persist the tenant's classified findings, deduping each against an existing
   * open issue. Never mutates money — only records issues (requirement 20.6).
   */
  recordIssues(input: {
    readonly partnerId: string;
    readonly findings: readonly PersistedFinding[];
  }): Promise<ReconciliationRecordResult>;
}
