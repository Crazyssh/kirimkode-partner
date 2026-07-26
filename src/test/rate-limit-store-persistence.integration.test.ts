import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthRateLimiter } from "@application/auth/auth-rate-limiter";
import { LOGIN_RATE_LIMIT } from "@application/auth/auth-config";
import { type BatchContext } from "@application/cron";
import { RetentionRedactionJob } from "@application/cron-jobs";

import { emptyWindowCounter, registerEvent, type WindowRule } from "@domain/task-7-2";

import {
  createPartnerDatabaseClient,
  PrismaRateLimitStore,
  PrismaRetentionGateway,
  type PartnerDatabaseClient,
} from "@infrastructure/database";

import {
  createDisposableTestDatabase,
  type DisposableTestDatabase,
} from "./disposable-database";

/**
 * Shared rate-limit store persistence integration tests (requirement 2.7).
 *
 * Every limiter in the app used to count into a process-local `Map`, so each
 * Node process — and each restart — owned a private window. Under more than one
 * instance the effective limit was multiplied by the process count, and a deploy
 * reset every counter to zero: brute-force and abuse limits were not actually
 * enforced. These tests wire the *production*
 * {@link PrismaRateLimitStore} against a disposable PostgreSQL database — no
 * in-memory fakes — and pin the four properties the fix depends on:
 *
 *  - two SEPARATE store instances on separate Prisma clients (standing in for two
 *    processes) count into ONE window;
 *  - a row past its `expiresAt` counts for nothing and a fresh window replaces it
 *    rather than inheriting its count;
 *  - N concurrent increments land as exactly N — the property a read-then-write
 *    adapter cannot hold, and the reason `set` is a single atomic upsert whose
 *    new count is derived from the committed row;
 *  - the `retention-redaction` sweep deletes closed windows and leaves live ones
 *    counting.
 *
 * The unit suite cannot catch any of this: a fake store is a `Map` in one
 * process, which is precisely the thing being replaced.
 */
const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const adminUrl = process.env.PARTNER_TEST_DATABASE_ADMIN_URL ?? "";
const hasPostgres = adminUrl.length > 0;

/** Deterministic anchor so every window boundary below is exact. */
const BASE_EPOCH_MS = Date.UTC(2026, 6, 26, 12, 0, 0);
const MINUTE_MS = 60 * 1000;

/** A test-controllable clock satisfying the application `Clock` port. */
class MutableClock {
  private current: number;

  constructor(startEpochMs: number) {
    this.current = startEpochMs;
  }

  nowEpochMs(): number {
    return this.current;
  }

  set(epochMs: number): void {
    this.current = epochMs;
  }
}

async function deployFromEmpty(connectionString: string): Promise<void> {
  await execFileAsync(process.execPath, ["scripts/migrate-from-empty.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, PARTNER_MIGRATION_DATABASE_URL: connectionString },
    maxBuffer: 10 * 1024 * 1024,
  });
}

interface CounterRow {
  readonly key: string;
  readonly count: number;
  readonly windowStart: Date;
  readonly blockedUntil: Date | null;
  readonly expiresAt: Date;
}

/** Read a counter row straight from SQL, bypassing the adapter's expiry filter. */
async function readRow(
  client: PartnerDatabaseClient,
  key: string,
): Promise<CounterRow | undefined> {
  const rows = await client.$queryRaw<CounterRow[]>`
    SELECT "key", "count", "windowStart", "blockedUntil", "expiresAt"
    FROM rate_limit_counters
    WHERE "key" = ${key}
  `;
  return rows[0];
}

async function insertRow(
  client: PartnerDatabaseClient,
  row: {
    key: string;
    count: number;
    windowStartEpochMs: number;
    expiresAtEpochMs: number;
  },
): Promise<void> {
  await client.$executeRaw`
    INSERT INTO rate_limit_counters ("key", "count", "windowStart", "blockedUntil", "expiresAt", "updatedAt")
    VALUES (
      ${row.key},
      ${row.count},
      ${new Date(row.windowStartEpochMs)},
      NULL,
      ${new Date(row.expiresAtEpochMs)},
      ${new Date(row.windowStartEpochMs)}
    )
  `;
}

