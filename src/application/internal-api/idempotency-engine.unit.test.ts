import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonValue } from "@domain/task-5-3/canonical-request-hash";

import {
  FINANCIAL_RETENTION_MS,
  IdempotencyEngine,
  OPERATIONAL_RETENTION_MS,
  type IdempotentEffectResult,
} from "./idempotency-engine";
import type {
  IdempotencyRecordInsert,
  IdempotencyRecordLookup,
  IdempotencyRecordRow,
  IdempotencyStore,
  IdempotencyTransactionRunner,
} from "./ports";

// A trivial transaction handle: the fake store ignores it, but it exercises the
// same threading the Prisma runner performs (effect + store share one `tx`).
type FakeTx = { readonly id: "tx" };
const TX: FakeTx = { id: "tx" };

const NOW_MS = 1_700_000_000_000;

class FakeClock {
  constructor(public epochMs: number) {}
  nowEpochMs(): number {
    return this.epochMs;
  }
}

/**
 * In-memory idempotency store keyed on `(scope, principalId, key)`. It mimics
 * the unique-constraint behaviour of the real table: a second insert for the
 * same key reports `{ inserted: false }`.
 */
class FakeStore implements IdempotencyStore<FakeTx> {
  readonly rows = new Map<string, IdempotencyRecordRow & { expiresAtEpochMs: number }>();
  findCalls = 0;
  insertCalls = 0;
  /** When set, the next insert simulates a concurrent winner committing first. */
  concurrentWinner: (IdempotencyRecordRow & { expiresAtEpochMs: number }) | null = null;

  private static id(lookup: IdempotencyRecordLookup): string {
    return `${lookup.scope}|${lookup.principalId}|${lookup.key}`;
  }

  async find(_tx: FakeTx, lookup: IdempotencyRecordLookup): Promise<IdempotencyRecordRow | null> {
    this.findCalls += 1;
    return this.rows.get(FakeStore.id(lookup)) ?? null;
  }

  async insert(
    _tx: FakeTx,
    record: IdempotencyRecordInsert,
  ): Promise<{ readonly inserted: boolean }> {
    this.insertCalls += 1;
    const id = FakeStore.id(record);
    if (this.concurrentWinner !== null) {
      // Race: a concurrent request already committed this key. Persist its row
      // so the engine's follow-up read finds it, then report the lost race.
      this.rows.set(id, this.concurrentWinner);
      this.concurrentWinner = null;
      return { inserted: false };
    }
    if (this.rows.has(id)) return { inserted: false };
    this.rows.set(id, {
      scope: record.scope,
      principalId: record.principalId,
      key: record.key,
      requestHash: record.requestHash,
      responseStatus: record.responseStatus,
      responseJson: record.responseJson,
      expiresAtEpochMs: record.expiresAtEpochMs,
    });
    return { inserted: true };
  }
}

class FakeRunner implements IdempotencyTransactionRunner<FakeTx> {
  runs = 0;
  async run<T>(work: (tx: FakeTx) => Promise<T>): Promise<T> {
    this.runs += 1;
    return work(TX);
  }
}

interface Harness {
  readonly engine: IdempotencyEngine<FakeTx>;
  readonly store: FakeStore;
  readonly runner: FakeRunner;
  readonly clock: FakeClock;
}

function makeHarness(): Harness {
  const store = new FakeStore();
  const runner = new FakeRunner();
  const clock = new FakeClock(NOW_MS);
  const engine = new IdempotencyEngine<FakeTx>({ store, runner, clock });
  return { engine, store, runner, clock };
}

const BASE = {
  scope: "orders.reserve",
  principalId: "kirimkode-main",
  method: "POST",
  path: "/api/internal/v1/orders/reserve",
  payload: { buyerOrderRef: "buyer-1", offerId: "offer-1" } as JsonValue,
  retention: "financial" as const,
};

function effectReturning(
  result: IdempotentEffectResult<JsonValue>,
  spy?: () => void,
): (tx: FakeTx) => Promise<IdempotentEffectResult<JsonValue>> {
  return async () => {
    spy?.();
    return result;
  };
}

