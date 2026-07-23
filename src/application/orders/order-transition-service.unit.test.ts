import { beforeEach, describe, expect, it } from "vitest";

import {
  IdempotencyEngine,
  type IdempotencyRecordInsert,
  type IdempotencyRecordLookup,
  type IdempotencyRecordRow,
  type IdempotencyStore,
  type IdempotencyTransactionRunner,
} from "@application/internal-api";

import { OrderTransitionService } from "./order-transition-service";
import {
  TerminalTransitionContentionError,
  type ApplyTerminalTransitionInput,
  type OrderOperationsConfig,
  type OrderTransitionContext,
  type OrderTransitionGateway,
} from "./operations-ports";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

const CONFIG: OrderOperationsConfig = Object.freeze({
  heartbeatTimeoutSeconds: 90,
  cancelMinimumSeconds: 180,
});

type Tx = { readonly id: "tx" };
const TX: Tx = Object.freeze({ id: "tx" });

class FakeClock {
  constructor(public value = NOW) {}
  nowEpochMs(): number {
    return this.value;
  }
}

class FakeRunner implements IdempotencyTransactionRunner<Tx> {
  async run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return work(TX);
  }
}

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

function context(overrides: Partial<OrderTransitionContext> = {}): OrderTransitionContext {
  return {
    orderId: "11111111-1111-4111-8111-111111111111",
    partnerId: "partner-1",
    numberId: "number-1",
    version: 3,
    orderStatus: "waiting_sms",
    numberStatus: "busy",
    otpReceived: false,
    createdAtEpochMs: NOW - 5 * MINUTE,
    expiresAtEpochMs: NOW - MINUTE,
    numberEnabled: true,
    deviceStatus: "online",
    deviceLastSeenAtEpochMs: NOW,
    ...overrides,
  };
}

class FakeTransitionGateway implements OrderTransitionGateway<Tx> {
  config: OrderOperationsConfig | null = CONFIG;
  ctx: OrderTransitionContext | null = context();
  readonly applied: ApplyTerminalTransitionInput[] = [];
  contention = false;

  async loadActiveConfig(): Promise<OrderOperationsConfig | null> {
    return this.config;
  }
  async loadTransitionContext(): Promise<OrderTransitionContext | null> {
    return this.ctx;
  }
  async applyTerminalTransition(_tx: Tx, input: ApplyTerminalTransitionInput): Promise<void> {
    if (this.contention) throw new TerminalTransitionContentionError();
    this.applied.push(input);
  }
}

function makeService(gateway: FakeTransitionGateway, store: FakeStore, clock = new FakeClock()) {
  return new OrderTransitionService<Tx>({
    idempotency: new IdempotencyEngine<Tx>({ store, runner: new FakeRunner(), clock: new FakeClock() }),
    gateway,
    clock,
  });
}

function cancelInput(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "11111111-1111-4111-8111-111111111111",
    principalId: "main",
    idempotencyKey: "key-1",
    method: "POST",
    path: "/api/internal/v1/orders/x/cancel",
    reason: "buyer requested",
    actorRef: "main-actor",
    ...overrides,
  } as Parameters<OrderTransitionService<Tx>["cancel"]>[0];
}

function timeoutInput(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "11111111-1111-4111-8111-111111111111",
    principalId: "main",
    idempotencyKey: "key-1",
    method: "POST",
    path: "/api/internal/v1/orders/x/timeout",
    observedAtEpochMs: NOW,
    reason: "expired",
    ...overrides,
  } as Parameters<OrderTransitionService<Tx>["timeout"]>[0];
}

function failInput(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "11111111-1111-4111-8111-111111111111",
    principalId: "system",
    idempotencyKey: "key-1",
    method: "POST",
    path: "/internal/orders/x/fail",
    reason: "permanent_failure",
    actorRef: "recovery-job",
    ...overrides,
  } as Parameters<OrderTransitionService<Tx>["fail"]>[0];
}

