import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedPrincipal } from "@domain/task-7-2";
import { PAYOUT_REVIEW_PERMISSION, type AuthenticatedAdmin } from "@domain/task-7-5";
import {
  createTransferTransaction,
  earningReversalEventKey,
  holdReleaseEventKey,
  orderSuccessEventKey,
  payoutLockEventKey,
  payoutPaidEventKey,
  payoutUnlockEventKey,
  type LedgerTransaction,
} from "@domain/task-5-6";

import { EarningLifecycleService } from "@application/ledger";
import {
  PayoutDestinationService,
  PayoutRequestService,
  PayoutReviewService,
} from "@application/payouts";
import { toSessionContext, type SessionContext } from "@application/authorization/session-context";

import {
  createPartnerDatabaseClient,
  PrismaEarningProjectionRepository,
  PrismaIdempotencyTransactionRunner,
  PrismaLedgerRepository,
  PrismaPayoutDestinationGateway,
  PrismaPayoutMinimumReader,
  PrismaPayoutRequestGateway,
  PrismaPayoutReviewGateway,
  PrismaReconciliationIssueRepository,
  PrismaUnitOfWork,
  type PartnerDatabaseClient,
  type PartnerTransactionClient,
} from "@infrastructure/database";
import { SmsOtpCipher } from "@infrastructure/crypto/sms-otp-cipher";

import {
  createDisposableTestDatabase,
  type DisposableTestDatabase,
} from "./disposable-database";

/**
 * Task 14.5 — end-to-end ledger + payout concurrency integration tests.
 *
 * These exercise the real task 14.1–14.4 financial stack against a disposable
 * PostgreSQL database, wiring the production Prisma repositories/gateways
 * ({@link PrismaLedgerRepository}, {@link PrismaEarningProjectionRepository},
 * {@link PrismaPayoutRequestGateway}, {@link PrismaPayoutReviewGateway},
 * {@link PrismaPayoutDestinationGateway}, {@link PrismaReconciliationIssueRepository})
 * and the real interactive `$transaction` runner — no in-memory fakes. Every
 * invariant the unit/property suites pin (zero-sum ledger, SUM-per-bucket
 * balances, idempotent event keys, compare-and-set projection advances,
 * whole-earning allocation, exactly-once locking, idempotent unlock, unique
 * payment reference) is re-verified through the whole stack and against the
 * committed rows, so the real constraints, transactions, and tenant scoping hold
 * together on real storage.
 *
 * Concurrency is driven with `Promise.all` against the real database so the CAS
 * + unique-constraint backstops are exercised under genuine transaction races.
 *
 * **Validates: Requirements 13.4, 13.5, 13.6, 13.7, 14.1, 14.2, 14.5, 14.6**
 */
const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const adminUrl = process.env.PARTNER_TEST_DATABASE_ADMIN_URL ?? "";
const hasPostgres = adminUrl.length > 0;

/** A deterministic test AES key/version for the destination-snapshot envelope. */
const CIPHER_KEY_VERSION = 4;
const cipher = new SmsOtpCipher({
  current: { version: CIPHER_KEY_VERSION, key: Buffer.alloc(32, 0x3b).toString("base64url") },
});

/** The single MVP payout amount (base price Rp1.000). */
const MVP_PAYOUT_IDR = 1_000;
/** Default hold period the seeded config serves (24h). */
const HOLD_PERIOD_MS = 24 * 60 * 60 * 1000;
/** Deterministic anchor well after the seeded config's `activeFrom`. */
const BASE_EPOCH_MS = Date.UTC(2026, 7, 1, 12, 0, 0);

const idGenerator = { uuid: () => randomUUID() };

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

  advance(ms: number): void {
    this.current += ms;
  }
}

/** Simulated process crash used to prove a settlement transaction is atomic. */
class SimulatedCrashError extends Error {
  constructor() {
    super("simulated crash between lock and paid");
    this.name = "SimulatedCrashError";
  }
}

/**
 * Wraps a real transaction runner and throws AFTER the work completes but before
 * the transaction can commit, forcing PostgreSQL to roll the whole unit back —
 * the durable model of a crash mid-settlement.
 */
class CrashDuringCommitRunner {
  constructor(private readonly inner: PrismaIdempotencyTransactionRunner) {}

  run<T>(work: (tx: PartnerTransactionClient) => Promise<T>): Promise<T> {
    return this.inner.run(async (tx) => {
      await work(tx);
      throw new SimulatedCrashError();
    });
  }
}

