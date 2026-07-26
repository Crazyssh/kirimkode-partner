import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { InventoryFilter } from "@domain/task-5-2-device-inventory-pricing";
import { decidePlutoPolicy } from "@domain/task-5-3/private-beta-policy";
import type { AuthenticatedPrincipal } from "@domain/task-7-2";
import { PAYOUT_REVIEW_PERMISSION, type AuthenticatedAdmin } from "@domain/task-7-5";
import {
  holdReleaseEventKey,
  orderSuccessEventKey,
  payoutLockEventKey,
  payoutPaidEventKey,
} from "@domain/task-5-6";

import { IdempotencyEngine, type IdempotencyStore } from "@application/internal-api";
import {
  ReservationService,
  OrderStatusService,
  OrderTransitionService,
  type ReserveCommandInput,
  type ReserveResult,
} from "@application/orders";
import { SmsIngestionService } from "@application/sms";
import { EarningLifecycleService } from "@application/ledger";
import {
  PayoutDestinationService,
  PayoutRequestService,
  PayoutReviewService,
} from "@application/payouts";
import { toSessionContext, type SessionContext } from "@application/authorization/session-context";
import { CronBatchRunner, type BatchJob } from "@application/cron";
import { ReconcileJob } from "@application/cron-jobs";

import {
  createPartnerDatabaseClient,
  PrismaEarningProjectionRepository,
  PrismaIdempotencyStore,
  PrismaIdempotencyTransactionRunner,
  PrismaJobLeaseRepository,
  PrismaLedgerRepository,
  PrismaOrderOperationsGateway,
  PrismaPartnerSmsGateway,
  PrismaPartnerSmsMatchingGateway,
  PrismaPayoutDestinationGateway,
  PrismaPayoutMinimumReader,
  PrismaPayoutRequestGateway,
  PrismaPayoutReviewGateway,
  PrismaReconciliationGateway,
  PrismaReconciliationIssueRepository,
  PrismaReservationGateway,
  PrismaUnitOfWork,
  type PartnerDatabaseClient,
  type PartnerTransactionClient,
} from "@infrastructure/database";
import { SmsOtpCipher } from "@infrastructure/crypto/sms-otp-cipher";
import { CryptoIdGenerator } from "@infrastructure/auth/system-clock";

import {
  createDisposableTestDatabase,
  type DisposableTestDatabase,
} from "./disposable-database";

/**
 * Task 17.6 — the flagship end-to-end private-beta integration test.
 *
 * This drives the whole MVP acceptance flow (design "Sasaran MVP") through the
 * REAL application services and Prisma gateways against a disposable PostgreSQL
 * database migrated from empty — no in-memory fakes for any step:
 *
 *   1. Seed one APPROVED partner + owner member + payout-review admin, an online
 *      simulator device, one `+62` number, and an active `wa/ID/any` offer at
 *      base Rp1.000 (retail Rp1.400, payout Rp1.000). The buyer allowlist gate
 *      is exercised through the real {@link decidePlutoPolicy} so the private
 *      beta admits the allowlisted buyer whose `buyerAccountRef`/`buyerOrderRef`
 *      then flow into the reservation (requirements 17.4, 23.1).
 *   2. Reserve via the Internal API reserve path ({@link ReservationService}):
 *      order → `waiting_sms`, number → busy, one immutable snapshot (23.2).
 *   3. Submit a WhatsApp OTP SMS through the ingestion pipeline
 *      ({@link SmsIngestionService}): order → success, encrypted OTP stored,
 *      exactly one PENDING Earning at Rp1.000, a zero-sum `order-success`
 *      ledger event — and the number stays BUSY, still bound to the order,
 *      because the settled order keeps *listening* for a repeat code (17.2, 23.3).
 *   4. Read the OTP back through the status/decrypt path
 *      ({@link OrderStatusService}) and prove raw SMS is never surfaced.
 *   5. Submit a SECOND WhatsApp SMS on the same number while the window is open:
 *      it matches the SAME order in `repeat` mode and only refreshes the OTP —
 *      no status change, no second Earning, no second ledger event (11.7, 13.7).
 *   6. Close the listening window through the buyer-completion command
 *      ({@link OrderTransitionService.complete}): `completedAt` is stamped, the
 *      number returns to AVAILABLE and unbound, the order stays `success`, and
 *      the Earning is untouched. A repeated completion is idempotent (12.4, 12.6).
 *   7. Advance the clock 24h and run the earning-release command
 *      ({@link EarningLifecycleService}): Earning → available.
 *   8. Request a payout of Rp1.000 (create destination + request payout): the
 *      Earning locks, the ledger moves available → locked.
 *   9. Admin approves → processing → paid with a unique payment reference:
 *      Earning → paid, ledger locked → paid.
 *  10. Run the reconciler ({@link ReconcileJob}) and assert ZERO issues — the
 *      whole flow is internally consistent, the hold having been released in
 *      step 6 — and that the ledger nets to zero with the money resting in
 *      `partner_paid` (Rp1.000) (23.3, 20.6).
 *
 * A single {@link MutableClock} anchored at wall-clock time drives every
 * service, so the DB-default `receivedAtServer` on the inbound SMS falls inside
 * the freshly-reserved order window, while the 24h hold can still be fast-
 * forwarded deterministically.
 *
 * **Validates: Requirements 17.2, 17.4, 17.5, 23.1, 23.2, 23.3**
 */
