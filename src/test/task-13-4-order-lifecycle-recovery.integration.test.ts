import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  OrderTransitionService,
  type TerminalResult,
} from "@application/orders";
import { SmsIngestionService } from "@application/sms";
import { ReservationRecoveryJob } from "@application/cron-jobs";
import { IdempotencyEngine } from "@application/internal-api";

import {
  createPartnerDatabaseClient,
  PrismaIdempotencyStore,
  PrismaIdempotencyTransactionRunner,
  PrismaOrderOperationsGateway,
  PrismaPartnerSmsGateway,
  PrismaPartnerSmsMatchingGateway,
  PrismaReservationRecoveryGateway,
  type PartnerDatabaseClient,
  type PartnerTransactionClient,
} from "@infrastructure/database";
import { SmsOtpCipher } from "@infrastructure/crypto/sms-otp-cipher";

import {
  createDisposableTestDatabase,
  type DisposableTestDatabase,
} from "./disposable-database";

/**
 * Task 13.4 — end-to-end order lifecycle + crash-recovery integration tests.
 *
 * These exercise the real order transition service (task 9.4), the SMS
 * success/earning/ledger transaction (task 13.3), and the reservation-recovery
 * cron job (task 16.2) against a disposable PostgreSQL database, wiring the
 * production Prisma gateways, the real `$transaction` idempotency engine, and
 * the AES-256-GCM SMS/OTP cipher — no in-memory fakes. Each scenario asserts
 * both the returned outcome and the committed rows, so the compare-and-set
 * transitions, the terminal-conflict guards, the number-release dispositions,
 * and the crash/restart idempotency guarantees hold together on real storage.
 *
 * Orders are seeded directly into their `reserved`/`waiting_sms` states (as the
 * task 12.4 SMS suite does) rather than through the Internal API reserve path,
 * so the lifecycle/recovery rules are tested independently of the reserve
 * command wiring. A simulated crash between reserve and activation is exactly a
 * `reserved` order stranded past the recovery window; a crash between SMS
 * receipt and success is exactly a re-delivered SMS after the success
 * transaction — both are reproduced here.
 *
 * **Validates: Requirements 12.2, 12.3, 12.4, 12.5, 12.6, 20.2**
 */
const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const adminUrl = process.env.PARTNER_TEST_DATABASE_ADMIN_URL ?? "";
const hasPostgres = adminUrl.length > 0;

/** A deterministic test AES key/version for the SMS/OTP envelope. */
const CIPHER_KEY_VERSION = 5;
const cipher = new SmsOtpCipher({
  current: { version: CIPHER_KEY_VERSION, key: Buffer.alloc(32, 0x5c).toString("base64url") },
});

const MVP_PAYOUT_IDR = 1_000;
const OTP = "123456";
const MATCHING_BODY = `Your WhatsApp code is ${OTP}`;
const SENDER = "WhatsAppBusiness";

/** A real-time clock; every service and the recovery job share it. */
const clock = { nowEpochMs: () => Date.now() };
const idGenerator = { uuid: () => randomUUID() };

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
 * A freshly wired set of order-lifecycle services bound to the shared
 * disposable database: the task 9.4 transition service (cancel/timeout/fail via
 * the real idempotency engine), the task 13.3 SMS success pipeline, and the
 * task 16.2 reservation-recovery job — all through the production Prisma
 * gateways and one real interactive transaction.
 */
function createServices(client: PartnerDatabaseClient) {
  const idempotency = new IdempotencyEngine<PartnerTransactionClient>({
    store: new PrismaIdempotencyStore(),
    runner: new PrismaIdempotencyTransactionRunner(client),
    clock,
  });
  const transition = new OrderTransitionService<PartnerTransactionClient>({
    idempotency,
    gateway: new PrismaOrderOperationsGateway(client),
    clock,
  });
  const sms = new SmsIngestionService<PartnerTransactionClient>({
    runner: new PrismaIdempotencyTransactionRunner(client),
    smsGateway: new PrismaPartnerSmsGateway(),
    matchingGateway: new PrismaPartnerSmsMatchingGateway(),
    cipher,
    clock,
    idGenerator,
  });
  const recovery = new ReservationRecoveryJob({
    gateway: new PrismaReservationRecoveryGateway(client),
    clock,
  });
  return { transition, sms, recovery };
}

