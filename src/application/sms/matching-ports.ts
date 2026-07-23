/**
 * Application-owned ports for the SMS ingestion / matching pipeline (task 12.2).
 *
 * The pipeline glues the task 12.1 encryption + persistence building blocks to
 * the pure task 5.4 SMS matching / OTP parser domain, all inside a single
 * database transaction, so an inbound SMS is encrypted, deduplicated, matched
 * to at most one active order, and — when exactly one order matches and the
 * `wa` parser extracts a single OTP — associated to that order with the order
 * transitioned `waiting_sms → success`, or otherwise stored for audit as
 * `unmatched` / `ambiguous` with no OTP ever delivered (requirements 11.1,
 * 11.2, 11.4, 11.5, 11.7; design section 8).
 *
 * These seams keep the pipeline free of Prisma and `node:crypto`: infrastructure
 * supplies the transaction runner, the ownership/candidate/success gateway, the
 * config reader, the id generator, and the clock, while the encrypted SMS
 * persistence reuses the existing task 12.1 {@link import("./ports").PartnerSmsGateway}.
 * The concrete Prisma adapter is wired by the task 12.3 endpoint composition
 * root; the pipeline itself is fully unit-testable behind in-memory fakes.
 */
import type {
  DeviceEffectiveStatus,
  NumberStatus,
  OrderStatus,
} from "@domain/order-state-machine";
import type { LedgerTransaction } from "@domain/task-5-6";

export type { DeviceEffectiveStatus, NumberStatus, OrderStatus };

/**
 * The single pending Earning to persist on first success (task 13.3). Built by
 * the pure `decideEarningOnSuccess` from the snapshot payout and the 24h hold,
 * so the amount and `availableAt` are decided in the domain, never the adapter.
 */
export interface SmsSuccessEarning {
  readonly id: string;
  readonly amountIdr: number;
  readonly availableAtEpochMs: number;
}

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Generates the opaque UUID for a freshly persisted PartnerSms row. */
export interface IdGenerator {
  uuid(): string;
}

/**
 * Runs a unit of work inside a single database transaction, exposing the
 * transaction handle `Tx` to the work function. The whole ingestion pipeline
 * (persist SMS → match → parse → success transition) runs through one call so
 * either every effect commits or none does (design section 8: "dilakukan dalam
 * satu transaksi idempotent"). Structurally identical to the Internal API
 * idempotency runner, so the shared Prisma adapter satisfies both.
 */
export interface SmsMatchingTransactionRunner<Tx> {
  run<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}

/**
 * The device + number ownership projection the pipeline feeds to the pure
 * `decideSmsIngress` policy (task 5.4). Loaded scoped to the trusted tenant, so
 * a cross-tenant or missing device/number surfaces as `null` (indistinguishable
 * from absent) and the pipeline rejects the SMS as an ownership mismatch before
 * persisting anything (requirement 11.1; task 7.1 defense-in-depth).
 */
export interface SmsOwnershipContext {
  readonly device: Readonly<{ id: string; partnerId: string }>;
  readonly number: Readonly<{ id: string; partnerId: string; deviceId: string }>;
}

/**
 * Config the matching pipeline needs. `heartbeatTimeoutSeconds` decides whether
 * the number released on a successful order returns to `available` (device
 * live) or `offline` (device stale), reusing the pure `decideNumberRelease`
 * rule (design section 7/8). `earningHoldSeconds` is the 24h hold applied when
 * the single pending Earning is created on success (design section 10; task
 * 13.3): `availableAt = succeededAt + earningHoldSeconds`.
 */
export interface SmsMatchingConfig {
  readonly heartbeatTimeoutSeconds: number;
  readonly earningHoldSeconds: number;
}

/**
 * A candidate active order on the SMS's number, as loaded for matching. The
 * matching window is the order's `waiting_sms` interval: `windowStartsAtMs` is
 * when it entered `waiting_sms` and `windowEndsAtMs` is its expiry. The pure
 * `matchSmsToActiveOrder` accepts the SMS only when its server-received instant
 * falls inside exactly one such window.
 */
export interface SmsOrderCandidateRow {
  readonly id: string;
  readonly numberId: string;
  readonly serviceCode: string;
  readonly status: OrderStatus;
  readonly windowStartsAtMs: number;
  readonly windowEndsAtMs: number;
}

/**
 * The order + number + device projection the success transition needs. Loaded
 * inside the pipeline transaction so the read and the subsequent compare-and-set
 * write are consistent. Mirrors the task 9.4 transition context but is scoped to
 * the `waiting_sms → success` path.
 */
