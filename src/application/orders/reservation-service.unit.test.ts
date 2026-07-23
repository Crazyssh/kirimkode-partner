import { beforeEach, describe, expect, it } from "vitest";

import type {
  DeviceCapabilities,
  InventoryCandidate,
  InventoryFilter,
} from "@domain/task-5-2-device-inventory-pricing";
import {
  IdempotencyEngine,
  type IdempotencyRecordInsert,
  type IdempotencyRecordLookup,
  type IdempotencyRecordRow,
  type IdempotencyStore,
  type IdempotencyTransactionRunner,
} from "@application/internal-api";

import { ReservationService, type ReserveCommandInput } from "./reservation-service";
import {
  DuplicateBuyerOrderRefError,
  ReservationContentionError,
  type CommitReservationInput,
  type LockedReservationCandidate,
  type ReservationConfig,
  type ReservationGateway,
} from "./ports";

const NOW = 1_700_000_000_000;

const CONFIG: ReservationConfig = Object.freeze({
  version: 1,
  serviceCode: "wa",
  countryCode: "ID",
  operatorCode: "any",
  currency: "IDR",
  minBasePriceIdr: 500,
  maxBasePriceIdr: 5_000,
  fixedFeeIdr: 250,
  markupBps: 1_500,
  roundToIdr: 50,
  heartbeatTimeoutSeconds: 90,
  orderTimeoutSeconds: 1_200,
});

const FILTER: InventoryFilter = Object.freeze({
  serviceCode: "wa",
  countryCode: "ID",
  operatorCode: "any",
});

const SMS_CAPS: DeviceCapabilities = Object.freeze({
  sms: true,
  notification: false,
  resend: false,
  operator: false,
  slots: 1,
});

/** An opaque transaction marker; the fakes ignore its contents. */
type Tx = { readonly id: "tx" };
const TX: Tx = Object.freeze({ id: "tx" });

class FakeClock {
  constructor(public value = NOW) {}
  nowEpochMs(): number {
    return this.value;
  }
}

class FakeIdGenerator {
  private counter = 0;
  uuid(): string {
    this.counter += 1;
    return `order-${this.counter}`;
  }
}

/** Non-transactional runner: runs the work with a shared marker handle. */
class FakeRunner implements IdempotencyTransactionRunner<Tx> {
  async run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return work(TX);
  }
}

/** In-memory idempotency record store keyed on (scope, principalId, key). */
class FakeStore implements IdempotencyStore<Tx> {
  readonly rows = new Map<string, IdempotencyRecordRow>();
  private id(lookup: IdempotencyRecordLookup): string {
    return `${lookup.scope}|${lookup.principalId}|${lookup.key}`;
  }
  async find(_tx: Tx, lookup: IdempotencyRecordLookup): Promise<IdempotencyRecordRow | null> {
    return this.rows.get(this.id(lookup)) ?? null;
  }
  async insert(_tx: Tx, record: IdempotencyRecordInsert): Promise<{ readonly inserted: boolean }> {
    const key = this.id(record);
    if (this.rows.has(key)) return { inserted: false };
    this.rows.set(key, {
      scope: record.scope,
      principalId: record.principalId,
      key: record.key,
      requestHash: record.requestHash,
      responseStatus: record.responseStatus,
      responseJson: record.responseJson,
    });
    return { inserted: true };
  }
}

class FakeReservationGateway implements ReservationGateway<Tx> {
  config: ReservationConfig | null = CONFIG;
  candidates: LockedReservationCandidate[] = [];
  readonly committed: CommitReservationInput[] = [];
  readonly duplicateRefs = new Set<string>();
  contention = false;

  async loadActiveConfig(): Promise<ReservationConfig | null> {
    return this.config;
  }
  async lockEligibleCandidates(): Promise<readonly LockedReservationCandidate[]> {
    return this.candidates;
  }
  async commitReservation(_tx: Tx, input: CommitReservationInput): Promise<void> {
    if (this.duplicateRefs.has(input.buyerOrderRef)) {
      throw new DuplicateBuyerOrderRefError();
    }
    if (this.contention) throw new ReservationContentionError();
    this.committed.push(input);
  }
}

