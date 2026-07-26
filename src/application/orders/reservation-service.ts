/**
 * Atomic reservation service for Internal API v1 `POST /orders/reserve`
 * (task 9.3).
 *
 * Turns a buyer's reservation request into exactly one committed
 * `waiting_sms` order or a deterministic failure, reusing the pieces built in
 * earlier tasks so each rule lives in exactly one place:
 *
 *  - **Idempotency (task 9.2).** The whole effect runs inside
 *    {@link IdempotencyEngine.runIdempotent}, so the order, snapshot, number
 *    transition, and the idempotency record all commit in one transaction and
 *    a retry with the same key + payload replays the first result verbatim
 *    (requirements 9.6, 10.3, 10.4, 10.5). `orders.reserve` is a financial
 *    mutation (it backs a buyer debit downstream) so its record is retained for
 *    7 years.
 *  - **Eligibility + pricing (task 5.2).** The candidate is selected by the
 *    pure `selectEligibleInventory` (deterministic `number.id ASC`) over the
 *    row-locked candidates, and priced by `calculateAuthoritativePricing`. The
 *    client never sets a price (requirement 8.6).
 *  - **State machine (task 5.5).** The `reserved→waiting_sms` /
 *    `reserved→busy` activation is validated by `decideOrderNumberTransition`
 *    before the gateway applies it, keeping the transition legality in the
 *    domain (requirement 9.2).
 *
 * Atomicity + concurrency: the gateway locks candidates with
 * `FOR UPDATE SKIP LOCKED`, so two concurrent reservations can never win the
 * same number (requirement 9.3); the order + snapshot + `available→reserved`
 * flip commit together (requirement 9.2); and a stockout returns a
 * deterministic `OUT_OF_STOCK` result with no partial order (requirement 9.4).
 * A success response is only produced after activation, so Main always sees a
 * consistent, deterministic outcome it can compensate against (requirement 9.6).
 */
import {
  calculateAuthoritativePricing,
  resolveDimensionPricing,
  resolveServedDimension,
  selectEligibleInventory,
  type InventoryFilter,
} from "@domain/task-5-2-device-inventory-pricing";
import { decideOrderNumberTransition } from "@domain/order-state-machine";
import { mapDomainError, type SafeError } from "@domain/task-5-3/safe-errors";
import type { JsonValue } from "@domain/task-5-3/canonical-request-hash";
import { IdempotencyEngine } from "@application/internal-api";

import {
  DuplicateBuyerOrderRefError,
  type Clock,
  type IdGenerator,
  type OrderSnapshotData,
  type ReservationGateway,
} from "./ports";

/** Idempotency scope namespace for the reserve operation. */
export const RESERVE_SCOPE = "orders.reserve";

/** The buyer-supplied reservation request (validated by the transport). */
export interface ReserveRequest {
  readonly buyerOrderRef: string;
  readonly buyerAccountRef: string;
  readonly filter: InventoryFilter;
  readonly quoteVersion: number;
}

/** Everything the service needs to authenticate the idempotent reserve. */
export interface ReserveCommandInput {
  readonly principalId: string;
  readonly idempotencyKey: string | null;
  readonly method: string;
  readonly path: string;
  readonly request: ReserveRequest;
}

/**
 * The success payload returned to Main after activation. Declared as a `type`
 * (not an `interface`) so it structurally satisfies the idempotency engine's
 * `JsonValue` response constraint.
 */
export type ReservedOrderView = {
  readonly partnerOrderId: string;
  readonly number: string;
  readonly snapshot: OrderSnapshotData;
  readonly status: "waiting_sms";
  readonly expiresAt: string;
};

/**
 * The persisted / replayed response body. It is envelope-ready except for the
 * per-request `requestId`, which the transport adds at serialization time so a
 * replay keeps the original body but carries the current request's id.
 */
export type ReserveResponseBody =
  | { readonly data: ReservedOrderView }
  | { readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean } };

/** A normalized reserve result the transport serializes into an envelope. */
export interface ReserveResult {
  readonly statusCode: number;
  readonly body: ReserveResponseBody;
}