const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const adminUrl = process.env.PARTNER_TEST_DATABASE_ADMIN_URL ?? "";
const hasPostgres = adminUrl.length > 0;

/** The single MVP catalog dimension the seeded config serves. */
const MVP_FILTER: InventoryFilter = { serviceCode: "wa", countryCode: "ID", operatorCode: "any" };
/** base 1000 -> retail ceilTo(1000 + 250 + ceil(1000*1500/10000), 50) = 1400. */
const BASE_PRICE_IDR = 1_000;
const RETAIL_PRICE_IDR = 1_400;
const PAYOUT_IDR = 1_000;
const PLATFORM_MARGIN_IDR = 400;
const HOLD_PERIOD_MS = 24 * 60 * 60 * 1000;

// A verbatim real-world WhatsApp Business verification SMS: the code arrives
// in the dashed wire format (`718-891`) and the parser normalizes it to the
// six-digit OTP, so this E2E run proves the real format end-to-end.
const OTP = "718891";
const SMS_BODY = [
  "Akun WhatsApp Business Anda sedang didaftarkan di perangkat baru",
  "",
  "Jangan bagikan kode dengan siapa pun",
  "Kode WhatsApp Business Anda: 718-891",
  "rJbA/XP1K+V",
].join("\n");
const SMS_SENDER = "WhatsAppBusiness";

// The resend WhatsApp routinely issues when the buyer taps "kirim ulang": the
// same message shape carrying a DIFFERENT code. It is the whole point of the
// listening window — the second code must reach the same order rather than a
// number that was already put back on sale.
const REPEAT_OTP = "204653";
const REPEAT_SMS_BODY = [
  "Akun WhatsApp Business Anda sedang didaftarkan di perangkat baru",
  "",
  "Jangan bagikan kode dengan siapa pun",
  "Kode WhatsApp Business Anda: 204-653",
  "hQ2c/Nm8R+T",
].join("\n");

/** A deterministic test AES key/version for the SMS/OTP + destination envelope. */
const CIPHER_KEY_VERSION = 5;
const cipher = new SmsOtpCipher({
  current: { version: CIPHER_KEY_VERSION, key: Buffer.alloc(32, 0x2a).toString("base64url") },
});

const idGenerator = { uuid: () => randomUUID() };

/** A test-controllable clock satisfying every application `Clock` port. */
class MutableClock {
  private current: number;

  constructor(startEpochMs: number) {
    this.current = startEpochMs;
  }

  nowEpochMs(): number {
    return this.current;
  }

  nowDate(): Date {
    return new Date(this.current);
  }

  set(epochMs: number): void {
    this.current = epochMs;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

async function deployFromEmpty(connectionString: string): Promise<void> {
  await execFileAsync(process.execPath, ["scripts/migrate-from-empty.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, PARTNER_MIGRATION_DATABASE_URL: connectionString },
    maxBuffer: 10 * 1024 * 1024,
  });
}

/** The immutable MVP platform config the whole flow reads (mirrors seed.sql). */
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
    activeFrom: new Date(Date.UTC(2020, 0, 1, 0, 0, 0)),
  };
}

/**
 * A freshly wired set of the REAL application services bound to the shared
 * disposable database and a single injectable clock — mirroring the production
 * composition roots but with a test clock so the 24h hold can be advanced.
 */