type Services = ReturnType<typeof createServices>;

// ---------------------------------------------------------------------------
// Fixture seeding (raw client): an approved partner, a device (online/offline),
// an active offer, a number, and orders in specific lifecycle states.
// ---------------------------------------------------------------------------
async function createApprovedPartner(client: PartnerDatabaseClient): Promise<string> {
  const id = randomUUID();
  await client.partner.create({
    data: {
      id,
      legalName: "Lifecycle Integration Legal",
      displayName: "Lifecycle Integration Partner",
      status: "APPROVED",
      simulatorAllowed: true,
    },
  });
  return id;
}

async function createDevice(
  client: PartnerDatabaseClient,
  partnerId: string,
  options: { readonly online: boolean } = { online: true },
): Promise<string> {
  const id = randomUUID();
  await client.partnerDevice.create({
    data: {
      id,
      partnerId,
      type: "SIMULATOR",
      label: "Sim",
      // An online device with a fresh heartbeat releases a number back to
      // `available`; an offline device (stale heartbeat) releases it to
      // `offline` (requirement 12.6).
      effectiveStatus: options.online ? "ONLINE" : "OFFLINE",
      lastSeenAt: options.online ? new Date() : new Date(Date.now() - 10 * 60_000),
      capabilitiesJson: { sms: true, notification: false, resend: false, operator: null, slots: 1 },
    },
  });
  return id;
}

