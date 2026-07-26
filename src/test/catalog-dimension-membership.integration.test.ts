import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { InventoryFilter } from "@domain/task-5-2-device-inventory-pricing";
import { IdempotencyEngine, type IdempotencyStore } from "@application/internal-api";
import { InventoryQueryService } from "@application/offers/inventory-query-service";
import {
  ReservationService,
  type ReserveCommandInput,
  type ReserveResult,
} from "@application/orders";

import {
  createPartnerDatabaseClient,
  PrismaIdempotencyStore,
  PrismaIdempotencyTransactionRunner,
  PrismaInventoryQueryGateway,
  PrismaReservationGateway,
  type PartnerDatabaseClient,
  type PartnerTransactionClient,
} from "@infrastructure/database";
import { CryptoIdGenerator, SystemClock } from "@infrastructure/auth/system-clock";

import {
  createDisposableTestDatabase,
  type DisposableTestDatabase,
} from "./disposable-database";

/**
 * Catalog-dimension membership against real PostgreSQL.
 *
 * The platform could only ever serve ONE catalog dimension, because the
 * dimension lived on the single active `platform_configs` row alongside every
 * platform-wide operational value, and offer validation / inventory / reserve
 * all compared their dimension for EQUALITY with that row. The
 * `20260726000300_catalog_dimensions` migration moves the dimension list into
 * its own additive table and the three consumers switch to MEMBERSHIP.
 *
 * These scenarios prove, on a live engine rather than in fakes:
 *   (a) the migration's backfill turns a database that ALREADY had offers into
 *       exactly one enabled dimension, so its existing supply keeps reserving;
 *   (b) an offer + reserve on a SECOND enabled dimension works end to end and
 *       its immutable snapshot carries THAT dimension's pricing override;
 *   (c) a filter for a dimension that is not served returns the pre-existing
 *       `CATALOG_UNAVAILABLE` error rather than crashing;
 *   (d) disabling a dimension stops it being reservable.
 *
 * The money path is deliberately re-asserted at the database level: the
 * `order_snapshots_financial_check` CHECK still holds for an overridden price
 * (payout + margin = retail, payout = base), so a per-dimension override cannot
 * weaken the zero-sum guarantee the ledger is built on.
 *
 * **Validates: Requirements 8.1, 8.2, 8.5, 8.6, 9.1, 9.2, 9.4, 9.5**
 */
const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const adminUrl = process.env.PARTNER_TEST_DATABASE_ADMIN_URL ?? "";
const hasPostgres = adminUrl.length > 0;

/** The dimension the platform already served before this change. */
const MVP_FILTER: InventoryFilter = { serviceCode: "wa", countryCode: "ID", operatorCode: "any" };
/** A SECOND dimension, impossible to offer or reserve before membership. */
const TELEGRAM_FILTER: InventoryFilter = { serviceCode: "tg", countryCode: "ID", operatorCode: "any" };

const BASE_PRICE_IDR = 1_000;
/** Global formula: 1000 + 250 fee + ceil(1000*1500/10000)=150 -> ceilTo(1400,50). */
const GLOBAL_RETAIL_IDR = 1_400;
/** Telegram override: 1000 + 500 fee + ceil(1000*3000/10000)=300 -> ceilTo(1800,100). */
const TELEGRAM_RETAIL_IDR = 1_800;

const MIGRATION_NAME = "20260726000300_catalog_dimensions";

async function deployFromEmpty(connectionString: string): Promise<void> {
  await execFileAsync(process.execPath, ["scripts/migrate-from-empty.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, PARTNER_MIGRATION_DATABASE_URL: connectionString },
    maxBuffer: 10 * 1024 * 1024,
  });
}

/**
 * The EXACT backfill statements the shipped migration runs, sliced out of the
 * migration file by its delimiters.
 *
 * Replaying the real SQL (rather than a re-typed copy) is the point: it proves
 * the statements that will run against the operator's already-populated database
 * do the right thing. `migrate deploy` on a freshly-created CI database runs the
 * backfill when `platform_configs` is still empty, so it inserts nothing; these
 * scenarios seed a config + offers first — the state a real database is actually
 * in — and then run the same statements. They are idempotent
 * (`ON CONFLICT DO NOTHING`), so replaying is safe.
 */