function createServices(client: PartnerDatabaseClient, clock: MutableClock) {
  const runner = new PrismaIdempotencyTransactionRunner(client);
  const ledger = new PrismaLedgerRepository(client);
  const earnings = new PrismaEarningProjectionRepository(client);
  const reconciliation = new PrismaReconciliationIssueRepository();
  const unitOfWork = new PrismaUnitOfWork(client);

  // Reserve path (Internal API v1) over the task 9.2 idempotency engine.
  const store: IdempotencyStore<PartnerTransactionClient> = new PrismaIdempotencyStore();
  const idempotency = new IdempotencyEngine<PartnerTransactionClient>({
    store,
    runner,
    clock,
  });
  const reservation = new ReservationService<PartnerTransactionClient>({
    idempotency,
    gateway: new PrismaReservationGateway(),
    clock,
    idGenerator: new CryptoIdGenerator(),
  });

  // SMS ingestion pipeline.
  const sms = new SmsIngestionService<PartnerTransactionClient>({
    runner,
    smsGateway: new PrismaPartnerSmsGateway(),
    matchingGateway: new PrismaPartnerSmsMatchingGateway(),
    cipher,
    clock,
    idGenerator: new CryptoIdGenerator(),
  });

  // Status / OTP decrypt read path (the cipher IS the real OtpDecryptor) and the
  // task 9.4 transition service, which owns buyer completion — the command that
  // closes a listening window and releases the number hold. Both sit on one
  // gateway instance, and completion shares the reserve path's idempotency
  // engine + clock so a replayed completion is replayed, not re-applied.
  const operations = new PrismaOrderOperationsGateway(client);
  const status = new OrderStatusService({
    gateway: operations,
    otpDecryptor: cipher,
  });
  const transition = new OrderTransitionService<PartnerTransactionClient>({
    idempotency,
    gateway: operations,
    clock,
  });

  // Ledger + payout stack.
  const earningLifecycle = new EarningLifecycleService<PartnerTransactionClient>({
    runner,
    ledger,
    earnings,
    reconciliation,
    clock,
    idGenerator,
  });
  const destinations = new PayoutDestinationService({
    gateway: new PrismaPayoutDestinationGateway(unitOfWork),
    cipher,
    clock,
    idGenerator,
  });
  const requests = new PayoutRequestService<PartnerTransactionClient>({
    runner,
    ledger,
    earnings,
    payouts: new PrismaPayoutRequestGateway(client),
    minimum: new PrismaPayoutMinimumReader(client),
    cipher,
    clock,
    idGenerator,
  });
  const reviews = new PayoutReviewService<PartnerTransactionClient>({
    runner,
    ledger,
    earnings,
    payouts: new PrismaPayoutReviewGateway(client),
    clock,
    idGenerator,
  });

  return {
    clock,
    ledger,
    reservation,
    sms,
    status,
    transition,
    earningLifecycle,
    destinations,
    requests,
    reviews,
  };
}

// ---------------------------------------------------------------------------
// Cron plumbing for the real reconcile job.
// ---------------------------------------------------------------------------
function makeRunner(client: PartnerDatabaseClient, clock: MutableClock): CronBatchRunner {
  return new CronBatchRunner({
    leases: new PrismaJobLeaseRepository(client),
    clock,
    ownerIdFactory: () => randomUUID(),
  });
}

/** Run a job through the runner until its backlog drains. */
async function runToCompletion(runner: CronBatchRunner, job: BatchJob): Promise<void> {
  for (let guard = 0; guard < 50; guard += 1) {
    const result = await runner.run(job);
    if (result.status === "completed" && result.drained) return;
  }
  throw new Error(`Job ${job.name} did not drain`);
}

// ---------------------------------------------------------------------------
// Fixture seeding (raw client): the full approved-partner supply, an owner
// member (payout requester), and a payout-review admin.
// ---------------------------------------------------------------------------
function uniqueCanonicalNumber(): string {
  // Canonical rule: `+628` then a NON-ZERO digit, then 8 more. Drawing the
  // first digit from 0-9 produced `+6280…` roughly one run in ten, which the
  // domain rightly rejects — a self-inflicted flake, not a product bug.
  let digits = String(randomInt(1, 10));
  for (let i = 0; i < 8; i += 1) digits += String(randomInt(0, 10));
  return `+628${digits}`;
}

function ownerContext(partnerId: string, memberId: string): SessionContext {
  const principal: AuthenticatedPrincipal = {
    memberId,
    partnerId,
    role: "owner",
    securityVersion: 1,
  };
  return toSessionContext(principal);
}