const QUOTE_EXPIRED: SafeError = Object.freeze({
  status: 409,
  code: "QUOTE_EXPIRED",
  message: "The quote version is no longer current; request a fresh quote.",
  retryable: false,
});
const CATALOG_UNAVAILABLE: SafeError = Object.freeze({
  status: 404,
  code: "CATALOG_UNAVAILABLE",
  message: "The requested catalog is not served.",
  retryable: false,
});
const BUYER_ORDER_REF_CONFLICT: SafeError = Object.freeze({
  status: 409,
  code: "BUYER_ORDER_REF_CONFLICT",
  message: "An order already exists for this buyer order reference.",
  retryable: false,
});
const OUT_OF_STOCK: SafeError = mapDomainError({ kind: "out_of_stock" });
const DEPENDENCY_UNAVAILABLE: SafeError = mapDomainError({ kind: "dependency_unavailable" });

/** A dependency (e.g. missing active config) is temporarily unavailable. */
class DependencyUnavailableError extends Error {
  constructor() {
    super("A required dependency is unavailable");
    this.name = "DependencyUnavailableError";
  }
}

export interface ReservationServiceDeps<Tx> {
  readonly idempotency: IdempotencyEngine<Tx>;
  readonly gateway: ReservationGateway<Tx>;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export class ReservationService<Tx> {
  private readonly deps: ReservationServiceDeps<Tx>;

  constructor(deps: ReservationServiceDeps<Tx>) {
    this.deps = deps;
  }

  async reserve(input: ReserveCommandInput): Promise<ReserveResult> {
    const { request } = input;
    // Payload bound into the idempotency hash: a retry with a different payload
    // under the same key is a conflict (requirement 10.5). Keys are sorted by
    // the canonical hasher, so field order here is irrelevant.
    const payload: JsonValue = {
      buyerOrderRef: request.buyerOrderRef,
      buyerAccountRef: request.buyerAccountRef,
      serviceCode: request.filter.serviceCode,
      countryCode: request.filter.countryCode,
      operatorCode: request.filter.operatorCode,
      quoteVersion: request.quoteVersion,
    };

    try {
      const outcome = await this.deps.idempotency.runIdempotent<ReserveResponseBody>({
        scope: RESERVE_SCOPE,
        principalId: input.principalId,
        idempotencyKey: input.idempotencyKey,
        method: input.method,
        path: input.path,
        payload,
        retention: "financial",
        effect: (tx) => this.runReserveEffect(tx, request, input.principalId),
      });

      switch (outcome.kind) {
        case "executed":
        case "replayed":
          return { statusCode: outcome.statusCode, body: outcome.response as ReserveResponseBody };
        case "rejected":
          return outcome.code === "IDEMPOTENCY_REQUIRED"
            ? errorResult(mapDomainError({ kind: "idempotency_required" }))
            : errorResult(mapDomainError({ kind: "idempotency_conflict" }));
      }
    } catch {
      // A thrown effect rolled the transaction back, leaving nothing persisted;
      // surface a retryable dependency error so Main may safely retry.
      return errorResult(DEPENDENCY_UNAVAILABLE);
    }
  }

  /**
   * The reserve effect, run inside the idempotency transaction. Business-level
   * failures return a definitive `{ statusCode, response }` so they are
   * persisted and replayed deterministically; transient failures throw to roll
   * the transaction back with nothing persisted.
   */
  private async runReserveEffect(
    tx: Tx,
    request: ReserveRequest,
    principalId: string,
  ): Promise<{ statusCode: number; response: ReserveResponseBody }> {
    const config = await this.deps.gateway.loadActiveConfig(tx);
    if (config === null) {
      // No active config is a transient dependency gap, not a client error.
      throw new DependencyUnavailableError();
    }

    // The filter is matched by MEMBERSHIP of the served catalog, not equality
    // with the config's own dimension, so every enabled dimension is
    // reservable. An absent OR disabled dimension is the same client-visible
    // outcome as before: the catalog is not served. When no catalog has been
    // declared at all the config's own dimension is served, so a database that
    // was migrated before its config was seeded still sells.
    const lookup = await this.deps.gateway.loadDimension(tx, request.filter);
    const dimension = resolveServedDimension(lookup, config, request.filter);
    if (dimension === null) {
      return effectError(CATALOG_UNAVAILABLE);
    }
    // The quote version stays the GLOBAL config version. The quote's price is a
    // function of (global config, that dimension's immutable overrides), and the
    // overrides cannot change without a new config version (enforced by the
    // `catalog_dimensions` immutability trigger), so one global version still
    // expires every outstanding quote exactly as it did before. A per-dimension
    // version would silently stop expiring quotes for dimensions that inherit
    // the global price when a new config is published.
    if (request.quoteVersion !== config.version) {
      return effectError(QUOTE_EXPIRED);
    }
    // Pricing in force for THIS dimension: the global config with the
    // dimension's overrides applied. Global values (currency, version, order
    // timeout, heartbeat window) still come from the config row alone.
    const pricingConfig = resolveDimensionPricing(dimension, config);

    const now = this.deps.clock.nowEpochMs();
    const locked = await this.deps.gateway.lockEligibleCandidates(tx, request.filter);
    const selected = selectEligibleInventory(
      locked.map((row) => row.candidate),
      request.filter,
      new Date(now),
      config.heartbeatTimeoutSeconds,
    );
    if (selected === null) {
      // Deterministic stockout: nothing is written, so no partial order exists.
      return effectError(OUT_OF_STOCK);
    }

    const winner = locked.find((row) => row.numberId === selected.numberId);
    // The selector only ever returns a candidate that came from `locked`.
    if (winner === undefined) throw new DependencyUnavailableError();

    // The snapshot records the authoritative pricing ACTUALLY used, so a
    // dimension carrying an override is snapshotted at the override that was in
    // force at reserve time (requirement 9.5) and the ledger stays zero-sum
    // against it.
    const pricing = calculateAuthoritativePricing(
      { basePriceIdr: winner.basePriceIdr },
      pricingConfig,
    );
    const snapshot: OrderSnapshotData = {
      serviceCode: dimension.serviceCode,
      countryCode: dimension.countryCode,
      operatorCode: dimension.operatorCode,
      canonicalNumber: winner.canonicalNumber,
      basePriceIdr: winner.basePriceIdr,
      retailPriceIdr: pricing.retailPriceIdr,
      payoutIdr: pricing.payoutIdr,
      platformMarginIdr: pricing.platformMarginIdr,
      currency: config.currency,
      configVersion: config.version,
    };

    const orderId = this.deps.idGenerator.uuid();
    // The reserve + activation transition legality lives in the domain state
    // machine; the gateway applies the `available→reserved→busy` /
    // `created→reserved→waiting_sms` states these decisions yield and records
    // each with the deterministic operation key the domain mints. Both must
    // hold for a freshly created order on an available number.
    const reservation = decideOrderNumberTransition({
      orderId,
      orderStatus: "created",
      numberStatus: "available",
      otpReceived: false,
      command: { type: "reserve" },
    });
    if (
      reservation.kind !== "apply" ||
      reservation.nextOrderStatus !== "reserved" ||
      reservation.nextNumberStatus !== "reserved"
    ) {
      throw new Error("Reservation transition invariant violated");
    }
    const activation = decideOrderNumberTransition({
      orderId,
      orderStatus: "reserved",
      numberStatus: "reserved",
      otpReceived: false,
      command: { type: "activate" },
    });
    if (
      activation.kind !== "apply" ||
      activation.nextOrderStatus !== "waiting_sms" ||
      activation.nextNumberStatus !== "busy"
    ) {
      throw new Error("Reservation activation invariant violated");
    }

    const expiresAtEpochMs = now + config.orderTimeoutSeconds * 1000;
    try {
      await this.deps.gateway.commitReservation(tx, {
        orderId,
        buyerOrderRef: request.buyerOrderRef,
        buyerAccountRef: request.buyerAccountRef,
        partnerId: winner.partnerId,
        numberId: winner.numberId,
        offerId: winner.offerId,
        snapshot,
        expiresAtEpochMs,
        nowEpochMs: now,
        // Actor is the internal-service principal that drove the reserve; the
        // adapter persists only its hash (requirement 12.7).
        actorRef: principalId,
        reserveOperationKey: reservation.operationKey,
        activationOperationKey: activation.operationKey,
      });
    } catch (error) {
      if (error instanceof DuplicateBuyerOrderRefError) {
        return effectError(BUYER_ORDER_REF_CONFLICT);
      }
      // Contention or any other write failure rolls the transaction back.
      throw error;
    }

    const view: ReservedOrderView = {
      partnerOrderId: orderId,
      number: winner.canonicalNumber,
      snapshot,
      status: "waiting_sms",
      expiresAt: new Date(expiresAtEpochMs).toISOString(),
    };
    return { statusCode: 200, response: { data: view } };
  }
}

function effectError(error: SafeError): { statusCode: number; response: ReserveResponseBody } {
  return { statusCode: error.status, response: bodyFor(error) };
}

function errorResult(error: SafeError): ReserveResult {
  return { statusCode: error.status, body: bodyFor(error) };
}

function bodyFor(error: SafeError): ReserveResponseBody {
  return { error: { code: error.code, message: error.message, retryable: error.retryable } };
}