async function deployFromEmpty(connectionString: string): Promise<void> {
  await execFileAsync(process.execPath, ["scripts/migrate-from-empty.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, PARTNER_MIGRATION_DATABASE_URL: connectionString },
    maxBuffer: 10 * 1024 * 1024,
  });
}

/** The immutable MVP platform config values (mirrors prisma/seed.sql). */
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
 * A freshly wired set of ledger + payout services bound to the shared disposable
 * database, mirroring the production composition roots (get-payout-services,
 * earning lifecycle) but with an injectable clock.
 */
function createServices(client: PartnerDatabaseClient) {
  const clock = new MutableClock(BASE_EPOCH_MS);
  const runner = new PrismaIdempotencyTransactionRunner(client);
  const ledger = new PrismaLedgerRepository(client);
  const earnings = new PrismaEarningProjectionRepository(client);
  const reconciliation = new PrismaReconciliationIssueRepository();
  const unitOfWork = new PrismaUnitOfWork(client);

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
  // A review service whose settlement transaction always crashes before commit.
  const crashingReviews = new PayoutReviewService<PartnerTransactionClient>({
    runner: new CrashDuringCommitRunner(runner),
    ledger,
    earnings,
    payouts: new PrismaPayoutReviewGateway(client),
    clock,
    idGenerator,
  });

  return {
    clock,
    runner,
    ledger,
    earnings,
    earningLifecycle,
    destinations,
    requests,
    reviews,
    crashingReviews,
  };
}

type Services = ReturnType<typeof createServices>;

// ---------------------------------------------------------------------------
// Fixture seeding (raw client): an approved partner + owner member, an admin
// with payout:review, a simulator device, an active offer, and a number. Then
// per-earning: a success order + snapshot + PartnerEarning + ledger events.
// ---------------------------------------------------------------------------

