import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { InventoryFilter } from "@domain/task-5-2-device-inventory-pricing";
import {
  IdempotencyEngine,
  type IdempotencyStore,
} from "@application/internal-api";
import {
  ReservationService,
  RESERVE_SCOPE,
  type ReserveCommandInput,
  type ReserveResult,
} from "@application/orders";

import {
  createPartnerDatabaseClient,
  PrismaIdempotencyStore,
  PrismaIdempotencyTransactionRunner,
  PrismaReservationGateway,
  RESERVE_LOCK_LIMIT,
  type PartnerDatabaseClient,
  type PartnerTransactionClient,
} from "@infrastructure/database";
import { CryptoIdGenerator, SystemClock } from "@infrastructure/auth/system-clock";

import {
  createDisposableTestDatabase,
  type DisposableTestDatabase,
} from "./disposable-database";

/**
 * Task 17.2 — end-to-end PostgreSQL concurrency test for the atomic reservation
 * path (design section 3: READ COMMITTED + `FOR UPDATE SKIP LOCKED`, with the
 * order + snapshot + idempotency record + number transition committing in one
 * interactive transaction, and the `reserved→waiting_sms` / `reserved→busy`
 * activation completing before any success is returned).
 *
 * These fire 20–100 concurrent `reserve` requests through the real production
 * wiring — the {@link ReservationService} over the {@link PrismaReservationGateway}
 * and the task 9.2 {@link IdempotencyEngine} (with the real
 * {@link PrismaIdempotencyStore} + {@link PrismaIdempotencyTransactionRunner}) —
 * against a disposable PostgreSQL database migrated from empty. No in-memory
 * fakes: the row lock, the unique constraints, and the transaction boundary are
 * exercised on real storage, so the "at most one reservation wins a number"
 * guarantee (requirement 9.3) is proven rather than asserted in a fake.
 *
 * Complements the pure/adapter unit suite (`reservation-service.unit.test.ts`)
 * which pins the orchestration/branching against fakes; here we prove the
 * concurrency + atomicity invariants against a live engine.
 *
 * **Validates: Requirements 9.2, 9.3, 9.4, 9.5**
 */
const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const adminUrl = process.env.PARTNER_TEST_DATABASE_ADMIN_URL ?? "";
const hasPostgres = adminUrl.length > 0;

/** The single MVP catalog dimension the seeded config serves. */
const MVP_FILTER: InventoryFilter = { serviceCode: "wa", countryCode: "ID", operatorCode: "any" };
const MVP_PAYOUT_IDR = 1_000;
/** base 1000 + fee 250 + ceil(1000*1500/10000)=150 -> ceilTo(1400, 50) = 1400. */
const EXPECTED_RETAIL_IDR = 1_400;
const EXPECTED_MARGIN_IDR = 400;
/** How many reservations race for the single eligible number. */
const CONCURRENCY = 40;

async function deployFromEmpty(connectionString: string): Promise<void> {
  await execFileAsync(process.execPath, ["scripts/migrate-from-empty.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, PARTNER_MIGRATION_DATABASE_URL: connectionString },
    maxBuffer: 10 * 1024 * 1024,
  });
}

/** The immutable MVP platform config the reserve path reads (mirrors seed.sql). */
function platformConfigData(version: number, activeKey: string) {
  return {
    id: randomUUID(),
    version,
    serviceCode: "wa",
    countryCode: "ID",
    operatorCode: "any",
    currency: "IDR",
    minBasePriceIdr: 500,
    maxBasePriceIdr: 5_000,
    fixedFeeIdr: 250,
    markupBps: 1_500,
    roundToIdr: 50,
    heartbeatIntervalSeconds: 30,
    heartbeatTimeoutSeconds: 90,
    heartbeatSweepSeconds: 30,
    orderTimeoutSeconds: 1_200,
    cancelMinimumSeconds: 180,
    reservationRecoverySeconds: 30,
    earningHoldSeconds: 86_400,
    minimumPayoutIdr: 1_000,
    smsRawRetentionDays: 7,
    otpRetentionHours: 24,
    heartbeatMetadataRetentionDays: 30,
    securityEventRetentionDays: 90,
    auditRetentionDays: 2_557,
    financialRetentionDays: 2_557,
    simulatorAllowlistJson: { partnerIds: [] },
    activeKey,
    activeFrom: new Date(Date.UTC(2026, 6, 22, 0, 1, 0)),
  };
}