export interface OrderSuccessContext {
  readonly orderId: string;
  readonly partnerId: string;
  readonly numberId: string;
  readonly version: number;
  readonly orderStatus: OrderStatus;
  readonly numberStatus: NumberStatus;
  /** True once an OTP was already extracted for the order (blocks a re-success). */
  readonly otpReceived: boolean;
  readonly numberEnabled: boolean;
  readonly deviceStatus: DeviceEffectiveStatus;
  readonly deviceLastSeenAtEpochMs: number | null;
  /**
   * The authoritative partner payout taken from the immutable OrderSnapshot
   * (design section 8: "payout snapshot = base"). This is the exact amount of
   * the single pending Earning and of the zero-sum ledger success event created
   * on first success (task 13.3; requirement 13.1).
   */
  readonly payoutIdr: number;
  /**
   * True when an Earning already exists for this order. A retried / duplicate
   * success must never create a second Earning or duplicate ledger entries
   * (requirement 13.7); the pure `decideEarningOnSuccess` uses this as its
   * dedupe guard and the DB `orderId` / `eventKey` unique constraints are the
   * transactional backstop.
   */
  readonly earningExistsForOrder: boolean;
}

/**
 * Everything the gateway needs to commit one successful match atomically: store
 * the encrypted OTP on the order, flip the order `waiting_sms → success`
 * (compare-and-set on version + source status), release the number
 * (`busy → available|offline`), write the order/number history rows, mark the
 * SMS `matched` with its `matchedOrderId` + `extractedAt`, create the single
 * pending Earning, and append the zero-sum `order-success` ledger event
 * (task 13.3).
 */
export interface ApplySmsSuccessInput {
  readonly smsId: string;
  readonly orderId: string;
  readonly partnerId: string;
  readonly numberId: string;
  readonly expectedOrderVersion: number;
  readonly fromNumberStatus: NumberStatus;
  readonly toNumberStatus: NumberStatus;
  readonly numberChanged: boolean;
  readonly otpCiphertext: Uint8Array;
  readonly otpKeyVersion: number;
  readonly otpFingerprint: string;
  readonly operationKey: string;
  /** Raw actor reference; the adapter persists only its hash. */
  readonly actorRef: string;
  readonly nowEpochMs: number;
  /**
   * The single pending Earning to insert as part of this same transaction
   * (task 13.3; requirement 13.1). Unique on `orderId` so a duplicate success
   * can never create a second one.
   */
  readonly earning: SmsSuccessEarning;
  /**
   * The zero-sum `order-success` ledger transaction to append in this same
   * transaction (design section 10). Its `eventKey` is unique
   * (`order-success:{orderId}`) so a retry is a deterministic no-op
   * (requirement 13.7).
   */
  readonly ledger: LedgerTransaction;
}

/** The terminal match status persisted onto a stored SMS that carries no OTP. */
export type SmsAuditMatchStatus = "unmatched" | "ambiguous";

/**
 * Raised by the adapter when the compare-and-set success write matched no row
 * (the order/number moved on since it was read — e.g. a concurrent SMS already
 * succeeded it, or a timeout fired). Surfaced by the pipeline as a retryable
 * conflict so the caller may re-attempt; on retry the SMS is a duplicate and
 * the pipeline short-circuits without re-matching.
 */
export class SmsSuccessContentionError extends Error {
  constructor() {
    super("The order or number changed state during the SMS success transition");
    this.name = "SmsSuccessContentionError";
  }
}

/**
 * Transactional, tenant-scoped persistence for the matching pipeline,
 * parameterized by the transaction handle `Tx` the SMS insert also writes
 * through, so ownership resolution, matching, the success transition, and the
 * SMS status update all commit together. Raw Prisma never leaves the adapter.
 */
export interface SmsMatchingGateway<Tx> {
  /** Resolve the device + number ownership context within the trusted tenant. */
  loadOwnershipContext(
    tx: Tx,
    partnerId: string,
    deviceId: string,
    numberId: string,
  ): Promise<SmsOwnershipContext | null>;

  /** Load the immutable config values the success number-release needs. */
  loadActiveConfig(tx: Tx): Promise<SmsMatchingConfig | null>;

  /** Load the `waiting_sms` order candidates on a number for matching. */
  loadActiveOrderCandidates(
    tx: Tx,
    partnerId: string,
    numberId: string,
  ): Promise<readonly SmsOrderCandidateRow[]>;

  /** Load the success transition context for the single matched order. */
  loadSuccessContext(tx: Tx, orderId: string): Promise<OrderSuccessContext | null>;

  /**
   * Commit a successful match: OTP on the order, order `→success`, number
   * release, history rows, the SMS `→matched`, the single pending Earning, and
   * the zero-sum `order-success` ledger event — all in one transaction (task
   * 13.3). Throws {@link SmsSuccessContentionError} when the compare-and-set
   * matches no row.
   */
  applySuccess(tx: Tx, input: ApplySmsSuccessInput): Promise<void>;

  /**
   * Mark a stored SMS `unmatched` or `ambiguous` (no OTP delivered, order left
   * untouched) for audit. Never associates an OTP with any order (requirement
   * 11.5: "tidak mengisi OTP order mana pun").
   */
  markSmsAudited(
    tx: Tx,
    input: Readonly<{ smsId: string; matchStatus: SmsAuditMatchStatus; nowEpochMs: number }>,
  ): Promise<void>;
}
