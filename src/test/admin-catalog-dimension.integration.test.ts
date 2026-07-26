import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { InventoryFilter } from "@domain/task-5-2-device-inventory-pricing";
import type { AuthenticatedAdmin } from "@domain/task-7-5";

import { AdminCatalogDimensionService } from "@application/admin/admin-catalog-dimension-service";
import { IdempotencyEngine, type IdempotencyStore } from "@application/internal-api";
import { InventoryQueryService } from "@application/offers/inventory-query-service";
import {
  ReservationService,
  type ReserveCommandInput,
  type ReserveResult,
} from "@application/orders";

import {
  createPartnerDatabaseClient,
  PrismaAdminCatalogDimensionGateway,
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
 * The admin catalog-dimension path against real PostgreSQL.
 *
 * Four dimensions were put on sale by running raw `INSERT` SQL against the live
 * database — an operator hand-writing statements on a money-path system, leaving
 * no record of who changed what the platform sells. This suite proves the admin
 * command that replaces it behaves correctly on a live engine:
 *
 *   (a) declaring a dimension makes it reservable END TO END (quote + reserve +
 *       snapshot), which is the whole point of the action;
 *   (b) toggling `enabled` off returns the pre-existing `CATALOG_UNAVAILABLE`,
 *       and toggling back on restores reservability;
 *   (c) declaring a duplicate triple is refused cleanly, not as a crash;
 *   (d) every accepted command writes an `AuditEvent`, so the action is
 *       attributable — the reason the raw SQL was replaced;
 *   (e) the immutability trigger is STILL intact after the admin path exists: a
 *       pricing-override UPDATE and a DELETE both still fail. The admin path
 *       works with the trigger, never around it.
 *
 * (e) matters most. The trigger is what makes a quote's `quoteVersion` a correct
 * expiry signal: a dimension's price is a function of (global config version,
 * immutable override). An admin path that weakened it would silently break the
 * guarantee that a quoted price equals the reserved price.
 *
 * **Validates: Requirements 8.5, 9.2, 9.5, 16.5, 19.1, 19.2**
 */
const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const adminUrl = process.env.PARTNER_TEST_DATABASE_ADMIN_URL ?? "";
const hasPostgres = adminUrl.length > 0;

const ADMIN_ID = "44444444-4444-4444-8444-444444444444";
const BASE_PRICE_IDR = 1_000;
/** Global formula: 1000 + 250 fee + ceil(1000*1500/10000)=150 -> ceilTo(1400,50). */
const GLOBAL_RETAIL_IDR = 1_400;
/** Override: 1000 + 500 fee + ceil(1000*3000/10000)=300 -> ceilTo(1800,100). */
const OVERRIDE_RETAIL_IDR = 1_800;

function admin(permissions: readonly string[]): AuthenticatedAdmin {
  return { adminId: ADMIN_ID, permissions, securityVersion: 1 };
}