describe("OrderTransitionService.cancel", () => {
  let gateway: FakeTransitionGateway;
  let store: FakeStore;
  let service: OrderTransitionService<Tx>;

  beforeEach(() => {
    gateway = new FakeTransitionGateway();
    store = new FakeStore();
    service = makeService(gateway, store);
  });

  it("cancels a waiting order past the minimum age and releases the number to available", async () => {
    const result = await service.cancel(cancelInput());
    expect(result.statusCode).toBe(200);
    if (!("data" in result.body)) throw new Error("expected data");
    expect(result.body.data.status).toBe("cancelled");
    expect(result.body.data.releaseDisposition).toBe("available");
    expect(gateway.applied).toHaveLength(1);
    expect(gateway.applied[0]?.toOrderStatus).toBe("cancelled");
    expect(gateway.applied[0]?.toNumberStatus).toBe("available");
  });

  it("releases the number to offline when the device is not live", async () => {
    gateway.ctx = context({ deviceStatus: "offline", deviceLastSeenAtEpochMs: null });
    const result = await service.cancel(cancelInput());
    if (!("data" in result.body)) throw new Error("expected data");
    expect(result.body.data.releaseDisposition).toBe("offline");
    expect(gateway.applied[0]?.toNumberStatus).toBe("offline");
  });

  it("rejects a cancel before the minimum age", async () => {
    gateway.ctx = context({ createdAtEpochMs: NOW - MINUTE });
    const result = await service.cancel(cancelInput());
    expect(result.statusCode).toBe(422);
    expect((result.body as { error: { code: string } }).error.code).toBe("CANCEL_NOT_ALLOWED");
    expect(gateway.applied).toHaveLength(0);
  });

  it("allows an immediate MAIN_COMPENSATION cancel on a still-reserved order", async () => {
    gateway.ctx = context({
      orderStatus: "reserved",
      numberStatus: "reserved",
      createdAtEpochMs: NOW,
    });
    const result = await service.cancel(cancelInput({ reason: "MAIN_COMPENSATION" }));
    expect(result.statusCode).toBe(200);
    if (!("data" in result.body)) throw new Error("expected data");
    expect(result.body.data.status).toBe("cancelled");
    expect(gateway.applied).toHaveLength(1);
  });

  it("refuses to cancel once an OTP has been received", async () => {
    gateway.ctx = context({ otpReceived: true });
    const result = await service.cancel(cancelInput());
    expect(result.statusCode).toBe(422);
    expect((result.body as { error: { code: string } }).error.code).toBe("CANCEL_NOT_ALLOWED");
    expect(gateway.applied).toHaveLength(0);
  });

  it("rejects a differing terminal transition on an already-terminal order", async () => {
    gateway.ctx = context({ orderStatus: "timeout", numberStatus: "available" });
    const result = await service.cancel(cancelInput());
    expect(result.statusCode).toBe(422);
    expect((result.body as { error: { code: string } }).error.code).toBe("TERMINAL_STATE_CONFLICT");
    expect(gateway.applied).toHaveLength(0);
  });

  it("returns not found for a missing order", async () => {
    gateway.ctx = null;
    const result = await service.cancel(cancelInput());
    expect(result.statusCode).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("requires an idempotency key", async () => {
    const result = await service.cancel(cancelInput({ idempotencyKey: null }));
    expect(result.statusCode).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_REQUIRED");
    expect(gateway.applied).toHaveLength(0);
  });

  it("replays the first result for a retry with the same key and payload", async () => {
    const first = await service.cancel(cancelInput());
    const second = await service.cancel(cancelInput());
    expect(second).toEqual(first);
    // The terminal effect ran exactly once despite the retry.
    expect(gateway.applied).toHaveLength(1);
  });

  it("rejects a reused key with a different payload as a conflict", async () => {
    await service.cancel(cancelInput());
    const conflict = await service.cancel(cancelInput({ reason: "different" }));
    expect(conflict.statusCode).toBe(409);
    expect((conflict.body as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(gateway.applied).toHaveLength(1);
  });

  it("reports a retryable state conflict on write contention", async () => {
    gateway.contention = true;
    const result = await service.cancel(cancelInput());
    expect(result.statusCode).toBe(409);
    expect((result.body as { error: { code: string; retryable: boolean } }).error).toEqual({
      code: "STATE_CONFLICT",
      message: expect.any(String),
      retryable: true,
    });
    expect(store.rows.size).toBe(0);
  });

  it("surfaces a missing active config as a retryable dependency error", async () => {
    gateway.config = null;
    const result = await service.cancel(cancelInput());
    expect(result.statusCode).toBe(503);
    expect((result.body as { error: { retryable: boolean } }).error.retryable).toBe(true);
    expect(store.rows.size).toBe(0);
  });
});

describe("OrderTransitionService.timeout", () => {
  let gateway: FakeTransitionGateway;
  let store: FakeStore;
  let service: OrderTransitionService<Tx>;

  beforeEach(() => {
    gateway = new FakeTransitionGateway();
    store = new FakeStore();
    service = makeService(gateway, store);
  });

  it("times out a waiting order once the observed instant reaches expiry", async () => {
    const result = await service.timeout(timeoutInput());
    expect(result.statusCode).toBe(200);
    if (!("data" in result.body)) throw new Error("expected data");
    expect(result.body.data.status).toBe("timeout");
    expect(result.body.data.releaseDisposition).toBe("available");
    expect(gateway.applied).toHaveLength(1);
    expect(gateway.applied[0]?.toOrderStatus).toBe("timeout");
  });

  it("rejects a timeout before the order has expired", async () => {
    gateway.ctx = context({ expiresAtEpochMs: NOW + MINUTE });
    const result = await service.timeout(timeoutInput({ observedAtEpochMs: NOW }));
    expect(result.statusCode).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe("STATE_CONFLICT");
    expect(gateway.applied).toHaveLength(0);
  });

  it("is idempotent when the order is already timed out", async () => {
    gateway.ctx = context({ orderStatus: "timeout", numberStatus: "available" });
    const result = await service.timeout(timeoutInput());
    expect(result.statusCode).toBe(200);
    if (!("data" in result.body)) throw new Error("expected data");
    expect(result.body.data.status).toBe("timeout");
    // No write: the order was already terminal at the requested state.
    expect(gateway.applied).toHaveLength(0);
  });
});

describe("OrderTransitionService.fail", () => {
  let gateway: FakeTransitionGateway;
  let store: FakeStore;
  let service: OrderTransitionService<Tx>;

  beforeEach(() => {
    gateway = new FakeTransitionGateway();
    store = new FakeStore();
    service = makeService(gateway, store);
  });

  it("fails a waiting order and releases the busy number to available", async () => {
    const result = await service.fail(failInput());
    expect(result.statusCode).toBe(200);
    if (!("data" in result.body)) throw new Error("expected data");
    expect(result.body.data.status).toBe("failed");
    expect(result.body.data.releaseDisposition).toBe("available");
    expect(gateway.applied).toHaveLength(1);
    expect(gateway.applied[0]?.fromOrderStatus).toBe("waiting_sms");
    expect(gateway.applied[0]?.toOrderStatus).toBe("failed");
    expect(gateway.applied[0]?.toNumberStatus).toBe("available");
  });

  it("releases the number to offline when the device is not live", async () => {
    gateway.ctx = context({ deviceStatus: "offline", deviceLastSeenAtEpochMs: null });
    const result = await service.fail(failInput());
    if (!("data" in result.body)) throw new Error("expected data");
    expect(result.body.data.releaseDisposition).toBe("offline");
    expect(gateway.applied[0]?.toNumberStatus).toBe("offline");
  });

  it("fails a created order without releasing a number", async () => {
    gateway.ctx = context({ orderStatus: "created", numberStatus: "available" });
    const result = await service.fail(failInput());
    expect(result.statusCode).toBe(200);
    if (!("data" in result.body)) throw new Error("expected data");
    expect(result.body.data.status).toBe("failed");
    expect(result.body.data.releaseDisposition).toBeNull();
    expect(gateway.applied).toHaveLength(1);
    expect(gateway.applied[0]?.fromOrderStatus).toBe("created");
    expect(gateway.applied[0]?.numberChanged).toBe(false);
  });

  it("refuses to fail an order that already succeeded", async () => {
    gateway.ctx = context({ orderStatus: "success", numberStatus: "available", otpReceived: true });
    const result = await service.fail(failInput());
    expect(result.statusCode).toBe(422);
    expect((result.body as { error: { code: string } }).error.code).toBe("TERMINAL_STATE_CONFLICT");
    expect(gateway.applied).toHaveLength(0);
  });

  it("is idempotent when the order is already failed", async () => {
    gateway.ctx = context({ orderStatus: "failed", numberStatus: "offline" });
    const result = await service.fail(failInput());
    expect(result.statusCode).toBe(200);
    if (!("data" in result.body)) throw new Error("expected data");
    expect(result.body.data.status).toBe("failed");
    expect(gateway.applied).toHaveLength(0);
  });

  it("replays the first result for a retry with the same key and payload", async () => {
    const first = await service.fail(failInput());
    const second = await service.fail(failInput());
    expect(second).toEqual(first);
    expect(gateway.applied).toHaveLength(1);
  });
});