function lockedCandidate(overrides: {
  numberId: string;
  basePriceIdr: number;
}): LockedReservationCandidate {
  const candidate: InventoryCandidate = {
    numberId: overrides.numberId,
    partnerStatus: "approved",
    device: {
      type: "simulator",
      status: "online",
      lastSeenAt: new Date(NOW),
      capabilities: SMS_CAPS,
    },
    number: {
      status: "available",
      enabled: true,
      countryCode: "ID",
      operatorCode: "any",
      hasActiveOrder: false,
    },
    offer: {
      serviceCode: "wa",
      countryCode: "ID",
      operatorCode: "any",
      basePriceIdr: overrides.basePriceIdr,
      status: "active",
    },
  };
  return {
    numberId: overrides.numberId,
    partnerId: `partner-${overrides.numberId}`,
    offerId: `offer-${overrides.numberId}`,
    canonicalNumber: `+62812${overrides.numberId}`,
    basePriceIdr: overrides.basePriceIdr,
    candidate,
  };
}

function baseCommand(
  overrides: Partial<ReserveCommandInput> = {},
): ReserveCommandInput {
  return {
    principalId: "main-client",
    idempotencyKey: "key-1",
    method: "POST",
    path: "/api/internal/v1/orders/reserve",
    request: {
      buyerOrderRef: "buyer-order-1",
      buyerAccountRef: "buyer-acct-1",
      filter: FILTER,
      quoteVersion: 1,
    },
    ...overrides,
  };
}