interface Supply {
  readonly partnerId: string;
  readonly memberId: string;
  readonly caller: SessionContext;
  readonly deviceId: string;
  readonly offerId: string;
  readonly numberId: string;
  readonly canonicalNumber: string;
}

/**
 * An APPROVED partner + owner member, an ONLINE simulator device with a fresh
 * heartbeat, one active `wa/ID/any` offer at base Rp1.000, and one `available`
 * `+62` number — everything the reserve path needs to succeed.
 */
async function seedApprovedSupply(client: PartnerDatabaseClient, clock: MutableClock): Promise<Supply> {
  const partnerId = randomUUID();
  await client.partner.create({
    data: {
      id: partnerId,
      legalName: "Private Beta E2E Legal",
      displayName: "Private Beta E2E Partner",
      status: "APPROVED",
      simulatorAllowed: true,
    },
  });

  const memberId = randomUUID();
  await client.partnerMember.create({
    data: {
      id: memberId,
      partnerId,
      emailNormalized: `owner-${memberId}@example.test`,
      passwordHash: "argon2id$placeholder$hash",
      role: "OWNER",
      status: "ACTIVE",
      emailVerifiedAt: clock.nowDate(),
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
      lastSeenAt: clock.nowDate(),
      capabilitiesJson: { sms: true, notification: false, resend: false, operator: null, slots: 1 },
    },
  });

  const offerId = randomUUID();
  await client.partnerOffer.create({
    data: {
      id: offerId,
      partnerId,
      serviceCode: "wa",
      countryCode: "ID",
      operatorCode: "any",
      basePriceIdr: BASE_PRICE_IDR,
      status: "ACTIVE",
      configVersion: 1,
      activeDimensionKey: `${partnerId}:wa:ID:any`,
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
      countryCode: "ID",
      operatorCode: "any",
      status: "AVAILABLE",
      enabled: true,
    },
  });

  return {
    partnerId,
    memberId,
    caller: ownerContext(partnerId, memberId),
    deviceId,
    offerId,
    numberId,
    canonicalNumber,
  };
}

/** A global Partner Admin holding the payout:review permission. */
async function seedAdmin(client: PartnerDatabaseClient): Promise<AuthenticatedAdmin> {
  const adminId = randomUUID();
  await client.partnerAdmin.create({
    data: {
      id: adminId,
      emailNormalized: `admin-${adminId}@example.test`,
      passwordHash: "argon2id$placeholder$hash",
      permissions: [PAYOUT_REVIEW_PERMISSION],
      status: "ACTIVE",
    },
  });
  return { adminId, permissions: [PAYOUT_REVIEW_PERMISSION], securityVersion: 1 };
}

function reserveCommand(buyerOrderRef: string, buyerAccountRef: string): ReserveCommandInput {
  return {
    principalId: "main-platform-client",
    idempotencyKey: `reserve-${randomUUID()}`,
    method: "POST",
    path: "/api/internal/v1/orders/reserve",
    request: { buyerOrderRef, buyerAccountRef, filter: MVP_FILTER, quoteVersion: 1 },
  };
}