// **Validates: Requirements 9.6, 10.3, 10.4, 10.5, 10.7, 20.4, 20.5**
describe("IdempotencyEngine", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it("executes the effect once and persists the record atomically (first call)", async () => {
    const effect = vi.fn(effectReturning({ statusCode: 201, response: { orderId: "o-1" } }));
    const outcome = await h.engine.runIdempotent({ ...BASE, idempotencyKey: "k1", effect });

    expect(outcome).toEqual({ kind: "executed", statusCode: 201, response: { orderId: "o-1" } });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(h.store.insertCalls).toBe(1);
    expect(h.store.rows.size).toBe(1);
  });

  it("replays the first response on a retry with the same key and payload without re-running the effect", async () => {
    const effect = vi.fn(effectReturning({ statusCode: 201, response: { orderId: "o-1" } }));
    await h.engine.runIdempotent({ ...BASE, idempotencyKey: "k1", effect });

    const retry = vi.fn(effectReturning({ statusCode: 500, response: { should: "not-run" } }));
    const outcome = await h.engine.runIdempotent({ ...BASE, idempotencyKey: "k1", effect: retry });

    expect(outcome).toEqual({ kind: "replayed", statusCode: 201, response: { orderId: "o-1" } });
    expect(retry).not.toHaveBeenCalled();
    expect(h.store.rows.size).toBe(1);
  });

  it("rejects a reused key with a different payload as IDEMPOTENCY_CONFLICT and never re-runs the effect", async () => {
    await h.engine.runIdempotent({
      ...BASE,
      idempotencyKey: "k1",
      effect: effectReturning({ statusCode: 201, response: { orderId: "o-1" } }),
    });

    const conflicting = vi.fn(effectReturning({ statusCode: 201, response: { orderId: "o-2" } }));
    const outcome = await h.engine.runIdempotent({
      ...BASE,
      idempotencyKey: "k1",
      payload: { buyerOrderRef: "buyer-1", offerId: "DIFFERENT" },
      effect: conflicting,
    });

    expect(outcome).toEqual({ kind: "rejected", code: "IDEMPOTENCY_CONFLICT" });
    expect(conflicting).not.toHaveBeenCalled();
  });

  it("treats a payload with reordered keys as the same request (canonical hashing)", async () => {
    await h.engine.runIdempotent({
      ...BASE,
      idempotencyKey: "k1",
      payload: { a: 1, b: 2 },
      effect: effectReturning({ statusCode: 200, response: { ok: true } }),
    });

    const retry = vi.fn(effectReturning({ statusCode: 200, response: { ok: true } }));
    const outcome = await h.engine.runIdempotent({
      ...BASE,
      idempotencyKey: "k1",
      payload: { b: 2, a: 1 },
      effect: retry,
    });

    expect(outcome.kind).toBe("replayed");
    expect(retry).not.toHaveBeenCalled();
  });

  it("rejects a missing or blank idempotency key as IDEMPOTENCY_REQUIRED before opening a transaction", async () => {
    const effect = vi.fn(effectReturning({ statusCode: 200, response: {} }));
    for (const idempotencyKey of [null, undefined, "", "   "]) {
      const outcome = await h.engine.runIdempotent({ ...BASE, idempotencyKey, effect });
      expect(outcome).toEqual({ kind: "rejected", code: "IDEMPOTENCY_REQUIRED" });
    }
    expect(effect).not.toHaveBeenCalled();
    expect(h.runner.runs).toBe(0);
  });

  it("rejects an over-long idempotency key as IDEMPOTENCY_REQUIRED", async () => {
    const outcome = await h.engine.runIdempotent({
      ...BASE,
      idempotencyKey: "x".repeat(256),
      effect: effectReturning({ statusCode: 200, response: {} }),
    });
    expect(outcome).toEqual({ kind: "rejected", code: "IDEMPOTENCY_REQUIRED" });
  });

  it("persists business-failure envelopes so a retry replays the deterministic result (req 9.6)", async () => {
    const stockout: IdempotentEffectResult<JsonValue> = {
      statusCode: 409,
      response: { error: { code: "OUT_OF_STOCK", message: "No eligible inventory.", retryable: false } },
    };
    const first = await h.engine.runIdempotent({
      ...BASE,
      idempotencyKey: "k1",
      effect: effectReturning(stockout),
    });
    expect(first).toEqual({ kind: "executed", ...stockout });

    const retry = vi.fn(effectReturning({ statusCode: 201, response: { orderId: "o-1" } }));
    const replayed = await h.engine.runIdempotent({ ...BASE, idempotencyKey: "k1", effect: retry });
    expect(replayed).toEqual({ kind: "replayed", statusCode: 409, response: stockout.response });
    expect(retry).not.toHaveBeenCalled();
  });

  it("does not persist a record when the effect throws (transient failure stays retryable)", async () => {
    const boom = vi.fn(async (): Promise<IdempotentEffectResult<JsonValue>> => {
      throw new Error("db unavailable");
    });
    await expect(
      h.engine.runIdempotent({ ...BASE, idempotencyKey: "k1", effect: boom }),
    ).rejects.toThrow("db unavailable");
    expect(h.store.rows.size).toBe(0);

    // A subsequent retry with the same key executes cleanly (nothing persisted).
    const retry = vi.fn(effectReturning({ statusCode: 201, response: { orderId: "o-1" } }));
    const outcome = await h.engine.runIdempotent({ ...BASE, idempotencyKey: "k1", effect: retry });
    expect(outcome.kind).toBe("executed");
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("replays the winner's record when a concurrent insert loses the unique-constraint race", async () => {
    // Arrange: the next insert will lose to a concurrent winner whose committed
    // record we seed here.
    h.store.concurrentWinner = {
      scope: BASE.scope,
      principalId: BASE.principalId,
      key: "k1",
      // The winner signed the same canonical request, so hashes match on replay.
      requestHash: await computeHash({ ...BASE, idempotencyKey: "k1" }),
      responseStatus: 201,
      responseJson: { orderId: "winner" },
      expiresAtEpochMs: NOW_MS + FINANCIAL_RETENTION_MS,
    };

    const loser = vi.fn(effectReturning({ statusCode: 201, response: { orderId: "loser" } }));
    const outcome = await h.engine.runIdempotent({ ...BASE, idempotencyKey: "k1", effect: loser });

    expect(outcome).toEqual({ kind: "replayed", statusCode: 201, response: { orderId: "winner" } });
    expect(loser).toHaveBeenCalledTimes(1); // the effect ran, but its writes rolled back
  });

  it("applies the financial retention window (7 years) to the persisted record", async () => {
    await h.engine.runIdempotent({
      ...BASE,
      retention: "financial",
      idempotencyKey: "k1",
      effect: effectReturning({ statusCode: 201, response: {} }),
    });
    const row = [...h.store.rows.values()][0];
    expect(row.expiresAtEpochMs).toBe(NOW_MS + FINANCIAL_RETENTION_MS);
  });

  it("applies the operational retention window (90 days) to the persisted record", async () => {
    await h.engine.runIdempotent({
      ...BASE,
      scope: "orders.cancel",
      retention: "operational",
      idempotencyKey: "k1",
      effect: effectReturning({ statusCode: 200, response: {} }),
    });
    const row = [...h.store.rows.values()][0];
    expect(row.expiresAtEpochMs).toBe(NOW_MS + OPERATIONAL_RETENTION_MS);
  });

  it("scopes records so the same key under a different scope executes independently", async () => {
    await h.engine.runIdempotent({
      ...BASE,
      scope: "orders.reserve",
      idempotencyKey: "shared",
      effect: effectReturning({ statusCode: 201, response: { a: 1 } }),
    });
    const other = vi.fn(effectReturning({ statusCode: 200, response: { b: 2 } }));
    const outcome = await h.engine.runIdempotent({
      ...BASE,
      scope: "orders.cancel",
      retention: "operational",
      idempotencyKey: "shared",
      effect: other,
    });
    expect(outcome.kind).toBe("executed");
    expect(other).toHaveBeenCalledTimes(1);
    expect(h.store.rows.size).toBe(2);
  });
});

/** Recompute the canonical request hash the engine will produce, for the race test. */
async function computeHash(input: {
  scope: string;
  principalId: string;
  idempotencyKey: string;
  method: string;
  path: string;
  payload: JsonValue;
}): Promise<string> {
  const { hashCanonicalRequest } = await import("@domain/task-5-3/canonical-request-hash");
  return hashCanonicalRequest({
    scope: input.scope,
    principalId: input.principalId,
    idempotencyKey: input.idempotencyKey,
    method: input.method,
    path: input.path,
    payload: input.payload,
  });
}