describe("ReservationService", () => {
  let gateway: FakeReservationGateway;
  let store: FakeStore;
  let service: ReservationService<Tx>;

  beforeEach(() => {
    gateway = new FakeReservationGateway();
    store = new FakeStore();
    service = new ReservationService<Tx>({
      idempotency: new IdempotencyEngine<Tx>({
        store,
        runner: new FakeRunner(),
        clock: new FakeClock(),
      }),
      gateway,
      clock: new FakeClock(),
      idGenerator: new FakeIdGenerator(),
    });
  });

  it("reserves and activates the number.id-ASC candidate atomically", async () => {
    gateway.candidates = [
      lockedCandidate({ numberId: "n-b", basePriceIdr: 2_000 }),
      lockedCandidate({ numberId: "n-a", basePriceIdr: 1_000 }),
    ];

    const result = await service.reserve(baseCommand());

    expect(result.statusCode).toBe(200);
    expect("data" in result.body).toBe(true);
    if (!("data" in result.body)) return;
    const { data } = result.body;
    expect(data.status).toBe("waiting_sms");
    // Deterministic selection picks n-a (base 1000 => retail 1400, payout 1000).
    expect(data.number).toBe("+62812n-a");
    expect(data.snapshot.retailPriceIdr).toBe(1_400);
    expect(data.snapshot.payoutIdr).toBe(1_000);
    expect(data.snapshot.configVersion).toBe(1);
    expect(data.expiresAt).toBe(new Date(NOW + 1_200 * 1000).toISOString());

    // Exactly one reservation was committed for the winning candidate.
    expect(gateway.committed).toHaveLength(1);
    const committed = gateway.committed[0];
    expect(committed?.numberId).toBe("n-a");
    expect(committed?.partnerId).toBe("partner-n-a");
    // The reserve/activation transition audit trail is derived from the domain
    // state machine and carries the internal-service principal as the actor
    // (requirements 12.1, 12.2, 12.7). The keys are deterministic per order and
    // distinct per step, so the recorded history rows are single per transition.
    const orderId = committed?.orderId ?? "";
    expect(committed?.actorRef).toBe("main-client");
    expect(committed?.reserveOperationKey).toBe(`order-transition:${orderId}:reserved`);
    expect(committed?.activationOperationKey).toBe(
      `order-transition:${orderId}:waiting_sms`,
    );
    expect(committed?.reserveOperationKey).not.toBe(committed?.activationOperationKey);
  });

  it("returns a deterministic stockout with no partial order when nothing is eligible", async () => {
    gateway.candidates = [];

    const result = await service.reserve(baseCommand());

    expect(result.statusCode).toBe(409);
    expect(result.body).toEqual({
      error: { code: "OUT_OF_STOCK", message: expect.any(String), retryable: false },
    });
    expect(gateway.committed).toHaveLength(0);
  });

  it("rejects a stale quote version before reserving", async () => {
    gateway.candidates = [lockedCandidate({ numberId: "n-a", basePriceIdr: 1_000 })];

    const result = await service.reserve(
      baseCommand({
        request: {
          buyerOrderRef: "buyer-order-1",
          buyerAccountRef: "buyer-acct-1",
          filter: FILTER,
          quoteVersion: 99,
        },
      }),
    );

    expect(result.statusCode).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe("QUOTE_EXPIRED");
    expect(gateway.committed).toHaveLength(0);
  });

  it("rejects a filter outside the configured catalog", async () => {
    const result = await service.reserve(
      baseCommand({
        request: {
          buyerOrderRef: "buyer-order-1",
          buyerAccountRef: "buyer-acct-1",
          filter: { serviceCode: "tg", countryCode: "ID", operatorCode: "any" },
          quoteVersion: 1,
        },
      }),
    );

    expect(result.statusCode).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe("CATALOG_UNAVAILABLE");
    expect(gateway.committed).toHaveLength(0);
  });

  it("requires an idempotency key for the mutation", async () => {
    gateway.candidates = [lockedCandidate({ numberId: "n-a", basePriceIdr: 1_000 })];

    const result = await service.reserve(baseCommand({ idempotencyKey: null }));

    expect(result.statusCode).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_REQUIRED");
    expect(gateway.committed).toHaveLength(0);
  });

  it("replays the first result for a retry with the same key and payload", async () => {
    gateway.candidates = [lockedCandidate({ numberId: "n-a", basePriceIdr: 1_000 })];

    const first = await service.reserve(baseCommand());
    const second = await service.reserve(baseCommand());

    expect(second).toEqual(first);
    // The effect ran exactly once despite the retry (exactly-once).
    expect(gateway.committed).toHaveLength(1);
  });

  it("rejects a reused key with a different payload as a conflict", async () => {
    gateway.candidates = [lockedCandidate({ numberId: "n-a", basePriceIdr: 1_000 })];

    await service.reserve(baseCommand());
    const conflict = await service.reserve(
      baseCommand({
        request: {
          buyerOrderRef: "different-order",
          buyerAccountRef: "buyer-acct-1",
          filter: FILTER,
          quoteVersion: 1,
        },
      }),
    );

    expect(conflict.statusCode).toBe(409);
    expect((conflict.body as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(gateway.committed).toHaveLength(1);
  });

  it("maps a duplicate buyer order reference to a deterministic conflict", async () => {
    gateway.candidates = [lockedCandidate({ numberId: "n-a", basePriceIdr: 1_000 })];
    gateway.duplicateRefs.add("buyer-order-1");

    const result = await service.reserve(baseCommand());

    expect(result.statusCode).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "BUYER_ORDER_REF_CONFLICT",
    );
  });

  it("surfaces a missing active config as a retryable dependency error", async () => {
    gateway.config = null;
    gateway.candidates = [lockedCandidate({ numberId: "n-a", basePriceIdr: 1_000 })];

    const result = await service.reserve(baseCommand());

    expect(result.statusCode).toBe(503);
    expect((result.body as { error: { code: string; retryable: boolean } }).error).toEqual({
      code: "DEPENDENCY_UNAVAILABLE",
      message: expect.any(String),
      retryable: true,
    });
    // Nothing was persisted, so a retry is safe.
    expect(store.rows.size).toBe(0);
  });

  it("rolls back and reports a retryable error on write contention", async () => {
    gateway.candidates = [lockedCandidate({ numberId: "n-a", basePriceIdr: 1_000 })];
    gateway.contention = true;

    const result = await service.reserve(baseCommand());

    expect(result.statusCode).toBe(503);
    expect((result.body as { error: { retryable: boolean } }).error.retryable).toBe(true);
    expect(store.rows.size).toBe(0);
  });
});
