/**
 * Application-owned ports for the Internal API v1 order operations built in
 * task 9.4: status/OTP lookup, cancel, timeout, and batch reconciliation.
 *
 * These operations reuse the pure task 5.5 order/number state machine
 * (`decideOrderNumberTransition`, `decideNumberRelease`) and — for the cancel
 * and timeout mutations — the task 9.2 idempotency engine's transaction, so the
 * order transition, the paired number release, the transition history, and the
 * idempotency record all commit atomically (design section 4).
 *
 * Unlike the tenant-scoped repositories (task 7.1), the Internal API is
 * authenticated by a service principal (the Main Platform), not a partner
 * tenant, so these gateways resolve an order by its opaque UUID across all
 * partners — exactly like the task 9.3 reservation gateway. Infrastructure
 * supplies the Prisma adapter; raw Prisma never leaves the adapter, and raw SMS
 * is never surfaced through any of these seams (requirement 11.6/19.6).
 */
import type {
  DeviceEffectiveStatus,
  NumberStatus,
  OrderStatus,
  ReleaseDisposition,
} from "@domain/order-state-machine";

export type { OrderStatus, NumberStatus, ReleaseDisposition, DeviceEffectiveStatus };

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/**
 * Decrypts a stored OTP ciphertext for display through the Internal API status
 * endpoint (requirement 11.6). This is a deliberately narrow seam: the SMS/OTP
 * encryption envelope is owned by task 12.1, which will supply the concrete
 * implementation. Keeping it behind this port lets task 9.4 return an OTP for
 * the requested order today without depending on the encryption module's
 * internals, and without ever exposing raw SMS. Returns `null` when the
 * ciphertext cannot be decrypted (e.g. an unknown key version), so a display
 * failure degrades to "no OTP yet" rather than leaking an error.
 */
export interface OtpDecryptor {
  decrypt(input: {
    readonly ciphertext: Uint8Array;
    readonly keyVersion: number;
  }): Promise<string | null>;
}

/**
 * The read projection of an order the status endpoint needs. `otpCiphertext`
 * and `otpKeyVersion` are the encrypted OTP for this order only; they are
 * decrypted lazily via {@link OtpDecryptor} and never returned raw. Timestamps
 * are epoch milliseconds (the transport formats them as ISO-8601 UTC).
 */
export interface OrderDetail {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly terminalReason: string | null;
  readonly otpCiphertext: Uint8Array | null;
  readonly otpKeyVersion: number | null;
  readonly createdAtEpochMs: number;
  readonly reservedAtEpochMs: number | null;
  readonly waitingAtEpochMs: number | null;
  readonly succeededAtEpochMs: number | null;
  readonly terminalAtEpochMs: number | null;
  readonly expiresAtEpochMs: number;
}

/** Read port for the status endpoint (no transaction required — pure query). */
export interface OrderStatusGateway {
  loadOrderDetail(orderId: string): Promise<OrderDetail | null>;
}

/**
 * The immutable config values the cancel/timeout transitions need: the
 * heartbeat-liveness window that decides whether a released number returns to
 * `available` or `offline`, and the minimum age before a non-compensation
 * cancel is permitted (design section 2, seed: cancel 3 minutes).
 */
export interface OrderOperationsConfig {
  readonly heartbeatTimeoutSeconds: number;
  readonly cancelMinimumSeconds: number;
}

/**
 * The order + number + device projection the state machine needs to decide a
 * terminal transition and its paired number release. Loaded inside the
 * idempotency transaction so the read and the subsequent write are consistent.
 */
export interface OrderTransitionContext {
  readonly orderId: string;
  readonly partnerId: string;
  readonly numberId: string;
  readonly version: number;
  readonly orderStatus: OrderStatus;
  readonly numberStatus: NumberStatus;
  /** True once an OTP was extracted for the order (blocks cancel/timeout). */
  readonly otpReceived: boolean;
  readonly createdAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  readonly numberEnabled: boolean;
  readonly deviceStatus: DeviceEffectiveStatus;
  readonly deviceLastSeenAtEpochMs: number | null;
}

/** Everything the gateway needs to apply one terminal transition atomically. */
export interface ApplyTerminalTransitionInput {
  readonly orderId: string;
  readonly partnerId: string;
  readonly numberId: string;
  readonly expectedVersion: number;
  readonly fromOrderStatus: OrderStatus;
  readonly toOrderStatus: Extract<OrderStatus, "cancelled" | "timeout" | "failed">;
  readonly fromNumberStatus: NumberStatus;
  readonly toNumberStatus: NumberStatus;
  readonly numberChanged: boolean;
  readonly terminalReason: string;
  /** Raw actor reference; the adapter persists only its hash. */
  readonly actorRef: string;
  readonly operationKey: string;
  readonly nowEpochMs: number;
}

/**
 * Raised by the adapter when the compare-and-set terminal write matched no row
 * (the order/number moved on since it was read). Surfaced as a retryable state
 * conflict so Main re-reads and retries.
 */
export class TerminalTransitionContentionError extends Error {
  constructor() {
    super("The order or number changed state during the terminal transition");
    this.name = "TerminalTransitionContentionError";
  }
}

/**
 * Transactional persistence for the cancel/timeout transitions, parameterized
 * by the transaction handle `Tx` the idempotency engine also writes through, so
 * the terminal write and the idempotency record commit together.
 */
export interface OrderTransitionGateway<Tx> {
  loadActiveConfig(tx: Tx): Promise<OrderOperationsConfig | null>;
  loadTransitionContext(
    tx: Tx,
    orderId: string,
  ): Promise<OrderTransitionContext | null>;
  /**
   * Apply the order `→cancelled|timeout|failed` transition and the paired
   * number release (`→available|offline`) with a compare-and-set on the order
   * version, writing the `OrderTransition` and `NumberStateHistory` rows. A
   * `failed` transition from `created` has no reserved number, so
   * `numberChanged` is false and no release is written. Throws
   * {@link TerminalTransitionContentionError} when the CAS matches no row.
   */
  applyTerminalTransition(
    tx: Tx,
    input: ApplyTerminalTransitionInput,
  ): Promise<void>;
}

/** One authoritative status entry for a reconciliation batch item. */
export interface ReconciliationStatusEntry {
  readonly ref: string;
  readonly found: boolean;
  readonly status: OrderStatus | null;
  readonly terminalReason: string | null;
}

/**
 * Read port for the batch reconciliation endpoint. Resolves each requested
 * `partnerOrderId` to the authoritative Partner status, in the same order as
 * the request. Runs inside the idempotency transaction.
 */
export interface OrderReconciliationGateway<Tx> {
  loadOrderStatuses(
    tx: Tx,
    refs: readonly string[],
  ): Promise<readonly ReconciliationStatusEntry[]>;
}