async function readBackfillStatements(): Promise<readonly string[]> {
  const sql = await readFile(
    path.join(repositoryRoot, "prisma", "migrations", MIGRATION_NAME, "migration.sql"),
    "utf8",
  );
  const start = sql.indexOf(">>> BACKFILL");
  const end = sql.indexOf("<<< BACKFILL END");
  if (start === -1 || end === -1) throw new Error("backfill delimiters missing from migration");
  const body = sql.slice(sql.indexOf("\n", start) + 1, sql.lastIndexOf("\n", end));

  // Prisma sends each raw call as one prepared statement, which Postgres refuses
  // to multiplex, so the block is split on statement boundaries and replayed in
  // order — exactly as the migration runner executes it. Line comments are
  // stripped first, otherwise a statement preceded by its explanatory comment
  // would look like a comment rather than SQL. The backfill contains no string
  // literal holding a `;` or `--`, so this split is faithful to the file.
  const executable = body
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const statements = executable
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const inserts = statements.filter((statement) =>
    statement.includes('INSERT INTO "catalog_dimensions"'),
  );
  if (inserts.length !== 2) {
    throw new Error(
      `expected the 2 backfill INSERTs, sliced ${inserts.length} from the migration`,
    );
  }
  return statements;
}

/** Replay the migration's backfill statements in order. */
async function runBackfill(client: PartnerDatabaseClient): Promise<void> {
  for (const statement of await readBackfillStatements()) {
    await client.$executeRawUnsafe(statement);
  }
}

/** The immutable MVP platform config (mirrors prisma/seed.sql). */
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

/**
 * A fresh, unique canonical Indonesian E.164 number ("+62..."), <= 20 chars.
 *
 * Canonical rule: `+628` then a NON-ZERO digit, then 8 more. Drawing the first
 * digit from 0-9 would produce `+6280…` roughly one run in ten, which the domain
 * rightly rejects — a self-inflicted flake, not a product bug.
 */
function uniqueCanonicalNumber(): string {
  let digits = String(randomInt(1, 10));
  for (let i = 0; i < 8; i += 1) digits += String(randomInt(0, 10));
  return `+628${digits}`;
}

/**
 * Insert a catalog dimension row.
 *
 * Raw SQL because the generated Prisma client is a gitignored build artifact
 * that has not been regenerated for the new model yet; the production reader
 * uses parameterized raw SQL for the same reason.
 */
async function insertDimension(
  client: PartnerDatabaseClient,
  dimension: InventoryFilter,
  options: {
    readonly enabled?: boolean;
    readonly fixedFeeIdr?: number | null;
    readonly markupBps?: number | null;
    readonly roundToIdr?: number | null;
    readonly minBasePriceIdr?: number | null;
    readonly maxBasePriceIdr?: number | null;
  } = {},
): Promise<void> {
  await client.$executeRaw`
    INSERT INTO "catalog_dimensions" (
      "id", "serviceCode", "countryCode", "operatorCode", "enabled",
      "minBasePriceIdr", "maxBasePriceIdr", "fixedFeeIdr", "markupBps", "roundToIdr",
      "createdAt", "updatedAt"
    ) VALUES (
      gen_random_uuid(), ${dimension.serviceCode}, ${dimension.countryCode},
      ${dimension.operatorCode}, ${options.enabled ?? true},
      ${options.minBasePriceIdr ?? null}, ${options.maxBasePriceIdr ?? null},
      ${options.fixedFeeIdr ?? null}, ${options.markupBps ?? null},
      ${options.roundToIdr ?? null}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("serviceCode", "countryCode", "operatorCode") DO NOTHING
  `;
}

interface DimensionRow {
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly enabled: boolean;
  readonly fixedFeeIdr: number | null;
  readonly markupBps: number | null;
}

async function readDimensions(client: PartnerDatabaseClient): Promise<readonly DimensionRow[]> {
  return client.$queryRaw<DimensionRow[]>`
    SELECT "serviceCode", "countryCode", "operatorCode", "enabled", "fixedFeeIdr", "markupBps"
    FROM "catalog_dimensions"
    ORDER BY "serviceCode" ASC
  `;
}

/** Toggle a dimension's `enabled` flag (the only mutable column). */
async function setDimensionEnabled(
  client: PartnerDatabaseClient,
  dimension: InventoryFilter,
  enabled: boolean,
): Promise<void> {
  await client.$executeRaw`
    UPDATE "catalog_dimensions"
    SET "enabled" = ${enabled}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "serviceCode" = ${dimension.serviceCode}
      AND "countryCode" = ${dimension.countryCode}
      AND "operatorCode" = ${dimension.operatorCode}
  `;
}