/** Build the real reservation service over the shared disposable database. */
function createReservationService(
  client: PartnerDatabaseClient,
): ReservationService<PartnerTransactionClient> {
  const store: IdempotencyStore<PartnerTransactionClient> = new PrismaIdempotencyStore();
  const idempotency = new IdempotencyEngine<PartnerTransactionClient>({
    store,
    runner: new PrismaIdempotencyTransactionRunner(client),
    clock: new SystemClock(),
  });
  return new ReservationService<PartnerTransactionClient>({
    idempotency,
    gateway: new PrismaReservationGateway(),
    clock: new SystemClock(),
    idGenerator: new CryptoIdGenerator(),
  });
}

// ---------------------------------------------------------------------------
// Fixture seeding (raw client): an approved partner, an online simulator
// device with a fresh heartbeat, an active offer, and one `available` number.
// ---------------------------------------------------------------------------

/** A fresh, unique canonical Indonesian E.164 number ("+62..."), <= 20 chars. */
function uniqueCanonicalNumber(): string {
  let digits = "";
  for (let i = 0; i < 9; i += 1) digits += String(randomInt(0, 10));
  return `+628${digits}`;
}

interface Supply {
  readonly partnerId: string;
  readonly deviceId: string;
  readonly offerId: string;
  readonly numberId: string;
  readonly canonicalNumber: string;
}

async function createApprovedPartner(client: PartnerDatabaseClient): Promise<string> {
  const id = randomUUID();
  await client.partner.create({
    data: {
      id,
      legalName: "Concurrency Integration Legal",
      displayName: "Concurrency Integration Partner",
      status: "APPROVED",
      simulatorAllowed: true,
    },
  });
  return id;
}

