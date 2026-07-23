/**
 * Application-owned ports for the atomic reservation operation (task 9.3).
 *
 * The reservation service orchestrates the pure task 5.2 eligibility/pricing
 * domain (`selectEligibleInventory`, `calculateAuthoritativePricing`) and the
 * task 5.5 order/number state machine (`decideOrderNumberTransition`) over
 * these seams, running the whole reserve+activate effect inside the task 9.2
 * idempotency engine's transaction. Infrastructure supplies the Prisma adapter
 * that performs the `FOR UPDATE SKIP LOCKED` candidate selection and the
 * order/snapshot/number writes; raw Prisma never leaves the adapter.
 *
 * The reservation gateway is parameterized by the transaction handle `Tx` the
 * idempotency engine also writes through, so the order/snapshot/idempotency
 * record and the `available→reserved→busy` number transition all commit
 * atomically (requirement 9.2). Selecting a candidate with a row lock that
 * concurrent reservations skip guarantees at most one reservation wins a number
 * (requirement 9.3); a stockout returns a deterministic result with no partial
 * order (requirement 9.4).
 */
import type {
  InventoryCandidate,
  InventoryFilter,
} from "@domain/task-5-2-device-inventory-pricing";
import type { PlatformConfigSnapshot } from "@application/offers/ports";

export type { InventoryFilter };

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Generates opaque identifiers (UUIDs) for new orders. */
export interface IdGenerator {
  uuid(): string;
}

/**
 * The immutable active platform config plus the order-timeout window the
 * reservation path needs to compute an order's `expiresAt`. Extends the pricing
 * + heartbeat-liveness snapshot the pure eligibility/pricing domain consumes.
 */
export interface ReservationConfig extends PlatformConfigSnapshot {
  /** Order reservation lifetime in seconds (drives `expiresAt`). */
  readonly orderTimeoutSeconds: number;
}

/**
 * A row-locked reservation candidate. `candidate` is the pure-domain projection
 * used to re-apply the full eligibility conjunction (partner approved, device
 * live + sms, offer active, dimension match); the remaining fields carry the
 * persistence identifiers and base price the reserve write needs. The gateway
 * only returns rows it has locked with `FOR UPDATE SKIP LOCKED`, ordered by
 * `number.id ASC`, so the selection is deterministic and contention-safe.
 */
export interface LockedReservationCandidate {
  readonly numberId: string;
  readonly partnerId: string;
  readonly offerId: string;
  readonly canonicalNumber: string;
  readonly basePriceIdr: number;
  readonly candidate: InventoryCandidate;
}

/**
 * The immutable reserve-time snapshot persisted with the order (requirement
 * 9.5). Declared as a `type` (not an `interface`) so it structurally satisfies
 * the idempotency engine's `JsonValue` response constraint when embedded in the
 * reserve response body.
 */
export type OrderSnapshotData = {
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly canonicalNumber: string;
  readonly basePriceIdr: number;
  readonly retailPriceIdr: number;
  readonly payoutIdr: number;
  readonly platformMarginIdr: number;
  readonly currency: string;
  readonly configVersion: number;
};

/** Everything the gateway needs to commit one reservation atomically. */
export interface CommitReservationInput {
  readonly orderId: string;
  readonly buyerOrderRef: string;
  readonly buyerAccountRef: string;
  readonly partnerId: string;
  readonly numberId: string;
  readonly offerId: string;
  readonly snapshot: OrderSnapshotData;
  readonly expiresAtEpochMs: number;
  readonly nowEpochMs: number;
  /**
   * The reserve/activation transition audit trail (requirements 12.1, 12.2,
   * 12.7). `actorRef` is the raw internal-service principal that initiated the
   * reservation; the adapter persists only its hash. The operation keys are the
   * deterministic keys minted by the domain state machine
   * (`createOrderTransitionOperationKey`) for the `created→reserved` and
   * `reserved→waiting_sms` steps, so the recorded `OrderTransition` /
   * `NumberStateHistory` rows are single per transition (unique operation key)
   * and a replayed reserve never double-writes history.
   */
  readonly actorRef: string;
  readonly reserveOperationKey: string;
  readonly activationOperationKey: string;
}

/**
 * Raised by the adapter when the buyer order reference is already used by
 * another order (the `buyerOrderRef` unique constraint). Surfaced to the client
 * as a deterministic conflict rather than an opaque internal error.
 */
export class DuplicateBuyerOrderRefError extends Error {
  constructor() {
    super("An order already exists for this buyer order reference");
    this.name = "DuplicateBuyerOrderRefError";
  }
}

/**
 * Raised by the adapter when the locked number is no longer in the expected
 * `available` state at write time (should be impossible under the row lock).
 * Surfaced as a retryable conflict so the caller re-reads and retries.
 */
export class ReservationContentionError extends Error {
  constructor() {
    super("The selected number changed state during reservation");
    this.name = "ReservationContentionError";
  }
}

/**
 * Transactional reservation persistence, parameterized by the transaction
 * handle `Tx` the idempotency engine also writes through. Every method executes
 * on the caller-provided `tx` so the effect and the idempotency record commit
 * together (design section 3/4).
 */
export interface ReservationGateway<Tx> {
  /** The immutable active platform config (pricing, liveness, order timeout). */
  loadActiveConfig(tx: Tx): Promise<ReservationConfig | null>;
  /**
   * Select and row-lock the available candidates for the catalog filter with
   * `FOR UPDATE SKIP LOCKED`, ordered by `number.id ASC`, returning them with
   * the context the pure eligibility domain and the reserve write need.
   * Concurrent reservations skip locked rows, so at most one wins each number.
   */
  lockEligibleCandidates(
    tx: Tx,
    filter: InventoryFilter,
  ): Promise<readonly LockedReservationCandidate[]>;
  /**
   * Create the order (`reserved`) + snapshot, flip the number
   * `available→reserved` (compare-and-set), then activate the order
   * `reserved→waiting_sms` and the number `reserved→busy`, and record the
   * paired `OrderTransition` + `NumberStateHistory` rows for both steps with
   * the supplied actor/reason/operation keys (requirements 12.1, 12.2, 12.7) —
   * all atomically on `tx`. Throws {@link DuplicateBuyerOrderRefError} or
   * {@link ReservationContentionError} on the respective conflicts.
   */
  commitReservation(tx: Tx, input: CommitReservationInput): Promise<void>;
}