// ---------------------------------------------------------------------------
describe.runIf(hasPostgres)("Shared rate-limit store persistence", () => {
  let database: DisposableTestDatabase;
  let client: PartnerDatabaseClient;
  /** A SECOND client + store: the stand-in for a second Node process. */
  let otherClient: PartnerDatabaseClient;
  let clock: MutableClock;
  let store: PrismaRateLimitStore;
  let otherStore: PrismaRateLimitStore;

  beforeAll(async () => {
    database = await createDisposableTestDatabase(adminUrl);
    await deployFromEmpty(database.connectionString);
    client = createPartnerDatabaseClient({ databaseUrl: database.connectionString });
    otherClient = createPartnerDatabaseClient({ databaseUrl: database.connectionString });
    await Promise.all([client.$connect(), otherClient.$connect()]);
    clock = new MutableClock(BASE_EPOCH_MS);
    store = new PrismaRateLimitStore(client, () => clock.nowEpochMs());
    otherStore = new PrismaRateLimitStore(otherClient, () => clock.nowEpochMs());
  }, 120_000);

  afterAll(async () => {
    await client?.$disconnect();
    await otherClient?.$disconnect();
    await database?.dispose();
  }, 30_000);

  const RULE: WindowRule = Object.freeze({ limit: 5, windowMs: 15 * MINUTE_MS });

  /** Count one event the way the application layer does: read, decide, write. */
  async function countOne(target: PrismaRateLimitStore, key: string): Promise<void> {
    const current = (await target.get(key)) ?? emptyWindowCounter();
    const next = registerEvent(current, RULE, clock.nowEpochMs());
    await target.set(key, next, next.windowStartEpochMs + RULE.windowMs);
  }

  // (a) Two processes must share one window — the whole point of the change.
  it("counts two separate store instances into one shared window", async () => {
    const key = "login:shared@example.test";

    await countOne(store, key);
    // The second instance must SEE the first instance's event, not start fresh.
    expect((await otherStore.get(key))?.count).toBe(1);

    await countOne(otherStore, key);
    await countOne(store, key);

    // Three events across two instances land in one counter, and both instances
    // read the same total — under the old in-memory store each would have read 1.
    expect((await store.get(key))?.count).toBe(3);
    expect((await otherStore.get(key))?.count).toBe(3);

    const row = await readRow(client, key);
    expect(row?.count).toBe(3);
    // The window identity is the FIRST event's start: a later writer must never
    // silently restart a window another process is still counting into.
    expect(row?.windowStart.getTime()).toBe(BASE_EPOCH_MS);
  });

  // (b) A closed window must count for nothing and be replaced, not inherited.
  it("ignores an expired row and replaces it instead of inheriting its count", async () => {
    const key = "login:expired@example.test";
    await insertRow(client, {
      key,
      count: 4,
      windowStartEpochMs: BASE_EPOCH_MS - 20 * MINUTE_MS,
      expiresAtEpochMs: BASE_EPOCH_MS - MINUTE_MS,
    });

    // Already past its expiry: indistinguishable from absent to every caller.
    expect(await store.get(key)).toBeUndefined();
    expect(await otherStore.get(key)).toBeUndefined();

    await countOne(store, key);

    // The fresh window starts at 1 — NOT 5 — so a long-idle key cannot arrive
    // pre-loaded at the limit and lock out a legitimate user.
    const row = await readRow(client, key);
    expect(row?.count).toBe(1);
    expect(row?.windowStart.getTime()).toBe(BASE_EPOCH_MS);
    expect(row?.expiresAt.getTime()).toBe(BASE_EPOCH_MS + RULE.windowMs);
  });

  it("keeps a live window's start while the clock advances inside it", async () => {
    const key = "login:rolling@example.test";
    await countOne(store, key);

    // Still inside the window: the event joins it rather than opening a new one.
    clock.set(BASE_EPOCH_MS + MINUTE_MS);
    await countOne(otherStore, key);
    let row = await readRow(client, key);
    expect(row?.count).toBe(2);
    expect(row?.windowStart.getTime()).toBe(BASE_EPOCH_MS);

    // One millisecond past the window the row is dead, so the next event opens a
    // brand-new window — the same boundary the domain's own reset uses.
    clock.set(BASE_EPOCH_MS + RULE.windowMs + 1);
    expect(await store.get(key)).toBeUndefined();
    await countOne(store, key);
    row = await readRow(client, key);
    expect(row?.count).toBe(1);
    expect(row?.windowStart.getTime()).toBe(BASE_EPOCH_MS + RULE.windowMs + 1);

    clock.set(BASE_EPOCH_MS);
  });

  // (c) The linchpin: a read-then-write adapter loses counts here.
  it("loses no count under concurrent increments", async () => {
    const key = "login:concurrent@example.test";
    const CONCURRENT = 40;
    const start = clock.nowEpochMs();

    // Every writer reads the same empty counter and writes count=1. A
    // read-then-write store would end at 1; the atomic upsert derives each new
    // count from the committed row, so all 40 events are counted.
    await Promise.all(
      Array.from({ length: CONCURRENT }, () =>
        store.set(
          key,
          Object.freeze({ count: 1, windowStartEpochMs: start, blockedUntilEpochMs: null }),
          start + RULE.windowMs,
        ),
      ),
    );

    expect((await store.get(key))?.count).toBe(CONCURRENT);
    // Both instances observe the same total: the count lives in one row.
    expect((await otherStore.get(key))?.count).toBe(CONCURRENT);
  });

  it("clears a counter on delete, so a legitimate success is never penalised", async () => {
    const key = "login:cleared@example.test";
    await countOne(store, key);
    await countOne(store, key);
    expect((await store.get(key))?.count).toBe(2);

    // The limiter's `clear` (called after a correct login) deletes rather than
    // writing a zero, which matters: `set` counts an event, so writing an "empty"
    // counter would INCREMENT a live row instead of resetting it.
    await store.delete(key);
    expect(await store.get(key)).toBeUndefined();
    expect(await readRow(client, key)).toBeUndefined();

    // Deleting an absent key is a no-op, so a repeated success cannot fail.
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it("enforces the shared limit through the real AuthRateLimiter across instances", async () => {
    const key = "login:limiter@example.test";
    const limiterA = new AuthRateLimiter(store, clock);
    const limiterB = new AuthRateLimiter(otherStore, clock);

    // Alternate the two "processes" up to the login rule's limit.
    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT.limit; attempt += 1) {
      await (attempt % 2 === 0 ? limiterA : limiterB).penalize(key, LOGIN_RATE_LIMIT);
    }

    // The block was reached by the COMBINED attempts: under a per-process store
    // each instance would still be below the limit and let the attack continue.
    expect((await limiterA.check(key, LOGIN_RATE_LIMIT)).allowed).toBe(false);
    expect((await limiterB.check(key, LOGIN_RATE_LIMIT)).allowed).toBe(false);

    // A correct login clears it for both.
    await limiterA.clear(key);
    expect((await limiterB.check(key, LOGIN_RATE_LIMIT)).allowed).toBe(true);
  });

  // (d) Retention must reclaim closed windows without touching live ones.
  it("sweeps expired counters and leaves live ones counting", async () => {
    const live = "sweep:live@example.test";
    const dead = "sweep:dead@example.test";
    await countOne(store, live);
    await insertRow(client, {
      key: dead,
      count: 3,
      windowStartEpochMs: BASE_EPOCH_MS - 30 * MINUTE_MS,
      expiresAtEpochMs: BASE_EPOCH_MS - MINUTE_MS,
    });

    const gateway = new PrismaRetentionGateway(client);
    const result = await gateway.pruneExpiredRateLimitCounters({
      // Unlike the other passes this one is bounded by the row's own expiry, so
      // the retention boundary is not what decides eligibility here.
      olderThanEpochMs: clock.nowEpochMs(),
      nowEpochMs: clock.nowEpochMs(),
      limit: 100,
      afterId: null,
    });
    expect(result.processed).toBeGreaterThanOrEqual(1);

    // The closed window is reclaimed; the live one still holds its count.
    expect(await readRow(client, dead)).toBeUndefined();
    expect((await readRow(client, live))?.count).toBe(1);
  });

  it("prunes through the retention job the cron actually dispatches", async () => {
    // The pruning must be reachable from the REGISTERED job, not merely available
    // on the gateway — otherwise nothing ever calls it in production.
    const key = "sweep:viajob@example.test";
    await insertRow(client, {
      key,
      count: 2,
      windowStartEpochMs: BASE_EPOCH_MS - 30 * MINUTE_MS,
      expiresAtEpochMs: BASE_EPOCH_MS - MINUTE_MS,
    });

    const job = new RetentionRedactionJob({
      gateway: new PrismaRetentionGateway(client),
      clock,
    });
    expect(job.name).toBe("retention-redaction");

    // Drain the job so every category (including the rate-limit pass) runs.
    let cursor: BatchContext["cursor"] = null;
    for (let guard = 0; guard < 50; guard += 1) {
      const step = await job.runBatch({ nowEpochMs: clock.nowEpochMs(), cursor });
      cursor = step.nextCursor;
      if (step.done) break;
    }

    expect(await readRow(client, key)).toBeUndefined();
  });
});