/** An online simulator device with a fresh heartbeat and the `sms` capability. */
async function createOnlineDevice(
  client: PartnerDatabaseClient,
  partnerId: string,
  options: { readonly online?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const online = options.online ?? true;
  await client.partnerDevice.create({
    data: {
      id,
      partnerId,
      type: "SIMULATOR",
      label: "Sim",
      effectiveStatus: online ? "ONLINE" : "OFFLINE",
      lastSeenAt: online ? new Date() : null,
      capabilitiesJson: { sms: true, notification: false, resend: false, operator: null, slots: 1 },
    },
  });
  return id;
}

async function createActiveOffer(
  client: PartnerDatabaseClient,
  partnerId: string,
): Promise<string> {
  const id = randomUUID();
  await client.partnerOffer.create({
    data: {
      id,
      partnerId,
      serviceCode: "wa",
      countryCode: "ID",
      operatorCode: "any",
      basePriceIdr: MVP_PAYOUT_IDR,
      status: "ACTIVE",
      configVersion: 1,
      activeDimensionKey: `${partnerId}:wa:ID:any`,
    },
  });
  return id;
}

/**
 * Approved partner + online device + active offer + one registered number in
 * the given status. Defaults to a fresh `available` number eligible for
 * reservation. When `online: false` the device is offline (a stockout source).
 */
async function seedEligibleSupply(
  client: PartnerDatabaseClient,
  options: { readonly online?: boolean; readonly status?: "AVAILABLE" | "OFFLINE" } = {},
): Promise<Supply> {
  const partnerId = await createApprovedPartner(client);
  const online = options.online ?? true;
  const deviceId = await createOnlineDevice(client, partnerId, { online });
  const offerId = await createActiveOffer(client, partnerId);
  const numberId = randomUUID();
  const canonicalNumber = uniqueCanonicalNumber();
  const status = options.status ?? "AVAILABLE";
  await client.partnerNumber.create({
    data: {
      id: numberId,
      partnerId,
      deviceId,
      canonicalNumber,
      activeCanonicalNumber: canonicalNumber,
      countryCode: "ID",
      operatorCode: "any",
      status,
      enabled: true,
    },
  });
  return { partnerId, deviceId, offerId, numberId, canonicalNumber };
}

/**
 * A process-wide monotonic serial guarantees a globally unique canonical number
 * for every seeded row, satisfying the `activeCanonicalNumber` UNIQUE constraint
 * (and the "active mirrors canonical" CHECK) even across bulk seeds.
 */
let canonicalSerial = 0;
function nextUniqueCanonicalNumber(): string {
  canonicalSerial += 1;
  // "+628" + [1-9] + 10 digits: valid Indonesian E.164 shape, <= 20 chars.
  return `+6281${String(canonicalSerial).padStart(10, "0")}`;
}

interface BulkSupply {
  readonly partnerId: string;
  readonly numberIds: readonly string[];
}

/**
 * Approved partner + online device + active offer + `count` `available` numbers,
 * all eligible for reservation in the MVP dimension. Used to prove that a
 * bounded lock batch leaves stock for concurrent reserves: with many eligible
 * numbers, parallel reserves must each win a distinct number instead of one
 * receiving a spurious stockout because a peer locked the whole dimension.
 */
async function seedManyEligibleNumbers(
  client: PartnerDatabaseClient,
  count: number,
): Promise<BulkSupply> {
  const partnerId = await createApprovedPartner(client);
  const deviceId = await createOnlineDevice(client, partnerId, { online: true });
  await createActiveOffer(client, partnerId);
  const rows = Array.from({ length: count }, () => {
    const canonicalNumber = nextUniqueCanonicalNumber();
    return {
      id: randomUUID(),
      partnerId,
      deviceId,
      canonicalNumber,
      activeCanonicalNumber: canonicalNumber,
      countryCode: "ID",
      operatorCode: "any",
      status: "AVAILABLE" as const,
      enabled: true,
    };
  });
  await client.partnerNumber.createMany({ data: rows });
  return { partnerId, numberIds: rows.map((row) => row.id) };
}

function reserveCommand(overrides: Partial<ReserveCommandInput> = {}): ReserveCommandInput {
  const suffix = randomUUID();
  return {
    principalId: "main-client",
    idempotencyKey: `key-${suffix}`,
    method: "POST",
    path: "/api/internal/v1/orders/reserve",
    request: {
      buyerOrderRef: `buyer-${suffix}`,
      buyerAccountRef: `acct-${randomUUID()}`,
      filter: MVP_FILTER,
      quoteVersion: 1,
    },
    ...overrides,
  };
}

function isSuccess(result: ReserveResult): boolean {
  return result.statusCode === 200 && "data" in result.body;
}

function errorCode(result: ReserveResult): string | null {
  return "error" in result.body ? result.body.error.code : null;
}

// ---------------------------------------------------------------------------
describe.runIf(hasPostgres)("Reservation concurrency integration (task 17.2)", () => {
  let database: DisposableTestDatabase;
  let client: PartnerDatabaseClient;
  let service: ReservationService<PartnerTransactionClient>;

  beforeAll(async () => {
    database = await createDisposableTestDatabase(adminUrl);
    await deployFromEmpty(database.connectionString);
    client = createPartnerDatabaseClient({ databaseUrl: database.connectionString });
    await client.$connect();
    await client.platformConfig.create({ data: platformConfigData(1, "mvp-active") });
    service = createReservationService(client);
  }, 120_000);

  afterAll(async () => {
    await client?.$disconnect();
    await database?.dispose();
  }, 30_000);

  // Requirements 9.2, 9.3, 9.5: N concurrent reservations race for a single
  // eligible number. At most one wins (row lock + SKIP LOCKED); the winner's
  // order + snapshot + `reserved→busy` number transition commit atomically;
  // every loser gets a deterministic stockout with no partial order/snapshot,
  // and no idempotency record is left in a partial (non-completed) state.
  describe("At most one of N concurrent reservations wins the single number", () => {
    it(`resolves exactly one success and ${CONCURRENCY - 1} clean stockouts`, async () => {
      const supply = await seedEligibleSupply(client);

      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => service.reserve(reserveCommand())),
      );

      // Exactly one reservation succeeds. Each loser is a clean, non-partial
      // failure that is EITHER a definitive stockout (409 — the winner had
      // already committed the number busy before the loser looked) OR a
      // retryable contention (503 DEPENDENCY_UNAVAILABLE — the number was still
      // committed-`available` but row-locked by the winner, so the reserve
      // rolled back for the caller to retry). Both are correct; the bug this
      // guards against is a permanently-persisted stockout while the number was
      // merely locked.
      const successes = results.filter(isSuccess);
      const losers = results.filter((r) => !isSuccess(r));
      expect(successes).toHaveLength(1);
      expect(losers).toHaveLength(CONCURRENCY - 1);
      for (const loser of losers) {
        expect([409, 503]).toContain(loser.statusCode);
        expect(["OUT_OF_STOCK", "DEPENDENCY_UNAVAILABLE"]).toContain(errorCode(loser));
      }

      const winner = successes[0];
      if (!("data" in winner.body)) throw new Error("unreachable");
      const view = winner.body.data;
      expect(view.status).toBe("waiting_sms");
      expect(view.number).toBe(supply.canonicalNumber);

      // Exactly one active order exists for the number, in `waiting_sms`.
      const orders = await client.partnerOrder.findMany({ where: { numberId: supply.numberId } });
      expect(orders).toHaveLength(1);
      const order = orders[0];
      expect(order.id).toBe(view.partnerOrderId);
      expect(order.status).toBe("WAITING_SMS");
      expect(order.partnerId).toBe(supply.partnerId);
      expect(order.offerId).toBe(supply.offerId);

      // The number was flipped `available→reserved→busy` and bound to the order.
      const number = await client.partnerNumber.findUniqueOrThrow({ where: { id: supply.numberId } });
      expect(number.status).toBe("BUSY");
      expect(number.currentOrderId).toBe(order.id);

      // Exactly one consistent, immutable snapshot (requirement 9.5).
      const snapshots = await client.orderSnapshot.findMany();
      expect(snapshots).toHaveLength(1);
      const snapshot = snapshots[0];
      expect(snapshot.orderId).toBe(order.id);
      expect(snapshot.serviceCode).toBe("wa");
      expect(snapshot.countryCode).toBe("ID");
      expect(snapshot.operatorCode).toBe("any");
      expect(snapshot.canonicalNumber).toBe(supply.canonicalNumber);
      expect(snapshot.basePriceIdr).toBe(MVP_PAYOUT_IDR);
      expect(snapshot.retailPriceIdr).toBe(EXPECTED_RETAIL_IDR);
      expect(snapshot.payoutIdr).toBe(MVP_PAYOUT_IDR);
      expect(snapshot.platformMarginIdr).toBe(EXPECTED_MARGIN_IDR);
      expect(snapshot.currency).toBe("IDR");
      expect(snapshot.configVersion).toBe(1);
      // The returned snapshot view is consistent with the persisted row.
      expect(view.snapshot.retailPriceIdr).toBe(snapshot.retailPriceIdr);
      expect(view.snapshot.payoutIdr).toBe(snapshot.payoutIdr);

      // No partial idempotency rows. The winner commits exactly one COMPLETED
      // 200 record. A 409 loser (definitive stockout) also persists a COMPLETED
      // record; a 503 loser (contention) threw and rolled back, persisting
      // NOTHING (safe to retry). So: exactly one 200, no 503 ever persisted,
      // every persisted record COMPLETED, and the row count is the winner plus
      // only the definitive-stockout losers.
      const records = await client.idempotencyRecord.findMany({ where: { scope: RESERVE_SCOPE } });
      expect(records.every((rec) => rec.state === "COMPLETED")).toBe(true);
      expect(records.filter((rec) => rec.responseStatus === 200)).toHaveLength(1);
      expect(records.filter((rec) => rec.responseStatus === 503)).toHaveLength(0);
      const definitiveStockoutLosers = losers.filter((r) => r.statusCode === 409);
      expect(records).toHaveLength(1 + definitiveStockoutLosers.length);

      // The activation transition trail exists for exactly the one order.
      const transitions = await client.orderTransition.findMany({ where: { orderId: order.id } });
      const toStatuses = transitions.map((t) => t.toStatus).sort();
      expect(toStatuses).toEqual(["RESERVED", "WAITING_SMS"]);

      // Contention is transient, never a permanent poison: once the winner has
      // committed, a fresh retry of any loser resolves to a clean, definitive
      // stockout (the single number is now busy).
      for (const loser of losers) {
        if (loser.statusCode !== 503) continue;
        const retried = await service.reserve(reserveCommand());
        expect(retried.statusCode).toBe(409);
        expect(errorCode(retried)).toBe("OUT_OF_STOCK");
      }
    });
  });

  // Requirement 9.4: when nothing is eligible (device offline -> the coarse SQL
  // predicate + the pure eligibility conjunction both exclude the number), the
  // reserve returns a deterministic stockout and writes no partial order.
  describe("A stockout scenario creates no partial order", () => {
    it("returns OUT_OF_STOCK and persists no order or snapshot when no inventory is eligible", async () => {
      // Offline device -> the number is registered OFFLINE and excluded.
      const supply = await seedEligibleSupply(client, { online: false, status: "OFFLINE" });

      const before = await client.partnerOrder.count();
      const result = await service.reserve(reserveCommand());

      expect(result.statusCode).toBe(409);
      expect(errorCode(result)).toBe("OUT_OF_STOCK");

      // No order and no snapshot were created for this number.
      const orders = await client.partnerOrder.count({ where: { numberId: supply.numberId } });
      expect(orders).toBe(0);
      expect(await client.partnerOrder.count()).toBe(before);
      const snapshot = await client.orderSnapshot.findFirst({
        where: { canonicalNumber: supply.canonicalNumber },
      });
      expect(snapshot).toBeNull();

      // The number is untouched (still OFFLINE, unbound).
      const number = await client.partnerNumber.findUniqueOrThrow({ where: { id: supply.numberId } });
      expect(number.status).toBe("OFFLINE");
      expect(number.currentOrderId).toBeNull();
    });
  });

  // Requirements 9.2, 10.4: distinct idempotency keys attempt independently,
  // while a repeated key + payload replays the first result without a second
  // order, and a fresh key against the now-busy number gets a clean stockout.
  describe("Idempotency key semantics on the reserve path", () => {
    it("replays a repeated key without a second order and stocks out fresh keys", async () => {
      const supply = await seedEligibleSupply(client);
      const command = reserveCommand();

      const first = await service.reserve(command);
      expect(isSuccess(first)).toBe(true);
      if (!("data" in first.body)) throw new Error("unreachable");
      const orderId = first.body.data.partnerOrderId;

      // A retry with the same key + payload replays the first result verbatim.
      const replay = await service.reserve(command);
      expect(replay).toEqual(first);

      // Only one order exists — the replay did not create a second.
      const orders = await client.partnerOrder.findMany({ where: { numberId: supply.numberId } });
      expect(orders).toHaveLength(1);
      expect(orders[0].id).toBe(orderId);
      expect(await client.orderSnapshot.count({ where: { orderId } })).toBe(1);

      // A distinct key now finds the number busy -> deterministic stockout, no
      // partial order.
      const another = await service.reserve(reserveCommand());
      expect(another.statusCode).toBe(409);
      expect(errorCode(another)).toBe("OUT_OF_STOCK");
      expect(await client.partnerOrder.count({ where: { numberId: supply.numberId } })).toBe(1);
    });
  });

  // Requirement 9.3 (contention safety, the other direction): with MORE than one
  // eligible number, concurrent reservations must NOT starve each other. The
  // candidate lock is bounded to a batch (RESERVE_LOCK_LIMIT), so a reserve
  // locks only a slice of the available rows and leaves the rest for peers to
  // lock via SKIP LOCKED. Two parallel reserves therefore both win, on distinct
  // numbers — regressing this to an unbounded `FOR UPDATE SKIP LOCKED` (one
  // reserve locking the entire dimension) would give one winner and one spurious
  // OUT_OF_STOCK.
  describe("Concurrent reserves against abundant stock each win a distinct number", () => {
    it("resolves two parallel reserves as two successes on different numbers", async () => {
      // More rows than one reserve can lock, so a peer always has stock left.
      const supply = await seedManyEligibleNumbers(client, RESERVE_LOCK_LIMIT + 4);

      const [a, b] = await Promise.all([
        service.reserve(reserveCommand()),
        service.reserve(reserveCommand()),
      ]);

      expect(isSuccess(a)).toBe(true);
      expect(isSuccess(b)).toBe(true);
      if (!("data" in a.body) || !("data" in b.body)) throw new Error("unreachable");

      // Each reservation won a *different* number and produced a distinct order.
      expect(a.body.data.number).not.toBe(b.body.data.number);
      expect(a.body.data.partnerOrderId).not.toBe(b.body.data.partnerOrderId);

      // Both winners came from the seeded supply and are BUSY, bound to their own
      // order (available -> reserved -> busy committed atomically).
      for (const view of [a.body.data, b.body.data]) {
        const order = await client.partnerOrder.findUniqueOrThrow({
          where: { id: view.partnerOrderId },
        });
        expect(order.status).toBe("WAITING_SMS");
        expect(supply.numberIds).toContain(order.numberId);
        const number = await client.partnerNumber.findUniqueOrThrow({
          where: { id: order.numberId },
        });
        expect(number.status).toBe("BUSY");
        expect(number.currentOrderId).toBe(order.id);
      }
    });
  });

  // Requirement 9.4 (small-inventory regression): when a dimension holds FEWER
  // available numbers than one reserve's lock batch (RESERVE_LOCK_LIMIT), a
  // single reserve can row-lock the ENTIRE dimension, so a concurrent peer sees
  // zero via SKIP LOCKED. That must be a RETRYABLE contention (503), never a
  // permanent, persisted OUT_OF_STOCK — the stock exists, it is merely locked.
  // Deterministically simulated by holding FOR UPDATE on every available row in
  // a separate connection while a reserve runs.
  describe("Small inventory fully locked yields retryable contention, not a false stockout", () => {
    it("returns 503 (not 409) while every available number is locked, then sells after release", async () => {
      // This suite shares one database across the whole describe and the reserve
      // path selects platform-wide (not partner-scoped). Earlier scenarios leave
      // residual `available` stock in this dimension (the abundant-stock test
      // leaves rows unsold), which would violate this scenario's precondition — a
      // SMALL dimension (< the lock batch) whose entire available supply is the
      // rows seeded below. Disable that residual stock so only these three
      // numbers are reservable, and the locker can hold the whole dimension.
      await client.partnerNumber.updateMany({
        where: { status: "AVAILABLE", enabled: true, countryCode: "ID", operatorCode: "any" },
        data: { status: "OFFLINE" },
      });
      const supply = await seedManyEligibleNumbers(client, 3); // < RESERVE_LOCK_LIMIT
      const locker = createPartnerDatabaseClient({ databaseUrl: database.connectionString });
      await locker.$connect();

      // The suite database has accumulated idempotency records and orders from
      // earlier scenarios; a contended 503 must persist NOTHING, so the reserve
      // must leave both counts exactly where they started (a delta of zero).
      const idempotencyBefore = await client.idempotencyRecord.count({
        where: { scope: RESERVE_SCOPE },
      });
      const ordersBefore = await client.partnerOrder.count();

      let reserveWhileLocked: ReserveResult | undefined;
      try {
        // Hold a row lock on every available number in the dimension across the
        // reserve below (interactive transaction on a SEPARATE connection, so
        // the service's own transaction runs concurrently and hits SKIP LOCKED).
        await locker.$transaction(
          async (tx) => {
            await tx.$queryRaw`
              SELECT "id"
              FROM "partner_numbers"
              WHERE "status"::text = 'available'
                AND "enabled" = true
                AND "currentOrderId" IS NULL
                AND "countryCode" = 'ID'
                AND "operatorCode" = 'any'
              FOR UPDATE
            `;
            reserveWhileLocked = await service.reserve(reserveCommand());
          },
          { timeout: 20_000 },
        );
      } finally {
        await locker.$disconnect();
      }

      // Contended, not stocked out: retryable 503 with nothing persisted, so the
      // caller can safely retry (the pre-fix bug returned a permanent 409 here).
      expect(reserveWhileLocked?.statusCode).toBe(503);
      expect(errorCode(reserveWhileLocked as ReserveResult)).toBe("DEPENDENCY_UNAVAILABLE");
      expect(
        await client.idempotencyRecord.count({ where: { scope: RESERVE_SCOPE } }),
      ).toBe(idempotencyBefore);
      expect(await client.partnerOrder.count()).toBe(ordersBefore);

      // With the lock released the very same stock is sellable — no poison.
      const retry = await service.reserve(reserveCommand());
      expect(isSuccess(retry)).toBe(true);
      if (!("data" in retry.body)) throw new Error("unreachable");
      expect(supply.numberIds).toContain(
        (await client.partnerOrder.findUniqueOrThrow({
          where: { id: retry.body.data.partnerOrderId },
        })).numberId,
      );
    });
  });

  // The deterministic core of the bound: an interactive transaction holds a lock
  // batch open while a second reserve runs *provably concurrently* (a barrier,
  // not a hopeful race). The held batch is capped at RESERVE_LOCK_LIMIT even
  // though far more rows are available, so the concurrent reserve skips it and
  // still wins. The pre-fix unbounded query would have locked every available
  // row here, so this fails deterministically without the LIMIT.
  describe("A held lock batch is bounded, leaving stock for a concurrent reserve", () => {
    it(`locks at most ${RESERVE_LOCK_LIMIT} rows so a concurrent reserve still wins`, async () => {
      await seedManyEligibleNumbers(client, RESERVE_LOCK_LIMIT + 4);
      const gateway = new PrismaReservationGateway();

      // Barrier: the holder transaction locks its batch, signals, then parks on
      // `held` so its FOR UPDATE locks stay live while the concurrent reserve runs.
      let releaseHold: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      let signalLocked: () => void = () => {};
      const lockedSignal = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      let heldLockedIds: readonly string[] = [];

      const holdTxn = client.$transaction(
        async (tx) => {
          const batch = await gateway.lockEligibleCandidates(tx, MVP_FILTER);
          heldLockedIds = batch.map((candidate) => candidate.numberId);
          signalLocked();
          await held;
        },
        { timeout: 30_000, maxWait: 10_000 },
      );

      try {
        await lockedSignal;
        // Bounded: the batch never exceeds RESERVE_LOCK_LIMIT even though more
        // than that many rows are available (the pre-fix query would lock all).
        expect(heldLockedIds).toHaveLength(RESERVE_LOCK_LIMIT);

        // Concurrent reserve skips the held batch (SKIP LOCKED) and still wins.
        const result = await service.reserve(reserveCommand());
        expect(isSuccess(result)).toBe(true);
        if (!("data" in result.body)) throw new Error("unreachable");

        const order = await client.partnerOrder.findUniqueOrThrow({
          where: { id: result.body.data.partnerOrderId },
        });
        // It won a number OUTSIDE the still-locked batch and bound it BUSY.
        expect(heldLockedIds).not.toContain(order.numberId);
        const number = await client.partnerNumber.findUniqueOrThrow({
          where: { id: order.numberId },
        });
        expect(number.status).toBe("BUSY");
        expect(number.currentOrderId).toBe(order.id);
      } finally {
        releaseHold();
        await holdTxn;
      }
    });
  });
});