async function deployFromEmpty(connectionString: string): Promise<void> {
  await execFileAsync(process.execPath, ["scripts/migrate-from-empty.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, PARTNER_MIGRATION_DATABASE_URL: connectionString },
    maxBuffer: 10 * 1024 * 1024,
  });
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
): Promise<Supply> {
  const partnerId = randomUUID();
  await client.partner.create({
    data: {
      id: partnerId,
      legalName: "Admin Catalog Legal",
      displayName: "Admin Catalog Partner",
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
      basePriceIdr: BASE_PRICE_IDR,
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

function reserveCommand(filter: InventoryFilter): ReserveCommandInput {
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
  };
}

function errorCode(result: ReserveResult): string | null {
  return "error" in result.body ? result.body.error.code : null;
}

interface DimensionRow {
  readonly enabled: boolean;
  readonly fixedFeeIdr: number | null;
  readonly markupBps: number | null;
  readonly note: string | null;
}

/** Read one dimension row directly, bypassing the service under test. */
async function readDimension(
  client: PartnerDatabaseClient,
  dimension: InventoryFilter,
): Promise<DimensionRow | undefined> {
  const rows = await client.$queryRaw<DimensionRow[]>`
    SELECT "enabled", "fixedFeeIdr", "markupBps", "note"
    FROM "catalog_dimensions"
    WHERE "serviceCode" = ${dimension.serviceCode}
      AND "countryCode" = ${dimension.countryCode}
      AND "operatorCode" = ${dimension.operatorCode}
  `;
  return rows[0];
}

/** The audit events written for one dimension target, newest first. */
async function readAuditEvents(client: PartnerDatabaseClient, targetId: string) {
  return client.auditEvent.findMany({
    where: { targetType: "catalog_dimension", targetId },
    orderBy: { createdAt: "desc" },
  });
}

// ---------------------------------------------------------------------------
describe.runIf(hasPostgres)("Admin catalog dimension management integration", () => {
  let database: DisposableTestDatabase;
  let client: PartnerDatabaseClient;
  let catalog: AdminCatalogDimensionService;
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

    catalog = new AdminCatalogDimensionService({
      gateway: new PrismaAdminCatalogDimensionGateway(client),
      clock: new SystemClock(),
      idGenerator: new CryptoIdGenerator(),
    });
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

  // (a) The capability the admin path exists for: an operator declares a
  // dimension through an authorised command, and it becomes sellable — no raw
  // SQL, and the same end-to-end result the hand-written INSERT produced.
  describe("Declaring a dimension makes it reservable end to end", () => {
    it("declares, quotes, and reserves a new dimension with no overrides", async () => {
      const declared: InventoryFilter = { serviceCode: "wa", countryCode: "ID", operatorCode: "any" };

      const outcome = await catalog.declareDimension({
        admin: admin(["config:admin"]),
        ...declared,
        enabled: true,
        note: "dimensi MVP",
        reason: "buka penjualan WhatsApp",
        requestId: randomUUID(),
      });
      expect(outcome).toEqual({ ok: true, dimension: "wa/ID/any" });

      // Persisted exactly as declared, with NULL overrides = inherit the global.
      const row = await readDimension(client, declared);
      expect(row).toMatchObject({
        enabled: true,
        fixedFeeIdr: null,
        markupBps: null,
        note: "dimensi MVP",
      });

      const supply = await seedEligibleSupply(client, declared);

      // The buyer-facing quote prices from the global config formula.
      const quote = await inventory.queryInventory({ filter: declared });
      expect(quote.ok).toBe(true);
      if (!quote.ok) throw new Error("expected a quote");
      expect(quote.quote.available).toBe(true);
      expect(quote.quote.retailPriceIdr).toBe(GLOBAL_RETAIL_IDR);
      expect(quote.quote.quoteVersion).toBe(1);

      // And it reserves, snapshotting that dimension.
      const result = await reservation.reserve(reserveCommand(declared));
      expect(result.statusCode).toBe(200);
      if (!("data" in result.body)) throw new Error("expected a reserved order");
      expect(result.body.data.number).toBe(supply.canonicalNumber);
      expect(result.body.data.snapshot.retailPriceIdr).toBe(GLOBAL_RETAIL_IDR);
      expect(result.body.data.snapshot.serviceCode).toBe("wa");
      expect(result.body.data.snapshot.configVersion).toBe(1);
    });

    it("declares a dimension WITH pricing overrides and reserves at that price", async () => {
      const declared: InventoryFilter = { serviceCode: "tg", countryCode: "ID", operatorCode: "any" };

      const outcome = await catalog.declareDimension({
        admin: admin(["config:admin"]),
        ...declared,
        enabled: true,
        fixedFeeIdr: 500,
        markupBps: 3_000,
        roundToIdr: 100,
        reason: "Telegram lebih mahal",
        requestId: randomUUID(),
      });
      expect(outcome.ok).toBe(true);

      const supply = await seedEligibleSupply(client, declared);
      const result = await reservation.reserve(reserveCommand(declared));
      expect(result.statusCode).toBe(200);
      if (!("data" in result.body)) throw new Error("expected a reserved order");
      expect(result.body.data.number).toBe(supply.canonicalNumber);

      // The immutable snapshot carries THIS dimension's overridden price, and the
      // money path stays zero-sum for it.
      const snapshot = await client.orderSnapshot.findUniqueOrThrow({
        where: { orderId: result.body.data.partnerOrderId },
      });
      expect(snapshot.serviceCode).toBe("tg");
      expect(snapshot.retailPriceIdr).toBe(OVERRIDE_RETAIL_IDR);
      expect(snapshot.payoutIdr).toBe(BASE_PRICE_IDR);
      expect(snapshot.payoutIdr + snapshot.platformMarginIdr).toBe(snapshot.retailPriceIdr);
      // `currency` and `configVersion` remain global, single-sourced on the config.
      expect(snapshot.currency).toBe("IDR");
      expect(snapshot.configVersion).toBe(1);
    });

    it("declares a dimension WITHHELD from sale, which is refused until enabled", async () => {
      const withheld: InventoryFilter = { serviceCode: "ig", countryCode: "ID", operatorCode: "any" };

      const outcome = await catalog.declareDimension({
        admin: admin(["config:admin"]),
        ...withheld,
        enabled: false,
        reason: "siapkan dulu, jangan dijual",
        requestId: randomUUID(),
      });
      expect(outcome.ok).toBe(true);
      expect((await readDimension(client, withheld))?.enabled).toBe(false);

      await seedEligibleSupply(client, withheld);
      const refused = await reservation.reserve(reserveCommand(withheld));
      expect(refused.statusCode).toBe(404);
      expect(errorCode(refused)).toBe("CATALOG_UNAVAILABLE");

      // Enabling it through the admin command makes it sellable.
      const enabled = await catalog.toggleDimension({
        admin: admin(["config:admin"]),
        ...withheld,
        enabled: true,
        reason: "siap dijual",
        requestId: randomUUID(),
      });
      expect(enabled).toEqual({ ok: true, dimension: "ig/ID/any", enabled: true });
      const restored = await reservation.reserve(reserveCommand(withheld));
      expect(restored.statusCode).toBe(200);
    });

    it("refuses to declare without the config:admin permission, writing nothing", async () => {
      const forbidden: InventoryFilter = { serviceCode: "vk", countryCode: "ID", operatorCode: "any" };
      const before = await client.auditEvent.count();

      const outcome = await catalog.declareDimension({
        admin: admin(["resource:admin"]),
        ...forbidden,
        enabled: true,
        reason: "tidak berizin",
        requestId: randomUUID(),
      });
      expect(outcome).toEqual({ ok: false, reason: "forbidden" });

      // No row, and no audit event either.
      expect(await readDimension(client, forbidden)).toBeUndefined();
      expect(await client.auditEvent.count()).toBe(before);
    });
  });

  // (b) The operator's kill switch, through the command rather than raw SQL.
  describe("Toggling a dimension withdraws it from sale and restores it", () => {
    it("stops a reservable dimension with CATALOG_UNAVAILABLE, then restores it", async () => {
      const toggled: InventoryFilter = { serviceCode: "go", countryCode: "ID", operatorCode: "any" };
      await catalog.declareDimension({
        admin: admin(["config:admin"]),
        ...toggled,
        enabled: true,
        reason: "buka penjualan",
        requestId: randomUUID(),
      });

      // Reservable while enabled.
      const first = await seedEligibleSupply(client, toggled);
      const before = await reservation.reserve(reserveCommand(toggled));
      expect(before.statusCode).toBe(200);
      if (!("data" in before.body)) throw new Error("expected a reserved order");
      expect(before.body.data.number).toBe(first.canonicalNumber);

      // Fresh eligible supply, then withdraw the dimension through the command.
      const second = await seedEligibleSupply(client, toggled);
      const withdrawn = await catalog.toggleDimension({
        admin: admin(["config:admin"]),
        ...toggled,
        enabled: false,
        reason: "kualitas nomor buruk",
        requestId: randomUUID(),
      });
      expect(withdrawn).toEqual({ ok: true, dimension: "go/ID/any", enabled: false });

      const ordersBefore = await client.partnerOrder.count();

      // Refused with the PRE-EXISTING error code, and nothing is written.
      const after = await reservation.reserve(reserveCommand(toggled));
      expect(after.statusCode).toBe(404);
      expect(errorCode(after)).toBe("CATALOG_UNAVAILABLE");
      expect(await client.partnerOrder.count()).toBe(ordersBefore);
      const stillAvailable = await client.partnerNumber.findUniqueOrThrow({
        where: { id: second.numberId },
      });
      expect(stillAvailable.status).toBe("AVAILABLE");
      expect(stillAvailable.currentOrderId).toBeNull();

      // The quote agrees...
      expect(await inventory.queryInventory({ filter: toggled })).toEqual({
        ok: false,
        reason: "catalog_mismatch",
      });

      // ...and toggling back on restores reservability.
      const restored = await catalog.toggleDimension({
        admin: admin(["config:admin"]),
        ...toggled,
        enabled: true,
        reason: "supply sudah diperbaiki",
        requestId: randomUUID(),
      });
      expect(restored).toEqual({ ok: true, dimension: "go/ID/any", enabled: true });
      expect(await reservation.reserve(reserveCommand(toggled))).toMatchObject({ statusCode: 200 });
    });

    it("reports an unknown dimension as not_found without writing an audit event", async () => {
      const before = await client.auditEvent.count();
      const outcome = await catalog.toggleDimension({
        admin: admin(["config:admin"]),
        serviceCode: "nope",
        countryCode: "ID",
        operatorCode: "any",
        enabled: false,
        reason: "tidak ada",
        requestId: randomUUID(),
      });
      expect(outcome).toEqual({ ok: false, reason: "not_found", dimension: "nope/ID/any" });
      expect(await client.auditEvent.count()).toBe(before);
    });

    it("refuses to toggle without the config:admin permission", async () => {
      const guarded: InventoryFilter = { serviceCode: "wa", countryCode: "ID", operatorCode: "any" };
      const outcome = await catalog.toggleDimension({
        admin: admin([]),
        ...guarded,
        enabled: false,
        reason: "tidak berizin",
        requestId: randomUUID(),
      });
      expect(outcome).toEqual({ ok: false, reason: "forbidden" });
      // The live dimension is untouched — still on sale.
      expect((await readDimension(client, guarded))?.enabled).toBe(true);
    });
  });

  // (c) The duplicate case that used to be a raw-SQL constraint crash.
  describe("Declaring a duplicate dimension", () => {
    it("is refused cleanly and leaves the existing row untouched", async () => {
      const existing: InventoryFilter = { serviceCode: "tg", countryCode: "ID", operatorCode: "any" };
      const rowBefore = await readDimension(client, existing);
      expect(rowBefore).toBeDefined();
      const auditsBefore = (await readAuditEvents(client, "tg/ID/any")).length;

      const outcome = await catalog.declareDimension({
        admin: admin(["config:admin"]),
        ...existing,
        enabled: true,
        // Deliberately DIFFERENT overrides: a duplicate must never overwrite the
        // frozen price of the row that already exists.
        fixedFeeIdr: 999,
        markupBps: 9_999,
        reason: "coba deklarasi ulang",
        requestId: randomUUID(),
      });
      expect(outcome).toEqual({ ok: false, reason: "duplicate", dimension: "tg/ID/any" });

      // The original pricing override is intact, and no audit event was written
      // for a change that did not happen.
      const rowAfter = await readDimension(client, existing);
      expect(rowAfter?.fixedFeeIdr).toBe(500);
      expect(rowAfter?.markupBps).toBe(3_000);
      expect((await readAuditEvents(client, "tg/ID/any")).length).toBe(auditsBefore);
    });

    it("is refused for a differently-cased country code (same normalised triple)", async () => {
      const outcome = await catalog.declareDimension({
        admin: admin(["config:admin"]),
        serviceCode: "tg",
        countryCode: "id",
        operatorCode: "any",
        enabled: true,
        reason: "huruf kecil",
        requestId: randomUUID(),
      });
      expect(outcome).toEqual({ ok: false, reason: "duplicate", dimension: "tg/ID/any" });
      // Exactly one `tg` row exists — no second row under a different casing.
      const rows = await client.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) AS "count" FROM "catalog_dimensions" WHERE "serviceCode" = 'tg'
      `;
      expect(Number(rows[0].count)).toBe(1);
    });

    it("rejects an invalid dimension before reaching the database", async () => {
      const outcome = await catalog.declareDimension({
        admin: admin(["config:admin"]),
        serviceCode: "fb",
        // Not ISO-2, and `roundToIdr` must be > 0 — both would violate a CHECK.
        countryCode: "IDN",
        operatorCode: "any",
        enabled: true,
        roundToIdr: 0,
        reason: "input salah",
        requestId: randomUUID(),
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok && outcome.reason === "invalid_dimension") {
        expect(outcome.violations.map((violation) => violation.code)).toEqual([
          "INVALID_COUNTRY_CODE",
          "INVALID_PRICE_OVERRIDE",
        ]);
      } else {
        throw new Error("expected invalid_dimension");
      }
      // Nothing was inserted under either casing.
      const rows = await client.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) AS "count" FROM "catalog_dimensions" WHERE "serviceCode" = 'fb'
      `;
      expect(Number(rows[0].count)).toBe(0);
    });
  });

  // (d) The reason the raw SQL was replaced: the action becomes attributable.
  describe("Every accepted command is audited", () => {
    it("writes a complete audit event for a declare and for each toggle", async () => {
      const audited: InventoryFilter = { serviceCode: "ok", countryCode: "ID", operatorCode: "any" };
      const declareRequestId = randomUUID();

      await catalog.declareDimension({
        admin: admin(["config:admin"]),
        ...audited,
        enabled: true,
        fixedFeeIdr: 300,
        reason: "audit declare",
        requestId: declareRequestId,
      });
      await catalog.toggleDimension({
        admin: admin(["config:admin"]),
        ...audited,
        enabled: false,
        reason: "audit toggle off",
        requestId: randomUUID(),
      });
      await catalog.toggleDimension({
        admin: admin(["config:admin"]),
        ...audited,
        enabled: true,
        reason: "audit toggle on",
        requestId: randomUUID(),
      });

      const events = await readAuditEvents(client, "ok/ID/any");
      expect(events).toHaveLength(3);

      for (const event of events) {
        expect(event.actorType).toBe("PARTNER_ADMIN");
        expect(event.action).toBe("config.changed");
        expect(event.targetType).toBe("catalog_dimension");
        expect(event.result).toBe("SUCCEEDED");
        // The raw admin id is never stored — only its SHA-256 hash.
        expect(event.actorRefHash).toHaveLength(64);
        expect(event.actorRefHash).not.toContain(ADMIN_ID);
        expect(event.requestId).not.toBeNull();
      }

      const declareEvent = events.find((event) => event.requestId === declareRequestId);
      expect(declareEvent).toBeDefined();
      expect(declareEvent?.safeMetadataJson).toMatchObject({
        operation: "declare",
        reason: "audit declare",
        enabled: true,
        fixedFeeIdr: 300,
      });

      const toggleMetadata = events
        .filter((event) => event.requestId !== declareRequestId)
        .map((event) => event.safeMetadataJson);
      expect(toggleMetadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: "toggle", enabled: false }),
          expect.objectContaining({ operation: "toggle", enabled: true }),
        ]),
      );
    });

    it("commits the row and its audit event atomically", async () => {
      // One declare, one audit event — never a dimension on sale with no record
      // of who put it there.
      const atomic: InventoryFilter = { serviceCode: "at", countryCode: "ID", operatorCode: "any" };
      await catalog.declareDimension({
        admin: admin(["config:admin"]),
        ...atomic,
        enabled: true,
        reason: "atomic",
        requestId: randomUUID(),
      });
      expect(await readDimension(client, atomic)).toBeDefined();
      expect(await readAuditEvents(client, "at/ID/any")).toHaveLength(1);
    });
  });

  // (e) The most important assertion: the admin path did NOT weaken the trigger.
  // A dimension's price must stay immutable so `quoteVersion` (the global config
  // version) remains a correct expiry signal.
  describe("The immutability trigger is still intact", () => {
    it("still refuses a pricing-override UPDATE and a DELETE after the admin path exists", async () => {
      const frozen: InventoryFilter = { serviceCode: "fr", countryCode: "ID", operatorCode: "any" };
      await catalog.declareDimension({
        admin: admin(["config:admin"]),
        ...frozen,
        enabled: true,
        markupBps: 2_000,
        reason: "harga beku",
        requestId: randomUUID(),
      });

      // A price change is refused...
      await expect(
        client.$executeRawUnsafe(
          `UPDATE "catalog_dimensions" SET "markupBps" = 9999 WHERE "serviceCode" = 'fr'`,
        ),
      ).rejects.toThrow();
      // ...so is re-pointing the dimension at another triple...
      await expect(
        client.$executeRawUnsafe(
          `UPDATE "catalog_dimensions" SET "serviceCode" = 'fr2' WHERE "serviceCode" = 'fr'`,
        ),
      ).rejects.toThrow();
      // ...and so is erasing it from the record.
      await expect(
        client.$executeRawUnsafe(`DELETE FROM "catalog_dimensions" WHERE "serviceCode" = 'fr'`),
      ).rejects.toThrow();

      // The override is intact, and the one permitted mutation still works
      // through the admin command.
      const toggled = await catalog.toggleDimension({
        admin: admin(["config:admin"]),
        ...frozen,
        enabled: false,
        reason: "tarik",
        requestId: randomUUID(),
      });
      expect(toggled.ok).toBe(true);
      const row = await readDimension(client, frozen);
      expect(row?.markupBps).toBe(2_000);
      expect(row?.enabled).toBe(false);
    });

    it("keeps the declared price frozen across a toggle cycle", async () => {
      // The property `quoteVersion` soundness depends on: a dimension's price is
      // a function of (global config version, immutable override), so cycling
      // `enabled` can never move the price.
      const cycled: InventoryFilter = { serviceCode: "cy", countryCode: "ID", operatorCode: "any" };
      await catalog.declareDimension({
        admin: admin(["config:admin"]),
        ...cycled,
        enabled: true,
        fixedFeeIdr: 500,
        markupBps: 3_000,
        roundToIdr: 100,
        reason: "harga tetap",
        requestId: randomUUID(),
      });

      for (const enabled of [false, true, false, true]) {
        const outcome = await catalog.toggleDimension({
          admin: admin(["config:admin"]),
          ...cycled,
          enabled,
          reason: `siklus ${String(enabled)}`,
          requestId: randomUUID(),
        });
        expect(outcome.ok).toBe(true);
      }

      const row = await readDimension(client, cycled);
      expect(row?.fixedFeeIdr).toBe(500);
      expect(row?.markupBps).toBe(3_000);
      expect(row?.enabled).toBe(true);

      // And it still reserves at exactly the declared override price.
      await seedEligibleSupply(client, cycled);
      const result = await reservation.reserve(reserveCommand(cycled));
      expect(result.statusCode).toBe(200);
      if (!("data" in result.body)) throw new Error("expected a reserved order");
      expect(result.body.data.snapshot.retailPriceIdr).toBe(OVERRIDE_RETAIL_IDR);
    });
  });

  // The read view an operator actually looks at before withdrawing something.
  describe("The read view lists what is sold, with offer counts", () => {
    it("shows enabled state, override/inherited pricing, and live offer counts", async () => {
      const listed = await catalog.listDimensions();
      expect(listed.length).toBeGreaterThan(0);

      // The MVP dimension inherits everything from the global config and has the
      // supply seeded by the earlier scenarios attached to it.
      const mvp = listed.find((dimension) => dimension.serviceCode === "wa");
      expect(mvp).toBeDefined();
      expect(mvp?.enabled).toBe(true);
      expect(mvp?.overridden).toEqual({
        minBasePriceIdr: false,
        maxBasePriceIdr: false,
        fixedFeeIdr: false,
        markupBps: false,
        roundToIdr: false,
      });
      // An operator about to withdraw it can see it still has live offers.
      expect(mvp?.offerCount).toBeGreaterThan(0);
      expect(mvp?.activeOfferCount).toBeGreaterThan(0);

      // The overridden dimension reports exactly which inputs it overrides.
      const telegram = listed.find((dimension) => dimension.serviceCode === "tg");
      expect(telegram?.overridden).toMatchObject({
        fixedFeeIdr: true,
        markupBps: true,
        roundToIdr: true,
        minBasePriceIdr: false,
      });

      // A withdrawn dimension is still listed, so it is discoverable.
      const withdrawn = listed.find((dimension) => dimension.serviceCode === "fr");
      expect(withdrawn?.enabled).toBe(false);

      // Sorted by the dimension triple, so the screen is stable between loads.
      const keys = listed.map((dimension) => dimension.serviceCode);
      expect(keys).toEqual([...keys].sort());
    });

    it("counts a dimension with no offers as zero rather than omitting it", async () => {
      const empty: InventoryFilter = { serviceCode: "zz", countryCode: "ID", operatorCode: "any" };
      await catalog.declareDimension({
        admin: admin(["config:admin"]),
        ...empty,
        enabled: true,
        reason: "belum ada supply",
        requestId: randomUUID(),
      });

      const listed = await catalog.listDimensions();
      const row = listed.find((dimension) => dimension.serviceCode === "zz");
      expect(row).toBeDefined();
      expect(row?.offerCount).toBe(0);
      expect(row?.activeOfferCount).toBe(0);
    });
  });
});