// ---------------------------------------------------------------------------
describe.runIf(hasPostgres)("Private beta full-flow E2E integration (task 17.6)", () => {
  let database: DisposableTestDatabase;
  let client: PartnerDatabaseClient;

  beforeAll(async () => {
    database = await createDisposableTestDatabase(adminUrl);
    await deployFromEmpty(database.connectionString);
    client = createPartnerDatabaseClient({ databaseUrl: database.connectionString });
    await client.$connect();
    await client.platformConfig.create({ data: platformConfigData(1, "mvp-active") });
  }, 120_000);

  afterAll(async () => {
    await client?.$disconnect();
    await database?.dispose();
  }, 30_000);

  it("drives inventory -> reserve -> SMS -> OTP -> repeat OTP -> complete -> hold -> payout -> paid -> zero-issue reconciliation", async () => {
    // Anchor the clock at wall-clock time so the reserve order window contains
    // the DB-default `receivedAtServer` of the inbound SMS, while still allowing
    // the 24h hold to be advanced deterministically.
    const clock = new MutableClock(Date.now());
    const services = createServices(client, clock);
    const supply = await seedApprovedSupply(client, clock);
    const admin = await seedAdmin(client);

    // -------------------------------------------------------------------
    // 1. Buyer allowlist gating (private beta): the Partner side receives the
    //    buyer refs; the real policy admits the allowlisted buyer (Req 17.4).
    // -------------------------------------------------------------------
    const buyerAccountRef = `acct-${randomUUID()}`;
    const buyerOrderRef = `buyer-${randomUUID()}`;
    const allowlisted = decidePlutoPolicy({
      operation: "purchase",
      buyerAccountRef,
      partnerSupplyEnabled: true,
      allowlistedBuyerAccountRefs: [buyerAccountRef],
      existingPlutoOrder: false,
    });
    expect(allowlisted).toEqual({ allowed: true, reason: "PRIVATE_BETA_ELIGIBLE" });
    // A buyer outside the allowlist is refused — the gate really gates.
    expect(
      decidePlutoPolicy({
        operation: "purchase",
        buyerAccountRef: `acct-${randomUUID()}`,
        partnerSupplyEnabled: true,
        allowlistedBuyerAccountRefs: [buyerAccountRef],
        existingPlutoOrder: false,
      }).allowed,
    ).toBe(false);

    // -------------------------------------------------------------------
    // 2. Reserve via the Internal API reserve path (Req 23.2).
    // -------------------------------------------------------------------
    const reserved: ReserveResult = await services.reservation.reserve(
      reserveCommand(buyerOrderRef, buyerAccountRef),
    );
    expect(reserved.statusCode).toBe(200);
    if (!("data" in reserved.body)) throw new Error("reserve did not succeed");
    const view = reserved.body.data;
    const orderId = view.partnerOrderId;
    expect(view.status).toBe("waiting_sms");
    expect(view.number).toBe(supply.canonicalNumber);
    expect(view.snapshot.retailPriceIdr).toBe(RETAIL_PRICE_IDR);
    expect(view.snapshot.payoutIdr).toBe(PAYOUT_IDR);

    // Order is waiting_sms and carries the buyer refs; number is busy + bound.
    const orderAfterReserve = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(orderAfterReserve.status).toBe("WAITING_SMS");
    expect(orderAfterReserve.buyerOrderRef).toBe(buyerOrderRef);
    expect(orderAfterReserve.buyerAccountRef).toBe(buyerAccountRef);
    const numberAfterReserve = await client.partnerNumber.findUniqueOrThrow({
      where: { id: supply.numberId },
    });
    expect(numberAfterReserve.status).toBe("BUSY");
    expect(numberAfterReserve.currentOrderId).toBe(orderId);
    // Exactly one immutable snapshot at the authoritative pricing.
    const snapshot = await client.orderSnapshot.findUniqueOrThrow({ where: { orderId } });
    expect(snapshot.basePriceIdr).toBe(BASE_PRICE_IDR);
    expect(snapshot.retailPriceIdr).toBe(RETAIL_PRICE_IDR);
    expect(snapshot.payoutIdr).toBe(PAYOUT_IDR);
    expect(snapshot.platformMarginIdr).toBe(PLATFORM_MARGIN_IDR);

    // -------------------------------------------------------------------
    // 3. Submit the WhatsApp OTP SMS -> success + earning + ledger (Req 17.2).
    // -------------------------------------------------------------------
    const ingestion = await services.sms.ingest({
      principal: { partnerId: supply.partnerId, deviceId: supply.deviceId },
      numberId: supply.numberId,
      messageId: randomUUID(),
      idempotencyKey: randomUUID(),
      sender: SMS_SENDER,
      body: SMS_BODY,
      receivedAtDeviceEpochMs: clock.nowEpochMs() - 1_000,
    });
    expect(ingestion.status).toBe("matched");
    if (ingestion.status !== "matched") throw new Error("SMS did not match");
    expect(ingestion.orderId).toBe(orderId);
    // The outcome view never leaks the raw OTP or SMS text.
    const ingestionSerialized = JSON.stringify(ingestion);
    expect(ingestionSerialized).not.toContain(OTP);
    expect(ingestionSerialized).not.toContain("WhatsApp");

    // Order is success with an encrypted OTP (never plaintext) at the key version.
    const successOrder = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(successOrder.status).toBe("SUCCESS");
    expect(successOrder.otpKeyVersion).toBe(CIPHER_KEY_VERSION);
    expect(successOrder.otpFingerprint).toBe(cipher.fingerprint(OTP));
    const otpBytes = Buffer.from(successOrder.otpCiphertext ?? Buffer.alloc(0));
    expect(otpBytes.length).toBeGreaterThan(0);
    expect(otpBytes.toString("utf8")).not.toContain(OTP);

    // The persisted SMS row is ciphertext-only (never the plaintext body/OTP).
    const smsRow = await client.partnerSms.findUniqueOrThrow({ where: { id: ingestion.sms.id } });
    expect(smsRow.matchStatus).toBe("MATCHED");
    expect(smsRow.matchedOrderId).toBe(orderId);
    expect(Buffer.from(smsRow.bodyCiphertext).toString("utf8")).not.toContain(OTP);
    expect(Buffer.from(smsRow.bodyCiphertext).toString("utf8")).not.toContain("WhatsApp");

    // Exactly one PENDING Earning at the snapshot payout.
    const earnings = await client.partnerEarning.findMany({ where: { orderId } });
    expect(earnings).toHaveLength(1);
    const earningId = earnings[0].id;
    expect(earnings[0].amountIdr).toBe(PAYOUT_IDR);
    expect(earnings[0].status).toBe("PENDING");

    // A zero-sum order-success ledger event.
    const successLedger = await client.ledgerTransaction.findFirstOrThrow({
      where: { eventKey: orderSuccessEventKey(orderId) },
      include: { entries: true },
    });
    expect(successLedger.entries).toHaveLength(2);
    expect(successLedger.entries.reduce((t, e) => t + e.amountIdrSigned, 0)).toBe(0);

    // The number hold is NOT released by success. The money settled exactly once
    // (the single Earning + zero-sum event above), but the order goes on
    // *listening*: `completedAt` is unset and the number stays BUSY and bound to
    // the order, so a resent code still reaches this buyer and the number cannot
    // be resold underneath an SMS that is still in flight.
    expect(successOrder.completedAt).toBeNull();
    const heldNumber = await client.partnerNumber.findUniqueOrThrow({
      where: { id: supply.numberId },
    });
    expect(heldNumber.status).toBe("BUSY");
    expect(heldNumber.currentOrderId).toBe(orderId);

    // -------------------------------------------------------------------
    // 4. Read the OTP back through the status/decrypt path (Req 11.6/17.5).
    // -------------------------------------------------------------------
    const statusResult = await services.status.getStatus({ orderId });
    expect(statusResult.statusCode).toBe(200);
    if (!("data" in statusResult.body)) throw new Error("status did not return data");
    expect(statusResult.body.data.status).toBe("success");
    expect(statusResult.body.data.otp).toBe(OTP);
    // The status path only ever touches the order's own OTP — never raw SMS.
    expect(JSON.stringify(statusResult.body.data)).not.toContain("WhatsApp");

    // -------------------------------------------------------------------
    // 5. A repeat OTP inside the open window refreshes the code only (Req 11.7,
    //    13.7). This is what the listening window buys: WhatsApp resends, and
    //    the second code must land on the SAME order — with no money moving,
    //    since an Earning is created exactly once per order.
    // -------------------------------------------------------------------
    const repeatIngestion = await services.sms.ingest({
      principal: { partnerId: supply.partnerId, deviceId: supply.deviceId },
      numberId: supply.numberId,
      // A genuinely distinct message: same device, new messageId + idempotency
      // key, so neither unique constraint short-circuits it as a `duplicate`.
      messageId: randomUUID(),
      idempotencyKey: randomUUID(),
      sender: SMS_SENDER,
      body: REPEAT_SMS_BODY,
      receivedAtDeviceEpochMs: clock.nowEpochMs() - 500,
    });
    expect(repeatIngestion.status).toBe("matched");
    if (repeatIngestion.status !== "matched") throw new Error("repeat SMS did not match");
    expect(repeatIngestion.orderId).toBe(orderId);
    expect(repeatIngestion.mode).toBe("repeat");

    // The buyer now reads the NEWER code through the same status path.
    const refreshedStatus = await services.status.getStatus({ orderId });
    if (!("data" in refreshedStatus.body)) throw new Error("status did not return data");
    expect(refreshedStatus.body.data.otp).toBe(REPEAT_OTP);
    expect(refreshedStatus.body.data.status).toBe("success");

    // Status unchanged, hold still open, and the money side is untouched:
    // still exactly ONE Earning at the same amount and still exactly ONE
    // `order-success` ledger transaction.
    const orderAfterRepeat = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(orderAfterRepeat.status).toBe("SUCCESS");
    expect(orderAfterRepeat.completedAt).toBeNull();
    expect(orderAfterRepeat.otpFingerprint).toBe(cipher.fingerprint(REPEAT_OTP));
    const earningsAfterRepeat = await client.partnerEarning.findMany({ where: { orderId } });
    expect(earningsAfterRepeat).toHaveLength(1);
    expect(earningsAfterRepeat[0].id).toBe(earningId);
    expect(earningsAfterRepeat[0].amountIdr).toBe(PAYOUT_IDR);
    expect(earningsAfterRepeat[0].status).toBe("PENDING");
    expect(
      await client.ledgerTransaction.count({ where: { eventKey: orderSuccessEventKey(orderId) } }),
    ).toBe(1);

    // -------------------------------------------------------------------
    // 6. Buyer completion closes the listening window (Req 12.4, 12.6): the
    //    hold — not the status — ends. `completedAt` is stamped and the number
    //    goes back on sale; no money moves, because it already settled.
    // -------------------------------------------------------------------
    const completed = await services.transition.complete({
      orderId,
      principalId: "main-platform-client",
      idempotencyKey: `complete-${randomUUID()}`,
      method: "POST",
      path: `/api/internal/v1/orders/${orderId}/complete`,
      trigger: "buyer_complete",
      actorRef: "main-actor",
    });
    expect(completed.statusCode).toBe(200);
    if (!("data" in completed.body)) throw new Error("completion did not succeed");
    expect(completed.body.data.status).toBe("success");
    // The device is still beating (the clock has not moved yet), so the released
    // number returns to `available` rather than `offline`.
    expect(completed.body.data.releaseDisposition).toBe("available");

    const completedOrder = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(completedOrder.status).toBe("SUCCESS");
    expect(completedOrder.completedAt).not.toBeNull();
    const completedAtMs = completedOrder.completedAt?.getTime() ?? 0;
    const releasedNumber = await client.partnerNumber.findUniqueOrThrow({
      where: { id: supply.numberId },
    });
    expect(releasedNumber.status).toBe("AVAILABLE");
    expect(releasedNumber.currentOrderId).toBeNull();
    // Completion is not a money event: the Earning is exactly as success left it.
    const earningAfterComplete = await client.partnerEarning.findMany({ where: { orderId } });
    expect(earningAfterComplete).toHaveLength(1);
    expect(earningAfterComplete[0].id).toBe(earningId);
    expect(earningAfterComplete[0].amountIdr).toBe(PAYOUT_IDR);
    expect(earningAfterComplete[0].status).toBe("PENDING");

    // A second completion under a FRESH idempotency key bypasses the engine's
    // replay and re-enters the effect, where the already-stamped `completedAt`
    // makes the release decision a no-op: success reported, nothing changed. That
    // is what keeps the buyer and the expiry sweep from releasing a hold twice.
    const recompleted = await services.transition.complete({
      orderId,
      principalId: "main-platform-client",
      idempotencyKey: `complete-${randomUUID()}`,
      method: "POST",
      path: `/api/internal/v1/orders/${orderId}/complete`,
      trigger: "buyer_complete",
      actorRef: "main-actor",
    });
    expect(recompleted.statusCode).toBe(200);
    if (!("data" in recompleted.body)) throw new Error("second completion did not succeed");
    expect(recompleted.body.data.completedAt).toBe(new Date(completedAtMs).toISOString());
    const afterRecomplete = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(afterRecomplete.completedAt?.getTime()).toBe(completedAtMs);
    expect(afterRecomplete.status).toBe("SUCCESS");
    expect(await client.partnerEarning.count({ where: { orderId } })).toBe(1);

    // -------------------------------------------------------------------
    // 7. Advance the clock 24h and release the earning hold (Req 13.4).
    // -------------------------------------------------------------------
    clock.advance(HOLD_PERIOD_MS + 5 * 60_000);
    const released = await services.earningLifecycle.releaseHold({
      partnerId: supply.partnerId,
      earningId,
    });
    expect(released.kind).toBe("released");
    const availableEarning = await client.partnerEarning.findUniqueOrThrow({ where: { id: earningId } });
    expect(availableEarning.status).toBe("AVAILABLE");
    const holdReleases = await client.ledgerTransaction.count({
      where: { eventKey: holdReleaseEventKey(earningId) },
    });
    expect(holdReleases).toBe(1);
    let balances = await services.ledger.computeBucketBalances(supply.partnerId);
    expect(balances.partner_pending).toBe(0);
    expect(balances.partner_available).toBe(PAYOUT_IDR);

    // -------------------------------------------------------------------
    // 8. Request a payout of Rp1.000 -> Earning locked, ledger available->locked
    //    (Req 14.1, 14.2, 23.3).
    // -------------------------------------------------------------------
    const destination = await services.destinations.createDestination({
      caller: supply.caller,
      bankCode: "BCA",
      accountNumber: "1234567890",
      accountHolderName: "Private Beta E2E Partner",
      requestId: randomUUID(),
    });
    if (!destination.ok) throw new Error(`destination creation failed: ${destination.reason}`);

    const payoutRequest = await services.requests.requestPayout({
      caller: supply.caller,
      destinationId: destination.destination.id,
      earningIds: [earningId],
      requestId: randomUUID(),
    });
    if (!payoutRequest.ok) throw new Error("payout request failed");
    const payoutId = payoutRequest.payout.id;
    expect(payoutRequest.payout.amountIdr).toBe(PAYOUT_IDR);

    const lockedEarning = await client.partnerEarning.findUniqueOrThrow({ where: { id: earningId } });
    expect(lockedEarning.status).toBe("REQUESTED");
    const lockEvents = await client.ledgerTransaction.count({
      where: { eventKey: payoutLockEventKey(payoutId) },
    });
    expect(lockEvents).toBe(1);
    balances = await services.ledger.computeBucketBalances(supply.partnerId);
    expect(balances.partner_available).toBe(0);
    expect(balances.partner_payout_locked).toBe(PAYOUT_IDR);

    // -------------------------------------------------------------------
    // 9. Admin approves -> processing -> paid with a unique reference (Req 14.4).
    // -------------------------------------------------------------------
    expect((await services.reviews.approve({ admin, payoutId, requestId: randomUUID() })).ok).toBe(true);
    expect(
      (await services.reviews.markProcessing({ admin, payoutId, requestId: randomUUID() })).ok,
    ).toBe(true);
    const paymentReference = `PAY-${payoutId}`;
    const paid = await services.reviews.markPaid({
      admin,
      payoutId,
      paymentReference,
      requestId: randomUUID(),
    });
    expect(paid.ok).toBe(true);

    const paidPayout = await client.partnerPayout.findUniqueOrThrow({ where: { id: payoutId } });
    expect(paidPayout.status).toBe("PAID");
    expect(paidPayout.paymentReference).toBe(paymentReference);
    expect(paidPayout.paidAt).not.toBeNull();
    const paidEarning = await client.partnerEarning.findUniqueOrThrow({ where: { id: earningId } });
    expect(paidEarning.status).toBe("PAID");
    const paidEvents = await client.ledgerTransaction.count({
      where: { eventKey: payoutPaidEventKey(payoutId) },
    });
    expect(paidEvents).toBe(1);

    // -------------------------------------------------------------------
    // 10. Reconcile -> ZERO issues, and the ledger nets to zero with the money
    //     resting in partner_paid (Req 23.3, 20.6). The reconciler sees a
    //     consistent projection because step 6 released the hold: the number is
    //     available with no active order, and the completed order claims none.
    // -------------------------------------------------------------------
    // The simulator keeps beating; refresh the heartbeat so the still-ONLINE
    // device is not (correctly) flagged stale after the 24h fast-forward.
    await client.partnerDevice.update({
      where: { id: supply.deviceId },
      data: { lastSeenAt: clock.nowDate() },
    });

    const reconcile = new ReconcileJob({
      gateway: new PrismaReconciliationGateway(client),
      clock,
    });
    await runToCompletion(makeRunner(client, clock), reconcile);

    const issues = await client.reconciliationIssue.count();
    expect(issues).toBe(0);

    // Final per-bucket balances: payable -1000, paid +1000, everything else 0,
    // and the whole ledger nets to zero.
    balances = await services.ledger.computeBucketBalances(supply.partnerId);
    expect(balances.platform_partner_payable).toBe(-PAYOUT_IDR);
    expect(balances.partner_pending).toBe(0);
    expect(balances.partner_available).toBe(0);
    expect(balances.partner_payout_locked).toBe(0);
    expect(balances.partner_paid).toBe(PAYOUT_IDR);
    expect(balances.partner_reversed).toBe(0);
    expect(Object.values(balances).reduce((t, v) => t + v, 0)).toBe(0);
  }, 30_000);
});
