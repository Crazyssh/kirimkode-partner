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
  type ApplyListeningHoldReleaseInput,
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
    completedAtEpochMs: null,
    numberCurrentOrderId: "11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
}

class FakeTransitionGateway implements OrderTransitionGateway<Tx> {
  config: OrderOperationsConfig | null = CONFIG;
  ctx: OrderTransitionContext | null = context();
  readonly applied: ApplyTerminalTransitionInput[] = [];
  readonly completions: ApplyListeningHoldReleaseInput[] = [];
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
  async applyListeningHoldRelease(_tx: Tx, input: ApplyListeningHoldReleaseInput): Promise<void> {
    if (this.contention) throw new TerminalTransitionContentionError();
    this.completions.push(input);
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

function completeInput(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "11111111-1111-4111-8111-111111111111",
    principalId: "main",
    idempotencyKey: "key-1",
    method: "POST",
    path: "/api/internal/v1/orders/x/complete",
    trigger: "buyer_complete",
    actorRef: "main-actor",
    ...overrides,
  } as Parameters<OrderTransitionService<Tx>["complete"]>[0];
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

  it("replays a retry with the same key even when the observed instant moves (cron re-run)", async () => {
    // The order-timeout cron keeps a constant Idempotency-Key per order but
    // re-observes `now` on every run. The observed instant must NOT be part of
    // the idempotency payload: a moving `observedAtEpochMs` under the same key
    // must replay the first terminal result, never poison the key with a
    // permanent IDEMPOTENCY_CONFLICT that would leave the order stuck forever.
    const first = await service.timeout(timeoutInput({ observedAtEpochMs: NOW }));
    const second = await service.timeout(
      timeoutInput({ observedAtEpochMs: NOW + 5 * MINUTE }),
    );

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // Verbatim replay of the first result, not a 409 conflict.
    expect(second).toEqual(first);
    // The terminal effect ran exactly once despite the moving observed instant.
    expect(gateway.applied).toHaveLength(1);
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

/**
 * Completion closes a successful order's listening window and releases its number
 * hold. The order stays `success` — the money settled when its first OTP arrived
 * — so completion moves none of it and writes no status edge.
 *
 * **Validates: Requirements 12.4, 12.5**
 */
describe("OrderTransitionService.complete", () => {
  let gateway: FakeTransitionGateway;
  let store: FakeStore;
  let service: OrderTransitionService<Tx>;

  /** A settled order still holding its number, with the window still open. */
  const listeningCtx = (overrides: Partial<OrderTransitionContext> = {}) =>
    context({
      orderStatus: "success",
      numberStatus: "busy",
      otpReceived: true,
      completedAtEpochMs: null,
      expiresAtEpochMs: NOW + 10 * MINUTE,
      ...overrides,
    });

  beforeEach(() => {
    gateway = new FakeTransitionGateway();
    gateway.ctx = listeningCtx();
    store = new FakeStore();
    service = makeService(gateway, store);
  });

  it("releases the hold on buyer completion, leaving the order successful", async () => {
    const result = await service.complete(completeInput());

    expect(result.statusCode).toBe(200);
    if (!("data" in result.body)) throw new Error("expected data");
    expect(result.body.data.status).toBe("success");
    expect(result.body.data.releaseDisposition).toBe("available");
    expect(result.body.data.completedAt).toBe(new Date(NOW).toISOString());

    // The number is released and the completion stamped; no terminal write at
    // all, so no status edge and nothing that could touch money.
    expect(gateway.completions).toHaveLength(1);
    expect(gateway.applied).toHaveLength(0);
    const completion = gateway.completions[0];
    expect(completion?.completedAtEpochMs).toBe(NOW);
    expect(completion?.fromNumberStatus).toBe("busy");
    expect(completion?.toNumberStatus).toBe("available");
    expect(completion?.numberChanged).toBe(true);
    expect(completion?.reason).toBe("buyer_complete");
  });

  it("parks the number offline when the device is no longer live", async () => {
    gateway.ctx = listeningCtx({ deviceStatus: "offline", deviceLastSeenAtEpochMs: null });
    const result = await service.complete(completeInput());
    if (!("data" in result.body)) throw new Error("expected data");
    expect(result.body.data.releaseDisposition).toBe("offline");
    expect(gateway.completions[0]?.toNumberStatus).toBe("offline");
  });

  it("is idempotent once the hold was already released, reporting the original instant", async () => {
    const releasedAt = NOW - MINUTE;
    gateway.ctx = listeningCtx({ completedAtEpochMs: releasedAt, numberStatus: "available" });

    const result = await service.complete(completeInput());

    expect(result.statusCode).toBe(200);
    if (!("data" in result.body)) throw new Error("expected data");
    // A late buyer request and the sweep must agree on one answer, so the stored
    // completion instant is reported rather than "now".
    expect(result.body.data.completedAt).toBe(new Date(releasedAt).toISOString());
    expect(result.body.data.releaseDisposition).toBeNull();
    expect(gateway.completions).toHaveLength(0);
  });

  it("refuses to complete an order that never succeeded", async () => {
    for (const orderStatus of ["waiting_sms", "cancelled", "timeout", "failed"] as const) {
      gateway = new FakeTransitionGateway();
      gateway.ctx = listeningCtx({ orderStatus });
      service = makeService(gateway, new FakeStore());

      const result = await service.complete(completeInput());

      expect(result.statusCode).toBe(409);
      expect((result.body as { error: { code: string } }).error.code).toBe("STATE_CONFLICT");
      expect(gateway.completions).toHaveLength(0);
    }
  });

  it("lets the sweep close only a window that has actually expired", async () => {
    // Still open: the sweep must not steal the buyer's remaining time.
    const early = await service.complete(
      completeInput({ trigger: "expiry_sweep", observedAtEpochMs: NOW, idempotencyKey: "sweep-1" }),
    );
    expect(early.statusCode).toBe(409);
    expect(gateway.completions).toHaveLength(0);

    // Past the deadline the sweep may close it.
    const late = await service.complete(
      completeInput({
        trigger: "expiry_sweep",
        observedAtEpochMs: NOW + 11 * MINUTE,
        idempotencyKey: "sweep-2",
      }),
    );
    expect(late.statusCode).toBe(200);
    if (!("data" in late.body)) throw new Error("expected data");
    expect(late.body.data.completedAt).toBe(new Date(NOW + 11 * MINUTE).toISOString());
    expect(gateway.completions).toHaveLength(1);
    expect(gateway.completions[0]?.reason).toBe("expiry_sweep");
  });

  it("completes without touching a number that already moved to another order", async () => {
    gateway.ctx = listeningCtx({ numberCurrentOrderId: "22222222-2222-4222-8222-222222222222" });

    const result = await service.complete(completeInput());

    expect(result.statusCode).toBe(200);
    if (!("data" in result.body)) throw new Error("expected data");
    expect(result.body.data.releaseDisposition).toBeNull();
    // The completion is still stamped, but a live holder is never stripped.
    expect(gateway.completions).toHaveLength(1);
    expect(gateway.completions[0]?.numberChanged).toBe(false);
  });

  it("returns not found for a missing order", async () => {
    gateway.ctx = null;
    const result = await service.complete(completeInput());
    expect(result.statusCode).toBe(404);
    expect(gateway.completions).toHaveLength(0);
  });

  it("requires an idempotency key", async () => {
    const result = await service.complete(completeInput({ idempotencyKey: null }));
    expect(result.statusCode).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_REQUIRED");
    expect(gateway.completions).toHaveLength(0);
  });

  it("replays the first result for a retry with the same key and payload", async () => {
    const first = await service.complete(completeInput());
    const second = await service.complete(completeInput());
    expect(second).toEqual(first);
    // Replayed, not re-applied: a number release can never happen twice.
    expect(gateway.completions).toHaveLength(1);
  });

  it("rejects a reused key with a different payload as a conflict", async () => {
    await service.complete(completeInput());
    const conflict = await service.complete(
      completeInput({ trigger: "expiry_sweep", observedAtEpochMs: NOW + 11 * MINUTE }),
    );
    expect(conflict.statusCode).toBe(409);
    expect((conflict.body as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("reports a retryable state conflict on write contention", async () => {
    gateway.contention = true;
    const result = await service.complete(completeInput());
    expect(result.statusCode).toBe(409);
    const body = result.body as { error: { code: string; retryable: boolean } };
    expect(body.error.retryable).toBe(true);
  });

  it("surfaces a missing active config as a retryable dependency error", async () => {
    gateway.config = null;
    const result = await service.complete(completeInput());
    expect(result.statusCode).toBe(503);
    const body = result.body as { error: { retryable: boolean } };
    expect(body.error.retryable).toBe(true);
  });
});