interface Tenant {
  readonly partnerId: string;
  readonly memberId: string;
  readonly caller: SessionContext;
  readonly deviceId: string;
  readonly offerId: string;
  readonly numberId: string;
  readonly canonicalNumber: string;
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

function uniqueCanonicalNumber(): string {
  // Canonical rule: `+628` then a NON-ZERO digit, then 8 more. Drawing the
  // first digit from 0-9 produced `+6280…` roughly one run in ten, which the
  // domain rightly rejects — a self-inflicted flake, not a product bug.
  let digits = String(randomInt(1, 10));
  for (let i = 0; i < 8; i += 1) digits += String(randomInt(0, 10));
  return `+628${digits}`;
}

/** Approved partner + owner member + online device + active offer + one number. */
async function seedTenant(client: PartnerDatabaseClient): Promise<Tenant> {
  const partnerId = randomUUID();
  await client.partner.create({
    data: {
      id: partnerId,
      legalName: "Ledger Payout Legal",
      displayName: "Ledger Payout Partner",
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
      emailVerifiedAt: new Date(BASE_EPOCH_MS),
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
      lastSeenAt: new Date(BASE_EPOCH_MS),
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
      basePriceIdr: MVP_PAYOUT_IDR,
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

/** Create one SUCCESS order + immutable snapshot bound to the tenant's number. */
async function createSuccessOrder(
  client: PartnerDatabaseClient,
  tenant: Tenant,
  amountIdr: number,
): Promise<string> {
  const orderId = randomUUID();
  const now = BASE_EPOCH_MS;
  await client.partnerOrder.create({
    data: {
      id: orderId,
      buyerOrderRef: `buyer-${orderId}`,
      buyerAccountRef: `acct-${randomUUID()}`,
      partnerId: tenant.partnerId,
      numberId: tenant.numberId,
      offerId: tenant.offerId,
      status: "SUCCESS",
      reservedAt: new Date(now - 120_000),
      waitingAt: new Date(now - 60_000),
      succeededAt: new Date(now - 30_000),
      expiresAt: new Date(now + 20 * 60_000),
      version: 1,
    },
  });
  await client.orderSnapshot.create({
    data: {
      orderId,
      serviceCode: "wa",
      countryCode: "ID",
      operatorCode: "any",
      canonicalNumber: tenant.canonicalNumber,
      basePriceIdr: amountIdr,
      retailPriceIdr: 1_400,
      payoutIdr: amountIdr,
      platformMarginIdr: 400,
      currency: "IDR",
      configVersion: 1,
    },
  });
  return orderId;
}

function orderSuccessTx(orderId: string, amountIdr: number): LedgerTransaction {
  return createTransferTransaction({
    eventType: "order-success",
    eventKey: orderSuccessEventKey(orderId),
    referenceType: "order",
    referenceId: orderId,
    fromBucket: "platform_partner_payable",
    toBucket: "partner_pending",
    amountIdr,
  });
}

interface SeededEarning {
  readonly earningId: string;
  readonly orderId: string;
}

/**
 * Seed a PENDING Earning and its zero-sum `order-success` ledger event, exactly
 * as the SMS-success unit (task 13.3) would. `availableAtEpochMs` controls when
 * the 24h hold elapses.
 */
async function seedPendingEarning(
  services: Services,
  client: PartnerDatabaseClient,
  tenant: Tenant,
  amountIdr: number,
  availableAtEpochMs: number,
): Promise<SeededEarning> {
  const orderId = await createSuccessOrder(client, tenant, amountIdr);
  const earningId = randomUUID();
  await services.runner.run(async (tx) => {
    await services.earnings.createEarning(tx, {
      id: earningId,
      partnerId: tenant.partnerId,
      orderId,
      amountIdr,
      availableAtEpochMs,
    });
    await services.ledger.appendTransaction(tx, {
      partnerId: tenant.partnerId,
      transaction: orderSuccessTx(orderId, amountIdr),
    });
  });
  return { earningId, orderId };
}

/**
 * Seed an AVAILABLE Earning by driving a pending Earning through the REAL
 * hold-release command (its `availableAt` is set in the past so the release is
 * legal), so the ledger carries both the `order-success` and `hold-release`
 * events.
 */
async function seedAvailableEarning(
  services: Services,
  client: PartnerDatabaseClient,
  tenant: Tenant,
  amountIdr: number = MVP_PAYOUT_IDR,
): Promise<SeededEarning> {
  const seeded = await seedPendingEarning(
    services,
    client,
    tenant,
    amountIdr,
    BASE_EPOCH_MS - HOLD_PERIOD_MS,
  );
  const released = await services.earningLifecycle.releaseHold({
    partnerId: tenant.partnerId,
    earningId: seeded.earningId,
  });
  expect(released.kind).toBe("released");
  return seeded;
}

/** Create an active payout destination through the real command. */
async function seedDestination(services: Services, tenant: Tenant): Promise<string> {
  const created = await services.destinations.createDestination({
    caller: tenant.caller,
    bankCode: "BCA",
    accountNumber: "1234567890",
    accountHolderName: "Ledger Payout Partner",
    requestId: randomUUID(),
  });
  if (!created.ok) throw new Error(`destination creation failed: ${created.reason}`);
  return created.destination.id;
}

// ---------------------------------------------------------------------------
describe.runIf(hasPostgres)("Ledger + payout concurrency integration (task 14.5)", () => {
  let database: DisposableTestDatabase;
  let client: PartnerDatabaseClient;
  let services: Services;

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

  beforeEach(() => {
    services = createServices(client);
  });

  // Requirement 13.6: balances are derived from the SUM of signed ledger
  // entries per bucket (never a mutable column), and every ledger transaction is
  // a zero-sum double entry.
  describe("Ledger zero-sum and SUM-per-bucket projection (Requirement 13.6)", () => {
    it("derives per-bucket balances by SUM and keeps every event zero-sum", async () => {
      const tenant = await seedTenant(client);
      await seedAvailableEarning(services, client, tenant, MVP_PAYOUT_IDR);

      // Every persisted transaction for the tenant nets to zero.
      const transactions = await client.ledgerTransaction.findMany({
        where: { partnerId: tenant.partnerId },
        include: { entries: true },
      });
      expect(transactions.length).toBeGreaterThanOrEqual(2);
      for (const transaction of transactions) {
        expect(transaction.entries.length).toBeGreaterThanOrEqual(2);
        const sum = transaction.entries.reduce((t, e) => t + e.amountIdrSigned, 0);
        expect(sum).toBe(0);
      }

      // Balances are the SUM per bucket: payable -1000, available +1000, and the
      // whole ledger nets to zero.
      const balances = await services.ledger.computeBucketBalances(tenant.partnerId);
      expect(balances.platform_partner_payable).toBe(-MVP_PAYOUT_IDR);
      expect(balances.partner_pending).toBe(0);
      expect(balances.partner_available).toBe(MVP_PAYOUT_IDR);
      const total = Object.values(balances).reduce((t, v) => t + v, 0);
      expect(total).toBe(0);
    });
  });

  // Requirements 13.7, 20.5: a retried event with the same eventKey is a
  // deterministic no-op — no duplicate transaction, entries, or Earning.
  describe("Event retry via unique eventKey is a no-op (Requirements 13.7, 20.5)", () => {
    it("does not duplicate the order-success transaction or Earning on replay", async () => {
      const tenant = await seedTenant(client);
      const seeded = await seedPendingEarning(
        services,
        client,
        tenant,
        MVP_PAYOUT_IDR,
        BASE_EPOCH_MS + HOLD_PERIOD_MS,
      );

      // Replay the identical order-success event + Earning create.
      const replay = await services.runner.run(async (tx) => {
        const created = await services.earnings.createEarning(tx, {
          id: randomUUID(),
          partnerId: tenant.partnerId,
          orderId: seeded.orderId,
          amountIdr: MVP_PAYOUT_IDR,
          availableAtEpochMs: BASE_EPOCH_MS + HOLD_PERIOD_MS,
        });
        const append = await services.ledger.appendTransaction(tx, {
          partnerId: tenant.partnerId,
          transaction: orderSuccessTx(seeded.orderId, MVP_PAYOUT_IDR),
        });
        return { created, append };
      });

      expect(replay.created).toEqual({ created: false });
      expect(replay.append).toEqual({ outcome: "duplicate_no_op" });

      // Exactly one transaction, two entries, and one Earning persisted.
      const transactions = await client.ledgerTransaction.findMany({
        where: { eventKey: orderSuccessEventKey(seeded.orderId) },
        include: { entries: true },
      });
      expect(transactions).toHaveLength(1);
      expect(transactions[0].entries).toHaveLength(2);
      const earnings = await client.partnerEarning.findMany({ where: { orderId: seeded.orderId } });
      expect(earnings).toHaveLength(1);
    });
  });

  // Requirement 13.4: after the 24h hold elapses without a dispute, a pending
  // Earning becomes available; before the hold it stays pending.
  describe("Hold pending -> available after 24h (Requirement 13.4)", () => {
    it("blocks the release before the hold and releases it once elapsed, idempotently", async () => {
      const tenant = await seedTenant(client);
      const availableAt = BASE_EPOCH_MS + HOLD_PERIOD_MS;
      const seeded = await seedPendingEarning(services, client, tenant, MVP_PAYOUT_IDR, availableAt);

      // Before the hold elapses, the release is refused and nothing moves.
      const early = await services.earningLifecycle.releaseHold({
        partnerId: tenant.partnerId,
        earningId: seeded.earningId,
      });
      expect(early.kind).toBe("hold_not_elapsed");
      let earning = await client.partnerEarning.findUniqueOrThrow({ where: { id: seeded.earningId } });
      expect(earning.status).toBe("PENDING");

      // Advance past the 24h hold; the release now succeeds.
      services.clock.set(availableAt + 1);
      const released = await services.earningLifecycle.releaseHold({
        partnerId: tenant.partnerId,
        earningId: seeded.earningId,
      });
      expect(released.kind).toBe("released");
      earning = await client.partnerEarning.findUniqueOrThrow({ where: { id: seeded.earningId } });
      expect(earning.status).toBe("AVAILABLE");

      // A retry is a deterministic no-op: no second hold-release ledger event.
      const retry = await services.earningLifecycle.releaseHold({
        partnerId: tenant.partnerId,
        earningId: seeded.earningId,
      });
      expect(retry.kind).toBe("already_available");
      const holdEvents = await client.ledgerTransaction.count({
        where: { eventKey: holdReleaseEventKey(seeded.earningId) },
      });
      expect(holdEvents).toBe(1);

      // Balance moved pending -> available; ledger still nets to zero.
      const balances = await services.ledger.computeBucketBalances(tenant.partnerId);
      expect(balances.partner_pending).toBe(0);
      expect(balances.partner_available).toBe(MVP_PAYOUT_IDR);
    });
  });

  // Requirement 13.5: a valid reversal appends a compensating event and never
  // mutates or deletes the original records; a paid Earning is not auto-reversed
  // but becomes a reconciliation issue.
  describe("Reversal compensates without mutating originals (Requirement 13.5)", () => {
    it("reverses an available Earning with a compensating event, leaving originals intact", async () => {
      const tenant = await seedTenant(client);
      const seeded = await seedAvailableEarning(services, client, tenant, MVP_PAYOUT_IDR);

      services.clock.advance(1_000);
      const reversed = await services.earningLifecycle.reverseEarning({
        partnerId: tenant.partnerId,
        earningId: seeded.earningId,
        reason: "buyer refund confirmed",
      });
      expect(reversed.kind).toBe("reversed");

      // Projection moved to reversed with a reversedAt stamp.
      const earning = await client.partnerEarning.findUniqueOrThrow({ where: { id: seeded.earningId } });
      expect(earning.status).toBe("REVERSED");
      expect(earning.reversedAt).not.toBeNull();

      // The original order-success and hold-release events are untouched, and a
      // NEW compensating earning-reversal event exists (append-only, never a
      // mutation/delete of the originals).
      const originalSuccess = await client.ledgerTransaction.count({
        where: { eventKey: orderSuccessEventKey(seeded.orderId) },
      });
      const originalHold = await client.ledgerTransaction.count({
        where: { eventKey: holdReleaseEventKey(seeded.earningId) },
      });
      const reversal = await client.ledgerTransaction.findFirstOrThrow({
        where: { eventKey: earningReversalEventKey(seeded.earningId) },
        include: { entries: true },
      });
      expect(originalSuccess).toBe(1);
      expect(originalHold).toBe(1);
      expect(reversal.entries.reduce((t, e) => t + e.amountIdrSigned, 0)).toBe(0);

      // Available drained back out; reversed bucket holds the amount.
      const balances = await services.ledger.computeBucketBalances(tenant.partnerId);
      expect(balances.partner_available).toBe(0);
      expect(balances.partner_reversed).toBe(MVP_PAYOUT_IDR);
    });

    it("blocks a paid-Earning reversal and records a reconciliation issue instead", async () => {
      const tenant = await seedTenant(client);
      const seeded = await seedAvailableEarning(services, client, tenant, MVP_PAYOUT_IDR);
      // Drive the projection to PAID directly (the settlement path is covered
      // elsewhere); a paid Earning must never be auto-reversed on MVP.
      await client.partnerEarning.update({
        where: { id: seeded.earningId },
        data: { status: "PAID" },
      });

      const outcome = await services.earningLifecycle.reverseEarning({
        partnerId: tenant.partnerId,
        earningId: seeded.earningId,
        reason: "post-payout dispute",
      });
      expect(outcome.kind).toBe("reconciliation_required");

      // No compensating ledger event was appended and the projection is unchanged.
      const reversalEvents = await client.ledgerTransaction.count({
        where: { eventKey: earningReversalEventKey(seeded.earningId) },
      });
      expect(reversalEvents).toBe(0);
      const earning = await client.partnerEarning.findUniqueOrThrow({ where: { id: seeded.earningId } });
      expect(earning.status).toBe("PAID");
      expect(earning.reversedAt).toBeNull();

      // A durable reconciliation issue was recorded for manual handling.
      const issues = await client.reconciliationIssue.findMany({
        where: { referenceId: seeded.earningId, type: "STALE_FINANCIAL_STATE" },
      });
      expect(issues).toHaveLength(1);
      expect(issues[0].status).toBe("OPEN");
    });
  });

  // Requirements 14.1, 14.2: a payout locks the WHOLE of each selected available
  // Earning (no partial allocation on MVP) inside one atomic transaction.
  describe("Allocation is whole-earning only (Requirements 14.1, 14.2)", () => {
    it("allocates each Earning in full and locks it available -> requested atomically", async () => {
      const tenant = await seedTenant(client);
      const destinationId = await seedDestination(services, tenant);
      const seeded = await seedAvailableEarning(services, client, tenant, MVP_PAYOUT_IDR);

      const result = await services.requests.requestPayout({
        caller: tenant.caller,
        destinationId,
        earningIds: [seeded.earningId],
        requestId: randomUUID(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");

      // The allocation equals the WHOLE Earning amount; payout amount = sum.
      const allocations = await client.payoutAllocation.findMany({
        where: { payoutId: result.payout.id },
      });
      expect(allocations).toHaveLength(1);
      expect(allocations[0].earningId).toBe(seeded.earningId);
      expect(allocations[0].amountIdr).toBe(MVP_PAYOUT_IDR);
      expect(result.payout.amountIdr).toBe(MVP_PAYOUT_IDR);

      // The Earning is locked and the ledger moved available -> locked.
      const earning = await client.partnerEarning.findUniqueOrThrow({ where: { id: seeded.earningId } });
      expect(earning.status).toBe("REQUESTED");
      const balances = await services.ledger.computeBucketBalances(tenant.partnerId);
      expect(balances.partner_available).toBe(0);
      expect(balances.partner_payout_locked).toBe(MVP_PAYOUT_IDR);
    });
  });

  // Requirement 14.6: two parallel payout requests over the SAME Earning — at
  // most one may lock it (exactly-once locking under a real transaction race).
  describe("Parallel payouts over the same Earning lock exactly once (Requirement 14.6)", () => {
    it("permits at most one request to win and rolls the loser back entirely", async () => {
      const tenant = await seedTenant(client);
      const destinationId = await seedDestination(services, tenant);
      const seeded = await seedAvailableEarning(services, client, tenant, MVP_PAYOUT_IDR);

      const [a, b] = await Promise.all([
        services.requests.requestPayout({
          caller: tenant.caller,
          destinationId,
          earningIds: [seeded.earningId],
          requestId: randomUUID(),
        }),
        services.requests.requestPayout({
          caller: tenant.caller,
          destinationId,
          earningIds: [seeded.earningId],
          requestId: randomUUID(),
        }),
      ]);

      // Exactly one won; the loser failed on the lost lock or the moved Earning.
      const winners = [a, b].filter((r) => r.ok);
      const losers = [a, b].filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const loser = losers[0];
      if (loser.ok) throw new Error("unreachable");
      expect(["earning_conflict", "earning_not_available"]).toContain(loser.reason);

      // The Earning is allocated exactly once and locked once; only one payout
      // row and one payout-lock ledger event exist.
      const allocations = await client.payoutAllocation.findMany({
        where: { earningId: seeded.earningId },
      });
      expect(allocations).toHaveLength(1);
      const winnerPayoutId = winners[0].ok ? winners[0].payout.id : "";
      expect(allocations[0].payoutId).toBe(winnerPayoutId);

      const payouts = await client.partnerPayout.findMany({ where: { partnerId: tenant.partnerId } });
      expect(payouts).toHaveLength(1);
      const lockEvents = await client.ledgerTransaction.count({
        where: { eventKey: payoutLockEventKey(winnerPayoutId) },
      });
      expect(lockEvents).toBe(1);

      const earning = await client.partnerEarning.findUniqueOrThrow({ where: { id: seeded.earningId } });
      expect(earning.status).toBe("REQUESTED");
    });
  });

  // Requirement 14.5: a rejected/failed payout unlocks its Earning back to
  // available idempotently — a single unlock ledger event however many retries.
  describe("Rejected/failed payout unlocks the Earning idempotently (Requirement 14.5)", () => {
    it("unlocks on reject and produces exactly one unlock event across retries", async () => {
      const tenant = await seedTenant(client);
      const admin = await seedAdmin(client);
      const destinationId = await seedDestination(services, tenant);
      const seeded = await seedAvailableEarning(services, client, tenant, MVP_PAYOUT_IDR);

      const requested = await services.requests.requestPayout({
        caller: tenant.caller,
        destinationId,
        earningIds: [seeded.earningId],
        requestId: randomUUID(),
      });
      if (!requested.ok) throw new Error("request failed");
      const payoutId = requested.payout.id;

      const rejected = await services.reviews.reject({
        admin,
        payoutId,
        reason: "invalid destination details",
        requestId: randomUUID(),
      });
      expect(rejected.ok).toBe(true);

      // The Earning is usable again and the ledger unlocked locked -> available.
      let earning = await client.partnerEarning.findUniqueOrThrow({ where: { id: seeded.earningId } });
      expect(earning.status).toBe("AVAILABLE");
      let balances = await services.ledger.computeBucketBalances(tenant.partnerId);
      expect(balances.partner_payout_locked).toBe(0);
      expect(balances.partner_available).toBe(MVP_PAYOUT_IDR);

      // A retried reject on the terminal payout is a deterministic no-op: the
      // unlock event is not duplicated (single unlock effect).
      const retry = await services.reviews.reject({
        admin,
        payoutId,
        reason: "invalid destination details",
        requestId: randomUUID(),
      });
      expect(retry.ok).toBe(true);
      const unlockEvents = await client.ledgerTransaction.count({
        where: { eventKey: payoutUnlockEventKey(payoutId) },
      });
      expect(unlockEvents).toBe(1);

      earning = await client.partnerEarning.findUniqueOrThrow({ where: { id: seeded.earningId } });
      expect(earning.status).toBe("AVAILABLE");
      balances = await services.ledger.computeBucketBalances(tenant.partnerId);
      expect(balances.partner_available).toBe(MVP_PAYOUT_IDR);
    });

    it("allows the unlocked Earning to be requested again in a fresh payout (no stranded funds)", async () => {
      const tenant = await seedTenant(client);
      const admin = await seedAdmin(client);
      const destinationId = await seedDestination(services, tenant);
      const seeded = await seedAvailableEarning(services, client, tenant, MVP_PAYOUT_IDR);

      // First payout over the Earning is rejected: the Earning returns to
      // available AND the allocation is released (releasedAt stamped, row kept).
      const first = await services.requests.requestPayout({
        caller: tenant.caller,
        destinationId,
        earningIds: [seeded.earningId],
        requestId: randomUUID(),
      });
      if (!first.ok) throw new Error("first request failed");
      const rejected = await services.reviews.reject({
        admin,
        payoutId: first.payout.id,
        reason: "invalid destination details",
        requestId: randomUUID(),
      });
      expect(rejected.ok).toBe(true);

      const releasedAllocation = await client.payoutAllocation.findFirstOrThrow({
        where: { payoutId: first.payout.id, earningId: seeded.earningId },
      });
      expect(releasedAllocation.releasedAt).not.toBeNull();

      // The same Earning can now fund a SECOND payout: the released allocation
      // no longer occupies the partial unique earningId slot. Before the fix
      // this deterministically failed with earning_conflict forever, leaving
      // the funds reported available yet permanently unwithdrawable.
      const second = await services.requests.requestPayout({
        caller: tenant.caller,
        destinationId,
        earningIds: [seeded.earningId],
        requestId: randomUUID(),
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error("unreachable");

      const earning = await client.partnerEarning.findUniqueOrThrow({
        where: { id: seeded.earningId },
      });
      expect(earning.status).toBe("REQUESTED");

      // Audit trail intact: both allocations exist — the released one from the
      // rejected payout and exactly one ACTIVE one from the new payout.
      const allocations = await client.payoutAllocation.findMany({
        where: { earningId: seeded.earningId },
        orderBy: { createdAt: "asc" },
      });
      expect(allocations).toHaveLength(2);
      expect(allocations.filter((a) => a.releasedAt === null)).toHaveLength(1);
      expect(
        allocations.find((a) => a.releasedAt === null)?.payoutId,
      ).toBe(second.payout.id);

      // The second payout settles to paid end-to-end: the funds actually leave.
      const approved = await services.reviews.approve({
        admin,
        payoutId: second.payout.id,
        requestId: randomUUID(),
      });
      expect(approved.ok).toBe(true);
      const processing = await services.reviews.markProcessing({
        admin,
        payoutId: second.payout.id,
        requestId: randomUUID(),
      });
      expect(processing.ok).toBe(true);
      const paid = await services.reviews.markPaid({
        admin,
        payoutId: second.payout.id,
        paymentReference: `REF-${second.payout.id.slice(0, 8)}`,
        requestId: randomUUID(),
      });
      expect(paid.ok).toBe(true);

      const balances = await services.ledger.computeBucketBalances(tenant.partnerId);
      expect(balances.partner_paid).toBe(MVP_PAYOUT_IDR);
      expect(balances.partner_available).toBe(0);
      expect(balances.partner_payout_locked).toBe(0);
    });
  });

  // Requirement 14.6 / 20.2: a simulated crash between the payout lock and the
  // paid settlement leaves state consistent (the whole settlement is atomic),
  // and recovery completes it exactly once.
  describe("Crash between lock and paid recovers consistently (Requirements 14.6, 20.2)", () => {
    it("rolls back a crashed settlement and completes it cleanly on retry", async () => {
      const tenant = await seedTenant(client);
      const admin = await seedAdmin(client);
      const destinationId = await seedDestination(services, tenant);
      const seeded = await seedAvailableEarning(services, client, tenant, MVP_PAYOUT_IDR);

      const requested = await services.requests.requestPayout({
        caller: tenant.caller,
        destinationId,
        earningIds: [seeded.earningId],
        requestId: randomUUID(),
      });
      if (!requested.ok) throw new Error("request failed");
      const payoutId = requested.payout.id;

      // Drive to processing, then crash the paid settlement mid-transaction.
      expect((await services.reviews.approve({ admin, payoutId, requestId: randomUUID() })).ok).toBe(true);
      expect((await services.reviews.markProcessing({ admin, payoutId, requestId: randomUUID() })).ok).toBe(true);

      await expect(
        services.crashingReviews.markPaid({
          admin,
          payoutId,
          paymentReference: `CRASH-${payoutId}`,
          requestId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(SimulatedCrashError);

      // The crashed settlement rolled back entirely: payout still processing,
      // Earning still locked, no payment reference, no payout-paid ledger event.
      let payout = await client.partnerPayout.findUniqueOrThrow({ where: { id: payoutId } });
      expect(payout.status).toBe("PROCESSING");
      expect(payout.paymentReference).toBeNull();
      expect(payout.paidAt).toBeNull();
      let earning = await client.partnerEarning.findUniqueOrThrow({ where: { id: seeded.earningId } });
      expect(earning.status).toBe("REQUESTED");
      let paidEvents = await client.ledgerTransaction.count({
        where: { eventKey: payoutPaidEventKey(payoutId) },
      });
      expect(paidEvents).toBe(0);
      let balances = await services.ledger.computeBucketBalances(tenant.partnerId);
      expect(balances.partner_payout_locked).toBe(MVP_PAYOUT_IDR);
      expect(balances.partner_paid).toBe(0);

      // Recovery: the real settlement completes the payout exactly once.
      const settled = await services.reviews.markPaid({
        admin,
        payoutId,
        paymentReference: `PAY-${payoutId}`,
        requestId: randomUUID(),
      });
      expect(settled.ok).toBe(true);

      payout = await client.partnerPayout.findUniqueOrThrow({ where: { id: payoutId } });
      expect(payout.status).toBe("PAID");
      expect(payout.paymentReference).toBe(`PAY-${payoutId}`);
      expect(payout.paidAt).not.toBeNull();
      earning = await client.partnerEarning.findUniqueOrThrow({ where: { id: seeded.earningId } });
      expect(earning.status).toBe("PAID");
      paidEvents = await client.ledgerTransaction.count({
        where: { eventKey: payoutPaidEventKey(payoutId) },
      });
      expect(paidEvents).toBe(1);
      balances = await services.ledger.computeBucketBalances(tenant.partnerId);
      expect(balances.partner_payout_locked).toBe(0);
      expect(balances.partner_paid).toBe(MVP_PAYOUT_IDR);
    });
  });

  // Requirement 14.6: a duplicate non-null payment reference is refused by the
  // unique constraint — an Earning can never be paid via two settled payouts
  // sharing a reference.
  describe("Duplicate payment reference is rejected (Requirement 14.6)", () => {
    it("refuses a second payout that reuses an already-used payment reference", async () => {
      const tenant = await seedTenant(client);
      const admin = await seedAdmin(client);
      const destinationId = await seedDestination(services, tenant);
      const first = await seedAvailableEarning(services, client, tenant, MVP_PAYOUT_IDR);
      const second = await seedAvailableEarning(services, client, tenant, MVP_PAYOUT_IDR);

      async function driveToProcessing(earningId: string): Promise<string> {
        const requested = await services.requests.requestPayout({
          caller: tenant.caller,
          destinationId,
          earningIds: [earningId],
          requestId: randomUUID(),
        });
        if (!requested.ok) throw new Error("request failed");
        const payoutId = requested.payout.id;
        await services.reviews.approve({ admin, payoutId, requestId: randomUUID() });
        await services.reviews.markProcessing({ admin, payoutId, requestId: randomUUID() });
        return payoutId;
      }

      const payoutA = await driveToProcessing(first.earningId);
      const payoutB = await driveToProcessing(second.earningId);
      const sharedReference = "DUPLICATE-REF-0001";

      const paidA = await services.reviews.markPaid({
        admin,
        payoutId: payoutA,
        paymentReference: sharedReference,
        requestId: randomUUID(),
      });
      expect(paidA.ok).toBe(true);

      // The second settlement collides on the unique paymentReference slot.
      const paidB = await services.reviews.markPaid({
        admin,
        payoutId: payoutB,
        paymentReference: sharedReference,
        requestId: randomUUID(),
      });
      expect(paidB.ok).toBe(false);
      if (paidB.ok) throw new Error("unreachable");
      expect(paidB.reason).toBe("duplicate_payment_reference");

      // Only the first payout holds the reference; the second stayed processing
      // with its Earning still locked (rolled back).
      const references = await client.partnerPayout.findMany({
        where: { paymentReference: sharedReference },
      });
      expect(references).toHaveLength(1);
      expect(references[0].id).toBe(payoutA);

      const payoutBRow = await client.partnerPayout.findUniqueOrThrow({ where: { id: payoutB } });
      expect(payoutBRow.status).toBe("PROCESSING");
      const earningB = await client.partnerEarning.findUniqueOrThrow({ where: { id: second.earningId } });
      expect(earningB.status).toBe("REQUESTED");
    });
  });
});