interface Supply {
  readonly partnerId: string;
  readonly deviceId: string;
  readonly offerId: string;
  readonly numberId: string;
  readonly canonicalNumber: string;
}

/**
 * Approved partner + online simulator device with a fresh heartbeat + an ACTIVE
 * offer on `dimension` + one `available` number in that dimension's
 * country/operator. Everything the eligibility conjunction needs to reserve.
 */
async function seedEligibleSupply(
  client: PartnerDatabaseClient,
  dimension: InventoryFilter,
  options: { readonly basePriceIdr?: number } = {},
): Promise<Supply> {
  const partnerId = randomUUID();
  await client.partner.create({
    data: {
      id: partnerId,
      legalName: "Catalog Dimension Legal",
      displayName: "Catalog Dimension Partner",
      status: "APPROVED",
      simulatorAllowed: true,
    },
  });

  const deviceId = randomUUID();
  await client.partnerDevice.create({
    data: {
      id: deviceId,
      partnerId,
      type: "SIMULATOR",
      label: "Sim",
      effectiveStatus: "ONLINE",
      lastSeenAt: new Date(),
      capabilitiesJson: { sms: true, notification: false, resend: false, operator: null, slots: 1 },
    },
  });

  const offerId = randomUUID();
  await client.partnerOffer.create({
    data: {
      id: offerId,
      partnerId,
      serviceCode: dimension.serviceCode,
      countryCode: dimension.countryCode,
      operatorCode: dimension.operatorCode,
      basePriceIdr: options.basePriceIdr ?? BASE_PRICE_IDR,
      status: "ACTIVE",
      configVersion: 1,
      activeDimensionKey: `${partnerId}:${dimension.serviceCode}:${dimension.countryCode}:${dimension.operatorCode}`,
    },
  });

  const numberId = randomUUID();
  const canonicalNumber = uniqueCanonicalNumber();
  await client.partnerNumber.create({
    data: {
      id: numberId,
      partnerId,
      deviceId,
      canonicalNumber,
      activeCanonicalNumber: canonicalNumber,
      countryCode: dimension.countryCode,
      operatorCode: dimension.operatorCode,
      status: "AVAILABLE",
      enabled: true,
    },
  });

  return { partnerId, deviceId, offerId, numberId, canonicalNumber };
}

/** The real reserve wiring: service over the Prisma gateway + idempotency engine. */
function createReservationService(
  client: PartnerDatabaseClient,
): ReservationService<PartnerTransactionClient> {
  const store: IdempotencyStore<PartnerTransactionClient> = new PrismaIdempotencyStore();
  return new ReservationService<PartnerTransactionClient>({
    idempotency: new IdempotencyEngine<PartnerTransactionClient>({
      store,
      runner: new PrismaIdempotencyTransactionRunner(client),
      clock: new SystemClock(),
    }),
    gateway: new PrismaReservationGateway(),
    clock: new SystemClock(),
    idGenerator: new CryptoIdGenerator(),
  });
}

function reserveCommand(
  filter: InventoryFilter,
  overrides: Partial<ReserveCommandInput> = {},
): ReserveCommandInput {
  const suffix = randomUUID();
  return {
    principalId: "main-client",
    idempotencyKey: `key-${suffix}`,
    method: "POST",
    path: "/api/internal/v1/orders/reserve",
    request: {
      buyerOrderRef: `buyer-${suffix}`,
      buyerAccountRef: `acct-${randomUUID()}`,
      filter,
      // The quote version is the GLOBAL config version for EVERY dimension.
      quoteVersion: 1,
    },
    ...overrides,
  };
}

function errorCode(result: ReserveResult): string | null {
  return "error" in result.body ? result.body.error.code : null;
}

