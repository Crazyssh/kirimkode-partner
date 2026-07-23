import { beforeEach, describe, expect, it } from "vitest";

import {
  IdempotencyEngine,
  type IdempotencyRecordInsert,
  type IdempotencyRecordLookup,
  type IdempotencyRecordRow,
  type IdempotencyStore,
  type IdempotencyTransactionRunner,
} from "@application/internal-api";

import {
  OrderReconciliationService,
  RECONCILIATION_MAX_ITEMS,
  type ReconciliationItemRequest,
} from "./order-reconciliation-service";
import type {
  OrderReconciliationGateway,
  ReconciliationStatusEntry,
} from "./operations-ports";

type Tx = { readonly id: "tx" };
const TX: Tx = Object.freeze({ id: "tx" });

class FakeClock {
  nowEpochMs(): number {
    return 1_700_000_000_000;
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

class FakeReconciliationGateway implements OrderReconciliationGateway<Tx> {
  entries: ReconciliationStatusEntry[] = [];
  calls = 0;
  lastRefs: readonly string[] = [];

  async loadOrderStatuses(
    _tx: Tx,
    refs: readonly string[],
  ): Promise<readonly ReconciliationStatusEntry[]> {
    this.calls += 1;
    this.lastRefs = refs;
    return this.entries;
  }
}

function makeService(gateway: FakeReconciliationGateway, store: FakeStore) {
  return new OrderReconciliationService<Tx>({
    idempotency: new IdempotencyEngine<Tx>({
      store,
      runner: new FakeRunner(),
      clock: new FakeClock(),
    }),
    gateway,
  });
}

function input(
  items: readonly ReconciliationItemRequest[],
  overrides: Record<string, unknown> = {},
) {
  return {
    principalId: "main",
    idempotencyKey: "recon-key-1",
    method: "POST",
    path: "/api/internal/v1/reconciliation/orders",
    items,
    ...overrides,
  };
}

describe("OrderReconciliationService", () => {
  let gateway: FakeReconciliationGateway;
  let store: FakeStore;
  let service: OrderReconciliationService<Tx>;

  beforeEach(() => {
    gateway = new FakeReconciliationGateway();
    store = new FakeStore();
    service = makeService(gateway, store);
  });

  it("reports authoritative status per item in request order", async () => {
    gateway.entries = [
      { ref: "a", found: true, status: "success", terminalReason: null },
      { ref: "b", found: true, status: "cancelled", terminalReason: "MAIN_COMPENSATION" },
      { ref: "c", found: false, status: null, terminalReason: null },
    ];
    const result = await service.reconcile(
      input([
        { ref: "a", status: "success" },
        { ref: "b", status: "waiting_sms" },
        { ref: "c", status: "waiting_sms" },
      ]),
    );

    expect(result.statusCode).toBe(200);
    if (!("data" in result.body)) throw new Error("expected data");
    const { items } = result.body.data;
    expect(items.map((item) => item.ref)).toEqual(["a", "b", "c"]);
    // 'a' matches Main's claimed status; 'b' diverges; 'c' is unknown to Partner.
    expect(items[0]).toMatchObject({ found: true, partnerStatus: "success", matches: true });
    expect(items[1]).toMatchObject({ found: true, partnerStatus: "cancelled", matches: false });
    expect(items[2]).toMatchObject({ found: false, partnerStatus: null, matches: false });
  });

  it("rejects an empty batch as a validation error without touching the gateway", async () => {
    const result = await service.reconcile(input([]));
    expect(result.statusCode).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
    expect(gateway.calls).toBe(0);
  });

  it("rejects a batch larger than the cap without touching the gateway", async () => {
    const items = Array.from({ length: RECONCILIATION_MAX_ITEMS + 1 }, (_, i) => ({
      ref: `ref-${i}`,
      status: "waiting_sms",
    }));
    const result = await service.reconcile(input(items));
    expect(result.statusCode).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
    expect(gateway.calls).toBe(0);
  });

  it("accepts a batch exactly at the cap", async () => {
    const items = Array.from({ length: RECONCILIATION_MAX_ITEMS }, (_, i) => ({
      ref: `ref-${i}`,
      status: "waiting_sms",
    }));
    gateway.entries = [];
    const result = await service.reconcile(input(items));
    expect(result.statusCode).toBe(200);
    expect(gateway.calls).toBe(1);
    expect(gateway.lastRefs).toHaveLength(RECONCILIATION_MAX_ITEMS);
  });

  it("requires an idempotency key", async () => {
    const result = await service.reconcile(
      input([{ ref: "a", status: "success" }], { idempotencyKey: null }),
    );
    expect(result.statusCode).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_REQUIRED");
    expect(gateway.calls).toBe(0);
  });

  it("replays the first snapshot for a retry with the same key and payload", async () => {
    gateway.entries = [{ ref: "a", found: true, status: "success", terminalReason: null }];
    const first = await service.reconcile(input([{ ref: "a", status: "success" }]));
    const second = await service.reconcile(input([{ ref: "a", status: "success" }]));
    expect(second).toEqual(first);
    // The lookup ran exactly once despite the retry.
    expect(gateway.calls).toBe(1);
  });

  it("rejects a reused key with a different payload as a conflict", async () => {
    gateway.entries = [{ ref: "a", found: true, status: "success", terminalReason: null }];
    await service.reconcile(input([{ ref: "a", status: "success" }]));
    const conflict = await service.reconcile(input([{ ref: "a", status: "waiting_sms" }]));
    expect(conflict.statusCode).toBe(409);
    expect((conflict.body as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(gateway.calls).toBe(1);
  });
});