async function createActiveOffer(client: PartnerDatabaseClient, partnerId: string): Promise<string> {
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

/** Approved partner + device + active offer + one registered number. */
async function seedSupply(
  client: PartnerDatabaseClient,
  options: { readonly deviceOnline?: boolean; readonly numberStatus?: "AVAILABLE" | "RESERVED" | "BUSY" } = {},
): Promise<Supply> {
  const partnerId = await createApprovedPartner(client);
  const deviceId = await createDevice(client, partnerId, { online: options.deviceOnline ?? true });
  const offerId = await createActiveOffer(client, partnerId);
  const numberId = randomUUID();
  const canonicalNumber = uniqueCanonicalNumber();
  await client.partnerNumber.create({
    data: {
      id: numberId,
      partnerId,
      deviceId,
      canonicalNumber,
      activeCanonicalNumber: canonicalNumber,
      countryCode: "ID",
      operatorCode: "any",
      status: options.numberStatus ?? "BUSY",
      enabled: true,
    },
  });
  return { partnerId, deviceId, offerId, numberId, canonicalNumber };
}

/** Immutable reserve-time snapshot (base 1000 -> retail 1400, payout 1000). */
async function seedSnapshot(client: PartnerDatabaseClient, orderId: string, canonicalNumber: string): Promise<void> {
  await client.orderSnapshot.create({
    data: {
      orderId,
      serviceCode: "wa",
      countryCode: "ID",
      operatorCode: "any",
      canonicalNumber,
      basePriceIdr: MVP_PAYOUT_IDR,
      retailPriceIdr: 1_400,
      payoutIdr: MVP_PAYOUT_IDR,
      platformMarginIdr: 400,
      currency: "IDR",
      configVersion: 1,
    },
  });
}

/**
 * A `waiting_sms` order on the supply's number, whose match window contains
 * now. The number is bound `busy` to the order so the success compare-and-set
 * (and the number release) can fire. `expiresInPast` seeds an already-expired
 * order for the timeout scenarios.
 */
async function seedWaitingOrder(
  client: PartnerDatabaseClient,
  supply: Supply,
  options: { readonly expiresInPast?: boolean } = {},
): Promise<string> {
  const orderId = randomUUID();
  const now = Date.now();
  await client.partnerOrder.create({
    data: {
      id: orderId,
      buyerOrderRef: `buyer-${orderId}`,
      buyerAccountRef: `acct-${randomUUID()}`,
      partnerId: supply.partnerId,
      numberId: supply.numberId,
      offerId: supply.offerId,
      status: "WAITING_SMS",
      // createdAt precedes expiresAt even when the order is already expired, so
      // the partner_orders_expiry_check (expiresAt > createdAt) holds; the row
      // is created 3 min in the past, before reservedAt.
      createdAt: new Date(now - 180_000),
      reservedAt: new Date(now - 120_000),
      waitingAt: new Date(now - 60_000),
      expiresAt: new Date(options.expiresInPast ? now - 60_000 : now + 20 * 60_000),
      version: 1,
    },
  });
  await seedSnapshot(client, orderId, supply.canonicalNumber);
  await client.partnerNumber.update({
    where: { id: supply.numberId },
    data: { currentOrderId: orderId, status: "BUSY" },
  });
  return orderId;
}

/**
 * A reservation stranded in `reserved` past the 30s recovery window — exactly
 * the state a crash between the reserve commit and the activation leaves
 * (design section 3). The number is `reserved` and bound to the order.
 */
async function seedStuckReservation(client: PartnerDatabaseClient, supply: Supply): Promise<string> {
  const orderId = randomUUID();
  const now = Date.now();
  await client.partnerOrder.create({
    data: {
      id: orderId,
      buyerOrderRef: `buyer-${orderId}`,
      buyerAccountRef: `acct-${randomUUID()}`,
      partnerId: supply.partnerId,
      numberId: supply.numberId,
      offerId: supply.offerId,
      status: "RESERVED",
      // Older than the 30s recovery window so the job picks it up.
      reservedAt: new Date(now - 60_000),
      expiresAt: new Date(now + 20 * 60_000),
      version: 1,
    },
  });
  await seedSnapshot(client, orderId, supply.canonicalNumber);
  await client.partnerNumber.update({
    where: { id: supply.numberId },
    data: { currentOrderId: orderId, status: "RESERVED" },
  });
  return orderId;
}

function cancelInput(orderId: string, overrides: Record<string, unknown> = {}) {
  return {
    orderId,
    principalId: "main-service",
    idempotencyKey: randomUUID(),
    method: "POST",
    path: `/api/internal/v1/orders/${orderId}/cancel`,
    reason: "BUYER_CANCEL",
    actorRef: "main-actor",
    ...overrides,
  } as Parameters<OrderTransitionService<PartnerTransactionClient>["cancel"]>[0];
}

function timeoutInput(orderId: string, observedAtEpochMs: number, overrides: Record<string, unknown> = {}) {
  return {
    orderId,
    principalId: "cron:order-timeout",
    idempotencyKey: randomUUID(),
    method: "POST",
    path: `/api/internal/v1/orders/${orderId}/timeout`,
    observedAtEpochMs,
    reason: "ORDER_TIMEOUT",
    ...overrides,
  } as Parameters<OrderTransitionService<PartnerTransactionClient>["timeout"]>[0];
}

async function ingestMatchingSms(
  services: Services,
  supply: Supply,
  overrides: { readonly messageId?: string; readonly idempotencyKey?: string } = {},
) {
  return services.sms.ingest({
    principal: { partnerId: supply.partnerId, deviceId: supply.deviceId },
    numberId: supply.numberId,
    messageId: overrides.messageId ?? randomUUID(),
    idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
    sender: SENDER,
    body: MATCHING_BODY,
    receivedAtDeviceEpochMs: Date.now() - 2_000,
  });
}

function terminalData(result: TerminalResult) {
  if (!("data" in result.body)) throw new Error(`expected terminal data, got ${JSON.stringify(result.body)}`);
  return result.body.data;
}

function terminalError(result: TerminalResult) {
  if (!("error" in result.body)) throw new Error("expected terminal error");
  return result.body.error;
}

// ---------------------------------------------------------------------------
describe.runIf(hasPostgres)("Order lifecycle and crash recovery integration (task 13.4)", () => {
  let database: DisposableTestDatabase;
  let client: PartnerDatabaseClient;
  let services: Services;

  beforeAll(async () => {
    database = await createDisposableTestDatabase(adminUrl);
    await deployFromEmpty(database.connectionString);
    client = createPartnerDatabaseClient({ databaseUrl: database.connectionString });
    await client.$connect();
    await client.platformConfig.create({ data: platformConfigData(1, "mvp-active") });
    services = createServices(client);
  }, 120_000);

  afterAll(async () => {
    await client?.$disconnect();
    await database?.dispose();
  }, 30_000);

  // Requirement 12.4: a cancel is only valid after the configured minimum age
  // (3 minutes). A freshly-created waiting order cannot be cancelled yet.
  describe("Cancel before the minimum age is rejected", () => {
    it("refuses a cancel younger than 3 minutes and leaves the order waiting", async () => {
      const supply = await seedSupply(client);
      const orderId = await seedWaitingOrder(client, supply);

      const result = await services.transition.cancel(cancelInput(orderId));

      expect(result.statusCode).toBe(422);
      expect(terminalError(result).code).toBe("CANCEL_NOT_ALLOWED");
      // Nothing moved: the order is still waiting and the number still busy.
      const order = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe("WAITING_SMS");
      expect(order.terminalAt).toBeNull();
      const number = await client.partnerNumber.findUniqueOrThrow({ where: { id: supply.numberId } });
      expect(number.status).toBe("BUSY");
      expect(number.currentOrderId).toBe(orderId);
      // No terminal transition was recorded.
      const transitions = await client.orderTransition.count({ where: { orderId } });
      expect(transitions).toBe(0);
    });
  });

  // Requirements 12.3, 12.6: once an order succeeds (OTP received) it is
  // terminal; a subsequent cancel is a terminal conflict and never creates a
  // second money effect (the single Earning + ledger event are untouched).
  describe("Success then cancel is a terminal conflict with no second money effect", () => {
    it("succeeds via a matching SMS, then rejects a cancel as a terminal conflict", async () => {
      const supply = await seedSupply(client);
      const orderId = await seedWaitingOrder(client, supply);

      const matched = await ingestMatchingSms(services, supply);
      expect(matched.status).toBe("matched");
      if (matched.status === "matched") expect(matched.orderId).toBe(orderId);

      // Exactly one pending Earning and one zero-sum order-success ledger event.
      const earningsAfterSuccess = await client.partnerEarning.findMany({ where: { orderId } });
      expect(earningsAfterSuccess).toHaveLength(1);
      expect(earningsAfterSuccess[0].amountIdr).toBe(MVP_PAYOUT_IDR);
      expect(earningsAfterSuccess[0].status).toBe("PENDING");

      const cancel = await services.transition.cancel(cancelInput(orderId));
      expect(cancel.statusCode).toBe(422);
      expect(terminalError(cancel).code).toBe("TERMINAL_STATE_CONFLICT");

      // The order stays SUCCESS and the money effect is unchanged (no second
      // Earning, still exactly one order-success ledger transaction).
      const order = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe("SUCCESS");
      const earnings = await client.partnerEarning.count({ where: { orderId } });
      expect(earnings).toBe(1);
      const ledger = await client.ledgerTransaction.count({
        where: { eventKey: `order-success:${orderId}` },
      });
      expect(ledger).toBe(1);
    });
  });

  // Requirements 12.5, 12.6: a timeout past expiry drives the order to
  // `timeout` and releases the number. With the device offline the release
  // disposition is `offline`, not `available`.
  describe("Timeout while the device is offline releases the number to offline", () => {
    it("times out an expired waiting order and parks the number offline", async () => {
      const supply = await seedSupply(client, { deviceOnline: false });
      const orderId = await seedWaitingOrder(client, supply, { expiresInPast: true });

      const result = await services.transition.timeout(timeoutInput(orderId, Date.now()));

      expect(result.statusCode).toBe(200);
      const data = terminalData(result);
      expect(data.status).toBe("timeout");
      expect(data.releaseDisposition).toBe("offline");

      const order = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe("TIMEOUT");
      expect(order.terminalReason).toBe("ORDER_TIMEOUT");
      const number = await client.partnerNumber.findUniqueOrThrow({ where: { id: supply.numberId } });
      expect(number.status).toBe("OFFLINE");
      expect(number.currentOrderId).toBeNull();
      // No earning is ever created for a non-success terminal.
      expect(await client.partnerEarning.count({ where: { orderId } })).toBe(0);
    });
  });

  // Requirements 12.5, 12.6, 20.2: retrying the same terminal operation replays
  // the first result (already-reached state, no second write), while a
  // *different* terminal transition is a conflict — neither adds a money effect.
  describe("Terminal retry replays; a different terminal is a conflict", () => {
    it("replays an idempotent timeout retry and rejects a later cancel", async () => {
      const supply = await seedSupply(client);
      const orderId = await seedWaitingOrder(client, supply, { expiresInPast: true });
      const observedAt = Date.now();
      const key = randomUUID();

      const first = await services.transition.timeout(timeoutInput(orderId, observedAt, { idempotencyKey: key }));
      expect(first.statusCode).toBe(200);
      expect(terminalData(first).status).toBe("timeout");

      // Same key + identical payload -> replayed verbatim, effect ran once.
      const replay = await services.transition.timeout(timeoutInput(orderId, observedAt, { idempotencyKey: key }));
      expect(replay).toEqual(first);

      // A different terminal (cancel) on the now-terminal order is a conflict.
      const cancel = await services.transition.cancel(cancelInput(orderId));
      expect(cancel.statusCode).toBe(422);
      expect(terminalError(cancel).code).toBe("TERMINAL_STATE_CONFLICT");

      // The terminal write and its number release each happened exactly once.
      const order = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe("TIMEOUT");
      expect(order.version).toBe(2); // one increment from the single timeout write
      const transitions = await client.orderTransition.count({ where: { orderId } });
      expect(transitions).toBe(1);
      const number = await client.partnerNumber.findUniqueOrThrow({ where: { id: supply.numberId } });
      expect(number.status).toBe("AVAILABLE");
      expect(number.currentOrderId).toBeNull();
      const numberHistory = await client.numberStateHistory.count({
        where: { numberId: supply.numberId, toStatus: "AVAILABLE" },
      });
      expect(numberHistory).toBe(1);
      expect(await client.partnerEarning.count({ where: { orderId } })).toBe(0);
    });
  });

  // Requirements 12.5, 20.5: the order-timeout cron keeps a constant
  // Idempotency-Key per order but re-observes `now` on every ~1-minute run. The
  // observed instant must not be part of the idempotency payload, or the second
  // run under a moved clock would collide on the key with a different request
  // hash and be rejected as IDEMPOTENCY_CONFLICT forever — the order could never
  // be timed out. This proves the re-run replays the first terminal result.
  describe("A cron timeout re-run under a moved clock replays, never poisons the key", () => {
    it("replays a same-key timeout whose observed instant moved on a later run", async () => {
      const supply = await seedSupply(client);
      const orderId = await seedWaitingOrder(client, supply, { expiresInPast: true });
      const key = randomUUID();
      const firstObservedAt = Date.now();

      const first = await services.transition.timeout(
        timeoutInput(orderId, firstObservedAt, { idempotencyKey: key }),
      );
      expect(first.statusCode).toBe(200);
      expect(terminalData(first).status).toBe("timeout");

      // The next cron run: SAME key, later observed instant. This must replay
      // the first result verbatim, not surface an IDEMPOTENCY_CONFLICT.
      const rerun = await services.transition.timeout(
        timeoutInput(orderId, firstObservedAt + 60_000, { idempotencyKey: key }),
      );
      expect(rerun.statusCode).toBe(200);
      expect(rerun).toEqual(first);

      // The terminal effect and its number release each happened exactly once.
      const order = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe("TIMEOUT");
      expect(order.version).toBe(2); // a single timeout write, not two
      const transitions = await client.orderTransition.count({ where: { orderId } });
      expect(transitions).toBe(1);
    });
  });

  // Requirements 12.2, 20.2: a crash between the reserve commit and activation
  // strands an order in `reserved`. The reservation-recovery job promotes a
  // still-valid one to `waiting_sms`/`busy`; re-running it (process restart)
  // never relocates the order or duplicates its assignment.
  describe("Crash between reserve and activation is recovered idempotently", () => {
    it("promotes a still-valid stranded reservation to waiting_sms and re-runs as a no-op", async () => {
      const supply = await seedSupply(client, { numberStatus: "RESERVED" });
      const orderId = await seedStuckReservation(client, supply);

      const first = await services.recovery.runBatch({ cursor: null, nowEpochMs: Date.now() });
      expect(first.processed).toBe(1);

      // Activation completed: order waiting_sms, number busy + still bound.
      const order = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe("WAITING_SMS");
      expect(order.waitingAt).not.toBeNull();
      const number = await client.partnerNumber.findUniqueOrThrow({ where: { id: supply.numberId } });
      expect(number.status).toBe("BUSY");
      expect(number.currentOrderId).toBe(orderId);

      // A restart re-run finds nothing stuck and never double-writes history.
      const second = await services.recovery.runBatch({ cursor: null, nowEpochMs: Date.now() });
      expect(second.processed).toBe(0);
      const promotes = await client.orderTransition.count({
        where: { orderId, reason: "reservation_recovery_promote" },
      });
      expect(promotes).toBe(1);
      // Exactly one waiting order still holds the number — no duplicate assignment.
      const active = await client.partnerOrder.count({
        where: { numberId: supply.numberId, status: "WAITING_SMS" },
      });
      expect(active).toBe(1);
    });

    it("releases a stranded reservation whose device is offline, freeing the number offline", async () => {
      const supply = await seedSupply(client, { deviceOnline: false, numberStatus: "RESERVED" });
      const orderId = await seedStuckReservation(client, supply);

      const result = await services.recovery.runBatch({ cursor: null, nowEpochMs: Date.now() });
      expect(result.processed).toBe(1);

      const order = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe("CANCELLED");
      expect(order.terminalReason).toBe("reservation_recovery_release");
      const number = await client.partnerNumber.findUniqueOrThrow({ where: { id: supply.numberId } });
      expect(number.status).toBe("OFFLINE");
      expect(number.currentOrderId).toBeNull();
      // No earning is created by a release.
      expect(await client.partnerEarning.count({ where: { orderId } })).toBe(0);
    });
  });

  // Requirements 12.3, 20.2: a crash between the SMS receipt and the success
  // commit is recovered by re-delivering the SMS. The success is exactly-once —
  // a re-ingest is a duplicate and never produces a second Earning/ledger event.
  describe("Crash between SMS receipt and success is recovered idempotently", () => {
    it("re-delivering the same SMS never double-succeeds or double-earns", async () => {
      const supply = await seedSupply(client);
      const orderId = await seedWaitingOrder(client, supply);
      const messageId = randomUUID();

      const first = await ingestMatchingSms(services, supply, { messageId });
      expect(first.status).toBe("matched");

      // A retry of the same messageId (process restart / redelivery) is a
      // duplicate and does not re-run the success effect.
      const replay = await ingestMatchingSms(services, supply, { messageId });
      expect(replay).toEqual({ status: "duplicate", matchedBy: "message_id" });

      // Exactly-once: one SUCCESS order, one pending Earning, one ledger event.
      const order = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe("SUCCESS");
      expect(await client.partnerEarning.count({ where: { orderId } })).toBe(1);
      const ledger = await client.ledgerTransaction.count({
        where: { eventKey: `order-success:${orderId}` },
      });
      expect(ledger).toBe(1);
      // Only one SMS row was persisted for the redelivered message.
      const rows = await client.partnerSms.count({
        where: { deviceId: supply.deviceId, messageId },
      });
      expect(rows).toBe(1);
    });
  });

  // Requirement 20.2: re-running the same operations after a restart never
  // duplicates an order assignment or an Earning — the terminal transition, the
  // recovery promotion, and the SMS success are all exactly-once together.
  describe("Re-running the same operation never duplicates assignment or Earning", () => {
    it("keeps the full success flow exactly-once across repeated invocations", async () => {
      const supply = await seedSupply(client, { numberStatus: "RESERVED" });
      const orderId = await seedStuckReservation(client, supply);

      // Recover (promote) twice — the second run is a no-op.
      await services.recovery.runBatch({ cursor: null, nowEpochMs: Date.now() });
      await services.recovery.runBatch({ cursor: null, nowEpochMs: Date.now() });

      // Succeed via SMS, then re-deliver the SMS.
      const messageId = randomUUID();
      const idempotencyKey = randomUUID();
      const success = await ingestMatchingSms(services, supply, { messageId, idempotencyKey });
      expect(success.status).toBe("matched");
      const dup = await ingestMatchingSms(services, supply, { messageId, idempotencyKey });
      expect(dup.status).toBe("duplicate");

      // Exactly one order assignment and one Earning survive the repetition.
      const orders = await client.partnerOrder.count({
        where: { numberId: supply.numberId, buyerOrderRef: `buyer-${orderId}` },
      });
      expect(orders).toBe(1);
      const earnings = await client.partnerEarning.findMany({ where: { partnerId: supply.partnerId } });
      expect(earnings).toHaveLength(1);
      expect(earnings[0].orderId).toBe(orderId);
      const promotes = await client.orderTransition.count({
        where: { orderId, reason: "reservation_recovery_promote" },
      });
      expect(promotes).toBe(1);
    });
  });
});