// ---------------------------------------------------------------------------
describe.runIf(hasPostgres)("Catalog dimension membership integration", () => {
  let database: DisposableTestDatabase;
  let client: PartnerDatabaseClient;
  let reservation: ReservationService<PartnerTransactionClient>;
  let inventory: InventoryQueryService;

  beforeAll(async () => {
    database = await createDisposableTestDatabase(adminUrl);
    await deployFromEmpty(database.connectionString);
    client = createPartnerDatabaseClient({ databaseUrl: database.connectionString });
    await client.$connect();
    // The migration deploys the schema but not the config seed, so the backfill
    // it ran found no active config and inserted nothing — the same starting
    // point as a brand new deployment.
    await client.platformConfig.create({ data: platformConfigData(1, "mvp-active") });
    reservation = createReservationService(client);
    inventory = new InventoryQueryService({
      gateway: new PrismaInventoryQueryGateway(client),
      clock: new SystemClock(),
    });
  }, 120_000);

  afterAll(async () => {
    await client?.$disconnect();
    await database?.dispose();
  }, 30_000);

  // (a) A database that ALREADY had offers must keep working. The backfill turns
  // the dimension those offers were created under into the one enabled row, so
  // day-one behaviour is identical and existing supply still reserves.
  describe("Migration backfill on a database that already had offers", () => {
    it("backfills exactly the pre-existing dimension and keeps its supply reservable", async () => {
      // A database in the state a real one is actually in: an active config and
      // supply already created under its dimension.
      const supply = await seedEligibleSupply(client, MVP_FILTER);
      const offersBefore = await client.partnerOffer.count();
      const ordersBefore = await client.partnerOrder.count();
      const snapshotsBefore = await client.orderSnapshot.count();
      const numbersBefore = await client.partnerNumber.count();

      // Run the EXACT statements the shipped migration runs.
      await runBackfill(client);

      // Exactly ONE dimension, enabled, with NO pricing overrides: the very
      // dimension the existing offers carry. All-NULL overrides mean it inherits
      // the global config, so the price is unchanged.
      const dimensions = await readDimensions(client);
      expect(dimensions).toHaveLength(1);
      expect(dimensions[0]).toMatchObject({
        serviceCode: "wa",
        countryCode: "ID",
        operatorCode: "any",
        enabled: true,
        fixedFeeIdr: null,
        markupBps: null,
      });

      // Not one existing row was added, removed, or rewritten by the backfill.
      expect(await client.partnerOffer.count()).toBe(offersBefore);
      expect(await client.partnerOrder.count()).toBe(ordersBefore);
      expect(await client.orderSnapshot.count()).toBe(snapshotsBefore);
      expect(await client.partnerNumber.count()).toBe(numbersBefore);

      // The pre-existing supply still reserves, at the SAME price as before.
      const result = await reservation.reserve(reserveCommand(MVP_FILTER));
      expect(result.statusCode).toBe(200);
      if (!("data" in result.body)) throw new Error("expected a reserved order");
      expect(result.body.data.number).toBe(supply.canonicalNumber);
      expect(result.body.data.snapshot.retailPriceIdr).toBe(GLOBAL_RETAIL_IDR);
      expect(result.body.data.snapshot.payoutIdr).toBe(BASE_PRICE_IDR);
      expect(result.body.data.snapshot.serviceCode).toBe("wa");
      expect(result.body.data.snapshot.configVersion).toBe(1);

      // Replaying the backfill is idempotent (ON CONFLICT DO NOTHING).
      await runBackfill(client);
      expect(await readDimensions(client)).toHaveLength(1);
    });

    it("backfills a legacy offer's other dimension as DISABLED, not enabled", async () => {
      // An offer on a dimension that is NOT the config's is unreservable today.
      // The backfill must keep it that way: it gets a row so operators can see
      // it, but disabled, so enabling it stays a deliberate act.
      const legacy: InventoryFilter = { serviceCode: "sms", countryCode: "ID", operatorCode: "any" };
      await seedEligibleSupply(client, legacy);

      await runBackfill(client);

      const dimensions = await readDimensions(client);
      const legacyRow = dimensions.find((row) => row.serviceCode === "sms");
      expect(legacyRow).toBeDefined();
      expect(legacyRow?.enabled).toBe(false);

      // Still unreservable, with the pre-existing error code.
      const result = await reservation.reserve(reserveCommand(legacy));
      expect(result.statusCode).toBe(404);
      expect(errorCode(result)).toBe("CATALOG_UNAVAILABLE");
    });
  });

  // (b) The capability this change exists for: a SECOND dimension, quoted and
  // reserved end to end, priced by its OWN override, with the immutable snapshot
  // recording exactly what was charged.
  describe("A second enabled dimension reserves end to end", () => {
    it("quotes and reserves Telegram, snapshotting THAT dimension's override pricing", async () => {
      // Telegram is served, priced dearer than the global formula.
      await insertDimension(client, TELEGRAM_FILTER, {
        enabled: true,
        fixedFeeIdr: 500,
        markupBps: 3_000,
        roundToIdr: 100,
      });
      const supply = await seedEligibleSupply(client, TELEGRAM_FILTER);

      // The buyer-facing quote prices by the override, and its quoteVersion is
      // still the GLOBAL config version (not a per-dimension one).
      const quote = await inventory.queryInventory({ filter: TELEGRAM_FILTER });
      expect(quote.ok).toBe(true);
      if (!quote.ok) throw new Error("expected a quote");
      expect(quote.quote.available).toBe(true);
      expect(quote.quote.retailPriceIdr).toBe(TELEGRAM_RETAIL_IDR);
      expect(quote.quote.currency).toBe("IDR");
      expect(quote.quote.quoteVersion).toBe(1);

      // Reserve with that quote version.
      const result = await reservation.reserve(
        reserveCommand(TELEGRAM_FILTER, {
          request: {
            buyerOrderRef: `buyer-tg-${randomUUID()}`,
            buyerAccountRef: `acct-${randomUUID()}`,
            filter: TELEGRAM_FILTER,
            quoteVersion: quote.quote.quoteVersion,
          },
        }),
      );
      expect(result.statusCode).toBe(200);
      if (!("data" in result.body)) throw new Error("expected a reserved order");
      const view = result.body.data;
      expect(view.status).toBe("waiting_sms");
      expect(view.number).toBe(supply.canonicalNumber);

      // The persisted snapshot carries the SECOND dimension and ITS pricing.
      const order = await client.partnerOrder.findUniqueOrThrow({
        where: { id: view.partnerOrderId },
      });
      expect(order.status).toBe("WAITING_SMS");
      expect(order.offerId).toBe(supply.offerId);
      const snapshot = await client.orderSnapshot.findUniqueOrThrow({
        where: { orderId: view.partnerOrderId },
      });
      expect(snapshot.serviceCode).toBe("tg");
      expect(snapshot.countryCode).toBe("ID");
      expect(snapshot.operatorCode).toBe("any");
      expect(snapshot.canonicalNumber).toBe(supply.canonicalNumber);
      expect(snapshot.basePriceIdr).toBe(BASE_PRICE_IDR);
      expect(snapshot.retailPriceIdr).toBe(TELEGRAM_RETAIL_IDR);
      expect(snapshot.payoutIdr).toBe(BASE_PRICE_IDR);
      expect(snapshot.platformMarginIdr).toBe(TELEGRAM_RETAIL_IDR - BASE_PRICE_IDR);
      // `currency` and `configVersion` remain global, single-sourced on the config.
      expect(snapshot.currency).toBe("IDR");
      expect(snapshot.configVersion).toBe(1);

      // The money path stays zero-sum for an OVERRIDDEN price: the database
      // CHECK (payout = base, retail = payout + margin) held on insert, and the
      // snapshot is still immutable.
      expect(snapshot.payoutIdr + snapshot.platformMarginIdr).toBe(snapshot.retailPriceIdr);
      await expect(
        client.$executeRawUnsafe(
          `UPDATE "order_snapshots" SET "retailPriceIdr" = 1 WHERE "orderId" = $1`,
          view.partnerOrderId,
        ),
      ).rejects.toThrow();

      // The number was flipped available -> reserved -> busy and bound.
      const number = await client.partnerNumber.findUniqueOrThrow({
        where: { id: supply.numberId },
      });
      expect(number.status).toBe("BUSY");
      expect(number.currentOrderId).toBe(order.id);
    });

    it("prices a second dimension with NO override exactly like the global config", async () => {
      const noOverride: InventoryFilter = {
        serviceCode: "ig",
        countryCode: "ID",
        operatorCode: "any",
      };
      await insertDimension(client, noOverride, { enabled: true });
      const supply = await seedEligibleSupply(client, noOverride);

      const result = await reservation.reserve(reserveCommand(noOverride));
      expect(result.statusCode).toBe(200);
      if (!("data" in result.body)) throw new Error("expected a reserved order");
      expect(result.body.data.number).toBe(supply.canonicalNumber);
      // Inherits the global formula: identical to the MVP dimension's price.
      expect(result.body.data.snapshot.retailPriceIdr).toBe(GLOBAL_RETAIL_IDR);
      expect(result.body.data.snapshot.serviceCode).toBe("ig");
    });
  });

  // (c) A filter for a dimension that is not served must be the pre-existing
  // deterministic error, never a crash.
  describe("A dimension that is not served", () => {
    it("returns CATALOG_UNAVAILABLE for an unknown dimension without crashing", async () => {
      const unknown: InventoryFilter = {
        serviceCode: "nope",
        countryCode: "ID",
        operatorCode: "any",
      };
      const ordersBefore = await client.partnerOrder.count();

      const result = await reservation.reserve(reserveCommand(unknown));
      expect(result.statusCode).toBe(404);
      expect(errorCode(result)).toBe("CATALOG_UNAVAILABLE");
      // No partial order, and the inventory read agrees.
      expect(await client.partnerOrder.count()).toBe(ordersBefore);
      const quote = await inventory.queryInventory({ filter: unknown });
      expect(quote).toEqual({ ok: false, reason: "catalog_mismatch" });
    });
  });

  // (d) Disabling a dimension stops it being reservable — the operator's kill
  // switch, and the only mutable column on the table.
  describe("Disabling a dimension", () => {
    it("stops a previously reservable dimension from being reserved or quoted", async () => {
      const toggled: InventoryFilter = {
        serviceCode: "fb",
        countryCode: "ID",
        operatorCode: "any",
      };
      await insertDimension(client, toggled, { enabled: true });
      const first = await seedEligibleSupply(client, toggled);

      // Reservable while enabled.
      const before = await reservation.reserve(reserveCommand(toggled));
      expect(before.statusCode).toBe(200);
      if (!("data" in before.body)) throw new Error("expected a reserved order");
      expect(before.body.data.number).toBe(first.canonicalNumber);

      // Fresh eligible supply, then withdraw the dimension from sale.
      const second = await seedEligibleSupply(client, toggled);
      await setDimensionEnabled(client, toggled, false);
      const ordersBefore = await client.partnerOrder.count();

      // Now refused with the pre-existing error code, and nothing is written.
      const after = await reservation.reserve(reserveCommand(toggled));
      expect(after.statusCode).toBe(404);
      expect(errorCode(after)).toBe("CATALOG_UNAVAILABLE");
      expect(await client.partnerOrder.count()).toBe(ordersBefore);
      const stillAvailable = await client.partnerNumber.findUniqueOrThrow({
        where: { id: second.numberId },
      });
      expect(stillAvailable.status).toBe("AVAILABLE");
      expect(stillAvailable.currentOrderId).toBeNull();

      // The quote agrees, and re-enabling restores reservability.
      expect(await inventory.queryInventory({ filter: toggled })).toEqual({
        ok: false,
        reason: "catalog_mismatch",
      });
      await setDimensionEnabled(client, toggled, true);
      const restored = await reservation.reserve(reserveCommand(toggled));
      expect(restored.statusCode).toBe(200);
    });
  });

  // The invariant that makes the `quoteVersion` decision sound: a dimension's
  // pricing override cannot move under a live quote. Only `enabled` is mutable.
  describe("Dimension pricing immutability (quoteVersion soundness)", () => {
    it("rejects a pricing-override change and a delete, but allows an enabled toggle", async () => {
      const frozen: InventoryFilter = {
        serviceCode: "vk",
        countryCode: "ID",
        operatorCode: "any",
      };
      await insertDimension(client, frozen, { enabled: true, markupBps: 2_000 });

      await expect(
        client.$executeRawUnsafe(
          `UPDATE "catalog_dimensions" SET "markupBps" = 9999 WHERE "serviceCode" = 'vk'`,
        ),
      ).rejects.toThrow();
      await expect(
        client.$executeRawUnsafe(
          `UPDATE "catalog_dimensions" SET "serviceCode" = 'vk2' WHERE "serviceCode" = 'vk'`,
        ),
      ).rejects.toThrow();
      await expect(
        client.$executeRawUnsafe(`DELETE FROM "catalog_dimensions" WHERE "serviceCode" = 'vk'`),
      ).rejects.toThrow();

      // The override is intact, and the kill switch still works.
      await setDimensionEnabled(client, frozen, false);
      const rows = await readDimensions(client);
      const row = rows.find((candidate) => candidate.serviceCode === "vk");
      expect(row?.markupBps).toBe(2_000);
      expect(row?.enabled).toBe(false);
    });
  });
});
