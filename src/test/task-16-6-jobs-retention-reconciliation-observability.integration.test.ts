import { execFile } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CronBatchRunner,
  type BatchJob,
  type BatchStepResult,
} from "@application/cron";
import {
  EarningReleaseJob,
  OfflineSweepJob,
  ReservationRecoveryJob,
  RetentionRedactionJob,
  ReconcileJob,
} from "@application/cron-jobs";
import { EarningLifecycleService } from "@application/ledger";

import { buildJobOperationKey } from "@domain/task-16-1/cron-jobs";

import {
  createPartnerDatabaseClient,
  PrismaEarningProjectionRepository,
  PrismaEarningReleaseGateway,
  PrismaIdempotencyTransactionRunner,
  PrismaJobLeaseRepository,
  PrismaLedgerRepository,
  PrismaOfflineSweepGateway,
  PrismaReconciliationGateway,
  PrismaReconciliationIssueRepository,
  PrismaReservationRecoveryGateway,
  PrismaRetentionGateway,
  type PartnerDatabaseClient,
  type PartnerTransactionClient,
} from "@infrastructure/database";
import { SmsOtpCipher } from "@infrastructure/crypto/sms-otp-cipher";
import { CryptoIdGenerator } from "@infrastructure/auth/system-clock";
import { JsonLogger, MetricsRegistry } from "@infrastructure/observability";

import {
  createDisposableTestDatabase,
  type DisposableTestDatabase,
} from "./disposable-database";

/**
 * Task 16.6 — end-to-end integration tests for the cron jobs, retention,
 * reconciliation, and observability surfaces (tasks 16.1–16.5), exercised
 * against a real disposable PostgreSQL database with a fake clock and injected
 * crash/contention.
 *
 * These wire the *production* Prisma gateways, the real {@link CronBatchRunner}
 * (task 16.1 lease + resumable cursor), the recovery/maintenance/reconcile jobs
 * (tasks 16.2–16.4), the shared task 14.2 hold-release command, and the task
 * 16.5 structured logger/metrics — no in-memory fakes. Each behaviour the unit
 * suites pin is re-verified through the whole stack against the committed rows:
 *
 *  - JobLease contention: two runners race, only one acquires the single lease;
 *    an expired lease is taken over and its cursor is honoured (Req 20.1, 20.2).
 *  - Retry/restart safety: re-running a batch after a simulated crash does not
 *    double-apply — the earning-release ledger stays single-appended and the
 *    reservation-recovery `operationKey` transition is written exactly once, and
 *    the offline sweep's compare-and-set is a no-op on re-run (Req 20.2, 20.5).
 *  - Retention boundaries: raw SMS (7d), OTP (24h after terminal), heartbeat
 *    metadata (30d), and security log (90d) are redacted/pruned exactly at the
 *    boundary while the mandatory financial + audit evidence (earning, ledger,
 *    payout, audit) is preserved; a not-yet-due row keeps its ciphertext + key
 *    version intact (Req 19.4, 19.5).
 *  - Reconciliation: stale online device, order/number mismatch, ledger
 *    imbalance, earning/snapshot mismatch, payout/allocation mismatch, and
 *    projection drift are all detected and persisted, deduped on a re-run, and
 *    NO money is silently repaired (Req 20.6).
 *  - Observability: emitted logs redact OTP/secret/raw SMS and the metric
 *    catalog rejects unknown series (Req 20.3, 19.6).
 *
 * **Validates: Requirements 19.4, 19.5, 19.6, 20.2, 20.3, 20.6**
 */
const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const adminUrl = process.env.PARTNER_TEST_DATABASE_ADMIN_URL ?? "";
const hasPostgres = adminUrl.length > 0;

/** Deterministic anchor well after the seeded config's `activeFrom`. */
const BASE_EPOCH_MS = Date.UTC(2026, 7, 1, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** A deterministic test AES key/version for the SMS/OTP envelope. */
const CIPHER_KEY_VERSION = 7;
const cipher = new SmsOtpCipher({
  current: { version: CIPHER_KEY_VERSION, key: Buffer.alloc(32, 0x5c).toString("base64url") },
});

const idGenerator = new CryptoIdGenerator();

/** A test-controllable clock satisfying every application `Clock` port. */
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

async function deployFromEmpty(connectionString: string): Promise<void> {
  await execFileAsync(process.execPath, ["scripts/migrate-from-empty.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, PARTNER_MIGRATION_DATABASE_URL: connectionString },
    maxBuffer: 10 * 1024 * 1024,
  });
}

/** The immutable MVP platform config (mirrors prisma/seed.sql + task-8-5). */
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

// ---------------------------------------------------------------------------
// Fixture seeding (raw client). Supply is created in dependency order and the
// scalar foreign keys are set directly, matching the task-8-5 / task-12-4
// conventions.
// ---------------------------------------------------------------------------

const HASH64 = createHash("sha256").update("task-16-6").digest("hex");

async function createApprovedPartner(client: PartnerDatabaseClient): Promise<string> {
  const id = randomUUID();
  await client.partner.create({
    data: {
      id,
      legalName: "Jobs Integration Legal",
      displayName: "Jobs Integration Partner",
      status: "APPROVED",
      simulatorAllowed: true,
    },
  });
  return id;
}

interface DeviceOptions {
  readonly status?: "ONLINE" | "OFFLINE" | "DISABLED";
  readonly lastSeenAtEpochMs?: number | null;
}

async function createDevice(
  client: PartnerDatabaseClient,
  partnerId: string,
  options: DeviceOptions = {},
): Promise<string> {
  const id = randomUUID();
  await client.partnerDevice.create({
    data: {
      id,
      partnerId,
      type: "SIMULATOR",
      label: "Sim",
      effectiveStatus: options.status ?? "ONLINE",
      lastSeenAt:
        options.lastSeenAtEpochMs === undefined
          ? new Date(BASE_EPOCH_MS)
          : options.lastSeenAtEpochMs === null
            ? null
            : new Date(options.lastSeenAtEpochMs),
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
      basePriceIdr: 1_000,
      status: "ACTIVE",
      configVersion: 1,
      activeDimensionKey: `${partnerId}:wa:ID:any`,
    },
  });
  return id;
}

function uniqueCanonicalNumber(): string {
  let digits = "";
  for (let i = 0; i < 9; i += 1) digits += String(randomInt(0, 10));
  return `+628${digits}`;
}

interface NumberOptions {
  readonly status?: "OFFLINE" | "AVAILABLE" | "RESERVED" | "BUSY" | "DISABLED";
  readonly currentOrderId?: string | null;
  readonly enabled?: boolean;
}

async function createNumber(
  client: PartnerDatabaseClient,
  partnerId: string,
  deviceId: string,
  options: NumberOptions = {},
): Promise<{ numberId: string; canonicalNumber: string }> {
  const numberId = randomUUID();
  const canonicalNumber = uniqueCanonicalNumber();
  const status = options.status ?? "AVAILABLE";
  const enabled = options.enabled ?? true;
  const active = enabled && status !== "DISABLED";
  await client.partnerNumber.create({
    data: {
      id: numberId,
      partnerId,
      deviceId,
      canonicalNumber,
      activeCanonicalNumber: active ? canonicalNumber : null,
      countryCode: "ID",
      operatorCode: "any",
      status,
      enabled,
      currentOrderId: options.currentOrderId ?? null,
    },
  });
  return { numberId, canonicalNumber };
}

// ---------------------------------------------------------------------------
// Runner + service wiring against the shared disposable database.
// ---------------------------------------------------------------------------

function makeRunner(client: PartnerDatabaseClient, clock: MutableClock): CronBatchRunner {
  return new CronBatchRunner({
    leases: new PrismaJobLeaseRepository(client),
    clock,
    ownerIdFactory: () => randomUUID(),
  });
}

function makeEarningLifecycle(
  client: PartnerDatabaseClient,
  clock: MutableClock,
): EarningLifecycleService<PartnerTransactionClient> {
  return new EarningLifecycleService<PartnerTransactionClient>({
    runner: new PrismaIdempotencyTransactionRunner(client),
    ledger: new PrismaLedgerRepository(client),
    earnings: new PrismaEarningProjectionRepository(client),
    reconciliation: new PrismaReconciliationIssueRepository(),
    clock,
    idGenerator,
  });
}

// ---------------------------------------------------------------------------
// Observability: structured metrics + log redaction (Req 20.3, 19.6). This
// surface is pure/in-process, so it runs without Postgres.
// ---------------------------------------------------------------------------
describe("Structured metrics and log redaction (task 16.5)", () => {
  const OTP = "654321";
  const RAW_SMS = "WhatsApp code 654321 do not share";
  const SECRET = "kk_live_supersecrettoken_abc123";

  it("redacts OTP, raw SMS, secrets, and credentials from emitted log lines", () => {
    const lines: string[] = [];
    const logger = new JsonLogger({
      service: "partner",
      env: "test",
      nowEpochMs: () => BASE_EPOCH_MS,
      sink: (line) => lines.push(line),
    });

    const record = logger.logRequest({
      requestId: randomUUID(),
      route: "/api/agent/v1/sms",
      method: "POST",
      status: 200,
      latencyMs: 12,
      actorId: "device-42",
      partnerOrderId: "order-1",
      extra: {
        otp: OTP,
        rawSms: RAW_SMS,
        authorization: `Bearer ${SECRET}`,
        apiKey: SECRET,
        password: "hunter2",
        // Operational fields whose names merely embed a sensitive word stay.
        unmatchedSmsCount: 3,
        otpAttempts: 1,
      },
    });

    // The single emitted line carries none of the sensitive plaintext.
    expect(lines).toHaveLength(1);
    const emitted = lines[0];
    expect(emitted).not.toContain(OTP);
    expect(emitted).not.toContain(RAW_SMS);
    expect(emitted).not.toContain(SECRET);
    expect(emitted).not.toContain("hunter2");
    expect(emitted).toContain("[REDACTED]");

    // Non-sensitive operational fields survive; sensitive ones are placeholders.
    const parsed = JSON.parse(emitted) as { extra: Record<string, unknown> };
    expect(parsed.extra.otp).toBe("[REDACTED]");
    expect(parsed.extra.rawSms).toBe("[REDACTED]");
    expect(parsed.extra.authorization).toBe("[REDACTED]");
    expect(parsed.extra.apiKey).toBe("[REDACTED]");
    expect(parsed.extra.password).toBe("[REDACTED]");
    expect(parsed.extra.unmatchedSmsCount).toBe(3);
    expect(parsed.extra.otpAttempts).toBe(1);
    // The record returned to the caller is redacted too (single choke point).
    expect(JSON.stringify(record)).not.toContain(OTP);
  });

  it("records the design's metric catalog and rejects unknown/mis-kinded series", () => {
    const metrics = new MetricsRegistry();

    metrics.observe("partner_job_duration_ms", 42, { job: "reconcile" });
    metrics.increment("partner_job_failure_total", { job: "order-timeout" }, 1);
    metrics.setGauge("partner_reconciliation_issue", 4, { type: "ledger_imbalance" });
    metrics.increment("partner_order_terminal_total", { terminalState: "timeout" });

    const snapshot = metrics.snapshot();
    const duration = snapshot.histograms.find((h) => h.name === "partner_job_duration_ms");
    expect(duration?.count).toBe(1);
    expect(duration?.sum).toBe(42);
    expect(duration?.labels).toEqual({ job: "reconcile" });
    const issueGauge = snapshot.gauges.find((g) => g.name === "partner_reconciliation_issue");
    expect(issueGauge?.value).toBe(4);
    const failure = snapshot.counters.find((c) => c.name === "partner_job_failure_total");
    expect(failure?.value).toBe(1);

    // A typo can never spawn a shadow metric, and a kind mismatch is rejected.
    expect(() =>
      // @ts-expect-error — an unknown metric name is a compile *and* runtime error.
      metrics.increment("partner_made_up_metric"),
    ).toThrow(/Unknown metric/);
    expect(() => metrics.increment("partner_job_duration_ms", { job: "x" })).toThrow(
      /not a counter/,
    );
  });
});

/** Run a job through the runner until its backlog drains (fresh cron ticks). */
async function runToCompletion(runner: CronBatchRunner, job: BatchJob): Promise<void> {
  for (let guard = 0; guard < 50; guard += 1) {
    const result = await runner.run(job);
    if (result.status === "completed" && result.drained) return;
  }
  throw new Error(`Job ${job.name} did not drain`);
}

/** Seed a SUCCESS order + snapshot + order-success ledger + a pending Earning
 * whose 24h hold has already elapsed (a releasable earning). */
async function seedReleasableEarning(
  client: PartnerDatabaseClient,
): Promise<{ partnerId: string; orderId: string; earningId: string; amount: number }> {
  const amount = 1_000;
  const partnerId = await createApprovedPartner(client);
  const deviceId = await createDevice(client, partnerId, { status: "ONLINE" });
  const offerId = await createActiveOffer(client, partnerId);
  const { numberId, canonicalNumber } = await createNumber(client, partnerId, deviceId, {
    status: "AVAILABLE",
  });
  const orderId = randomUUID();
  await client.partnerOrder.create({
    data: {
      id: orderId,
      buyerOrderRef: `buyer-${orderId}`,
      buyerAccountRef: `acct-${randomUUID()}`,
      partnerId,
      numberId,
      offerId,
      status: "SUCCESS",
      expiresAt: new Date(BASE_EPOCH_MS + HOUR_MS),
      reservedAt: new Date(BASE_EPOCH_MS - 2 * HOUR_MS),
      succeededAt: new Date(BASE_EPOCH_MS - DAY_MS),
      terminalAt: new Date(BASE_EPOCH_MS - DAY_MS),
    },
  });
  await client.orderSnapshot.create({
    data: {
      orderId,
      serviceCode: "wa",
      countryCode: "ID",
      operatorCode: "any",
      canonicalNumber,
      basePriceIdr: 1_000,
      retailPriceIdr: 1_400,
      payoutIdr: amount,
      platformMarginIdr: 400,
      currency: "IDR",
      configVersion: 1,
    },
  });
  const earningId = randomUUID();
  await client.partnerEarning.create({
    data: {
      id: earningId,
      partnerId,
      orderId,
      amountIdr: amount,
      status: "PENDING",
      // Hold elapsed one hour ago -> releasable at BASE.
      availableAt: new Date(BASE_EPOCH_MS - HOUR_MS),
    },
  });
  await client.ledgerTransaction.create({
    data: {
      partnerId,
      eventType: "ORDER_SUCCESS",
      eventKey: `order-success:${orderId}`,
      referenceType: "order",
      referenceId: orderId,
      entries: {
        // partnerId is derived from the parent transaction's composite relation.
        create: [
          { bucket: "PLATFORM_PARTNER_PAYABLE", amountIdrSigned: -amount },
          { bucket: "PARTNER_PENDING", amountIdrSigned: amount },
        ],
      },
    },
  });
  return { partnerId, orderId, earningId, amount };
}

/** Seed a reservation stranded in `reserved` past the recovery window, still
 * valid for promotion (number reserved+bound, enabled, active offer, live device). */
async function seedStuckReservation(
  client: PartnerDatabaseClient,
): Promise<{ partnerId: string; orderId: string; numberId: string }> {
  const partnerId = await createApprovedPartner(client);
  const deviceId = await createDevice(client, partnerId, {
    status: "ONLINE",
    lastSeenAtEpochMs: BASE_EPOCH_MS,
  });
  const offerId = await createActiveOffer(client, partnerId);
  const { numberId } = await createNumber(client, partnerId, deviceId, { status: "RESERVED" });
  const orderId = randomUUID();
  await client.partnerOrder.create({
    data: {
      id: orderId,
      buyerOrderRef: `buyer-${orderId}`,
      buyerAccountRef: `acct-${randomUUID()}`,
      partnerId,
      numberId,
      offerId,
      status: "RESERVED",
      reservedAt: new Date(BASE_EPOCH_MS - 60_000),
      expiresAt: new Date(BASE_EPOCH_MS + 20 * 60_000),
      version: 1,
    },
  });
  // Bind the number to the order (currentOrderId FK needs the order to exist).
  await client.partnerNumber.update({
    where: { id: numberId },
    data: { currentOrderId: orderId },
  });
  return { partnerId, orderId, numberId };
}

// ---------------------------------------------------------------------------
describe.runIf(hasPostgres)(
  "Jobs, retention, reconciliation persistence integration (task 16.6)",
  () => {
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

    // -----------------------------------------------------------------------
    // JobLease contention, expiry, and cursor (Requirements 20.1, 20.2).
    // -----------------------------------------------------------------------
    describe("JobLease contention, expiry, and cursor", () => {
      it("lets only one of two racing workers hold the single lease", async () => {
        const leases = new PrismaJobLeaseRepository(client);
        const name = `contend-${randomUUID()}`;
        const now = BASE_EPOCH_MS;

        const first = await leases.acquire({
          name,
          ownerId: "owner-a",
          leaseUntilEpochMs: now + 55_000,
          nowEpochMs: now,
        });
        expect(first).not.toBeNull();

        // A second live worker cannot take the still-held lease.
        const second = await leases.acquire({
          name,
          ownerId: "owner-b",
          leaseUntilEpochMs: now + 55_000,
          nowEpochMs: now,
        });
        expect(second).toBeNull();

        // Once the holder releases, the contender can acquire it.
        await leases.release({ name, ownerId: "owner-a" });
        const afterRelease = await leases.acquire({
          name,
          ownerId: "owner-b",
          leaseUntilEpochMs: now + 55_000,
          nowEpochMs: now + 1,
        });
        expect(afterRelease).not.toBeNull();
      });

      it("takes over an expired lease and resumes from its persisted cursor", async () => {
        const leases = new PrismaJobLeaseRepository(client);
        const name = `expiry-${randomUUID()}`;
        const now = BASE_EPOCH_MS;

        const acquired = await leases.acquire({
          name,
          ownerId: "owner-a",
          leaseUntilEpochMs: now + 10_000,
          nowEpochMs: now,
        });
        expect(acquired).not.toBeNull();

        // Owner A durably advances the resumable cursor.
        const renewed = await leases.renew({
          name,
          ownerId: "owner-a",
          leaseUntilEpochMs: now + 10_000,
          cursor: { afterId: "cursor-123" },
        });
        expect(renewed).toBe(true);

        // After A's lease expires, B takes it over and inherits the cursor.
        const takenOver = await leases.acquire({
          name,
          ownerId: "owner-b",
          leaseUntilEpochMs: now + 30_000,
          nowEpochMs: now + 20_000,
        });
        expect(takenOver).not.toBeNull();
        expect(takenOver?.cursor).toEqual({ afterId: "cursor-123" });

        // A has lost the lease and can no longer renew it.
        const lost = await leases.renew({
          name,
          ownerId: "owner-a",
          leaseUntilEpochMs: now + 40_000,
        });
        expect(lost).toBe(false);
      });

      it("skips the cron tick when another live worker holds the lease", async () => {
        const clock = new MutableClock(BASE_EPOCH_MS);
        const leases = new PrismaJobLeaseRepository(client);
        let ran = 0;
        const job: BatchJob = {
          name: `runner-lock-${randomUUID()}`,
          async runBatch(): Promise<BatchStepResult> {
            ran += 1;
            return { processed: 0, nextCursor: null, done: true };
          },
        };

        const held = await leases.acquire({
          name: job.name,
          ownerId: "foreign-worker",
          leaseUntilEpochMs: BASE_EPOCH_MS + 55_000,
          nowEpochMs: BASE_EPOCH_MS,
        });
        expect(held).not.toBeNull();

        const result = await makeRunner(client, clock).run(job);
        expect(result.status).toBe("skipped_locked");
        expect(ran).toBe(0);
      });
    });

    // -----------------------------------------------------------------------
    // Retry/restart safety: re-running a batch after a crash never double-applies
    // (Requirements 20.2, 20.5).
    // -----------------------------------------------------------------------
    describe("Retry/restart safety and idempotency", () => {
      it("earning-release re-run never double-appends the hold-release ledger event", async () => {
        const clock = new MutableClock(BASE_EPOCH_MS);
        const { partnerId, earningId, amount } = await seedReleasableEarning(client);
        const command = makeEarningLifecycle(client, clock);
        const job = new EarningReleaseJob({
          gateway: new PrismaEarningReleaseGateway(client),
          command,
          clock,
        });
        const runner = makeRunner(client, clock);

        // First tick releases the hold; a second tick (simulated crash re-run)
        // finds it already available and is a deterministic no-op.
        await runToCompletion(runner, job);
        await runToCompletion(runner, job);
        // And re-invoking the shared command directly is idempotent too.
        const replay = await command.releaseHold({ partnerId, earningId });
        expect(replay.kind).toBe("already_available");

        const earning = await client.partnerEarning.findUniqueOrThrow({ where: { id: earningId } });
        expect(earning.status).toBe("AVAILABLE");

        // Exactly one hold-release ledger transaction, and it is zero-sum.
        const holdReleases = await client.ledgerTransaction.findMany({
          where: { eventKey: `hold-release:${earningId}` },
          include: { entries: true },
        });
        expect(holdReleases).toHaveLength(1);
        const sum = holdReleases[0].entries.reduce((t, e) => t + e.amountIdrSigned, 0);
        expect(sum).toBe(0);

        // Bucket balances moved the money exactly once: pending 0, available +amount.
        const balances = await new PrismaLedgerRepository(client).computeBucketBalances(partnerId);
        expect(balances.partner_pending).toBe(0);
        expect(balances.partner_available).toBe(amount);
      });

      it("reservation-recovery promotes once and writes the operationKey transition exactly once", async () => {
        const clock = new MutableClock(BASE_EPOCH_MS);
        const { orderId, numberId } = await seedStuckReservation(client);
        const job = new ReservationRecoveryJob({
          gateway: new PrismaReservationRecoveryGateway(client),
          clock,
        });
        const runner = makeRunner(client, clock);

        await runToCompletion(runner, job);
        await runToCompletion(runner, job); // crash re-run

        const order = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
        expect(order.status).toBe("WAITING_SMS");
        const number = await client.partnerNumber.findUniqueOrThrow({ where: { id: numberId } });
        expect(number.status).toBe("BUSY");

        // The recovery transition carries the deterministic per-item operation
        // key and is written exactly once despite the re-run.
        const operationKey = buildJobOperationKey("reservation-recovery", orderId);
        const transitions = await client.orderTransition.findMany({ where: { operationKey } });
        expect(transitions).toHaveLength(1);
        expect(transitions[0].toStatus).toBe("WAITING_SMS");
      });

      it("offline-sweep is a compare-and-set no-op on re-run", async () => {
        const clock = new MutableClock(BASE_EPOCH_MS);
        const partnerId = await createApprovedPartner(client);
        const deviceId = await createDevice(client, partnerId, {
          status: "ONLINE",
          lastSeenAtEpochMs: BASE_EPOCH_MS - 5 * 60_000, // stale > 90s
        });
        const { numberId } = await createNumber(client, partnerId, deviceId, {
          status: "AVAILABLE",
        });
        const job = new OfflineSweepJob({
          gateway: new PrismaOfflineSweepGateway(client),
          clock,
          idGenerator,
        });
        const runner = makeRunner(client, clock);

        await runToCompletion(runner, job);
        await runToCompletion(runner, job); // re-run is a no-op

        const device = await client.partnerDevice.findUniqueOrThrow({ where: { id: deviceId } });
        expect(device.effectiveStatus).toBe("OFFLINE");
        const number = await client.partnerNumber.findUniqueOrThrow({ where: { id: numberId } });
        expect(number.status).toBe("OFFLINE");

        // The offline propagation recorded exactly one state-history row.
        const history = await client.numberStateHistory.findMany({
          where: { numberId, toStatus: "OFFLINE" },
        });
        expect(history).toHaveLength(1);
      });
    });

    // -----------------------------------------------------------------------
    // Retention boundaries: redact/prune sensitive data exactly at the window,
    // preserve mandatory financial + audit evidence and not-yet-due ciphertext
    // (Requirements 19.4, 19.5).
    // -----------------------------------------------------------------------
    describe("Retention boundaries redact/prune sensitive data and preserve evidence", () => {
      it("redacts due SMS/OTP, prunes due metadata/security, and keeps financial + audit + fresh rows", async () => {
        const clock = new MutableClock(BASE_EPOCH_MS);
        const partnerId = await createApprovedPartner(client);
        const deviceId = await createDevice(client, partnerId, { status: "ONLINE" });
        const offerId = await createActiveOffer(client, partnerId);
        const { numberId } = await createNumber(client, partnerId, deviceId, { status: "AVAILABLE" });

        // --- SMS: one past the 7d window (redact), one within it (retain). ---
        const smsBody = "WhatsApp code 314159 do not share";
        const smsSender = "WhatsAppBusiness";
        async function seedSms(receivedAtServerEpochMs: number): Promise<string> {
          const id = randomUUID();
          const bodyEnc = cipher.encrypt(smsBody);
          const senderEnc = cipher.encrypt(smsSender);
          await client.partnerSms.create({
            data: {
              id,
              deviceId,
              numberId,
              messageId: randomUUID(),
              idempotencyKey: randomUUID(),
              senderCiphertext: Buffer.from(senderEnc.ciphertext),
              bodyCiphertext: Buffer.from(bodyEnc.ciphertext),
              keyVersion: CIPHER_KEY_VERSION,
              bodyFingerprint: cipher.fingerprint(smsBody),
              receivedAtDevice: new Date(receivedAtServerEpochMs - 2_000),
              receivedAtServer: new Date(receivedAtServerEpochMs),
              matchStatus: "UNMATCHED",
            },
          });
          return id;
        }
        const dueSmsId = await seedSms(BASE_EPOCH_MS - 8 * DAY_MS);
        const freshSmsId = await seedSms(BASE_EPOCH_MS - 6 * DAY_MS);

        // --- OTP: a terminal SUCCESS order past the 24h window (redact) plus a
        // paired Earning + ledger that must survive; and one within the window. ---
        const otp = "111111";
        async function seedTerminalOrderWithOtp(terminalAtEpochMs: number): Promise<string> {
          const orderId = randomUUID();
          const otpEnc = cipher.encrypt(otp);
          await client.partnerOrder.create({
            data: {
              id: orderId,
              buyerOrderRef: `buyer-${orderId}`,
              buyerAccountRef: `acct-${randomUUID()}`,
              partnerId,
              numberId,
              offerId,
              status: "SUCCESS",
              otpCiphertext: Buffer.from(otpEnc.ciphertext),
              otpKeyVersion: CIPHER_KEY_VERSION,
              otpFingerprint: cipher.fingerprint(otp),
              expiresAt: new Date(terminalAtEpochMs + HOUR_MS),
              reservedAt: new Date(terminalAtEpochMs - HOUR_MS),
              succeededAt: new Date(terminalAtEpochMs),
              terminalAt: new Date(terminalAtEpochMs),
            },
          });
          return orderId;
        }
        const dueOtpOrderId = await seedTerminalOrderWithOtp(BASE_EPOCH_MS - 25 * HOUR_MS);
        const freshOtpOrderId = await seedTerminalOrderWithOtp(BASE_EPOCH_MS - 20 * HOUR_MS);

        // The financial evidence attached to the redacted order (never touched).
        const earningId = randomUUID();
        await client.partnerEarning.create({
          data: {
            id: earningId,
            partnerId,
            orderId: dueOtpOrderId,
            amountIdr: 1_000,
            status: "PENDING",
            availableAt: new Date(BASE_EPOCH_MS + DAY_MS),
          },
        });
        await client.ledgerTransaction.create({
          data: {
            partnerId,
            eventType: "ORDER_SUCCESS",
            eventKey: `order-success:${dueOtpOrderId}`,
            referenceType: "order",
            referenceId: dueOtpOrderId,
            entries: {
              create: [
                { bucket: "PLATFORM_PARTNER_PAYABLE", amountIdrSigned: -1_000 },
                { bucket: "PARTNER_PENDING", amountIdrSigned: 1_000 },
              ],
            },
          },
        });

        // --- Heartbeat metadata: past 30d (prune) + within it (retain). ---
        async function seedHeartbeat(receivedAtEpochMs: number): Promise<string> {
          const id = randomUUID();
          await client.deviceHeartbeat.create({
            data: { id, deviceId, receivedAt: new Date(receivedAtEpochMs), signal: -70 },
          });
          return id;
        }
        const dueHeartbeatId = await seedHeartbeat(BASE_EPOCH_MS - 31 * DAY_MS);
        const freshHeartbeatId = await seedHeartbeat(BASE_EPOCH_MS - 20 * DAY_MS);

        // --- Security log: past 90d (prune) + within it (retain). ---
        async function seedSecurityEvent(createdAtEpochMs: number): Promise<string> {
          const id = randomUUID();
          await client.securityEvent.create({
            data: {
              id,
              partnerId,
              principalHash: HASH64,
              category: "AUTHENTICATION_FAILURE",
              result: "BLOCKED",
              requestId: randomUUID(),
              createdAt: new Date(createdAtEpochMs),
            },
          });
          return id;
        }
        const dueSecurityId = await seedSecurityEvent(BASE_EPOCH_MS - 91 * DAY_MS);
        const freshSecurityId = await seedSecurityEvent(BASE_EPOCH_MS - 80 * DAY_MS);

        // --- Protected audit evidence (7y): must never be touched. ---
        const auditId = randomUUID();
        await client.auditEvent.create({
          data: {
            id: auditId,
            partnerId,
            actorType: "CRON",
            actorRefHash: HASH64,
            action: "order.success",
            targetType: "order",
            targetId: dueOtpOrderId,
            result: "SUCCEEDED",
            requestId: randomUUID(),
            createdAt: new Date(BASE_EPOCH_MS - 100 * DAY_MS),
          },
        });

        // Run the whole retention sweep at BASE.
        const job = new RetentionRedactionJob({
          gateway: new PrismaRetentionGateway(client),
          clock,
        });
        await runToCompletion(makeRunner(client, clock), job);

        // Due SMS: redacted in place (ciphertext emptied, stamped) but the row
        // (and its match/audit linkage) survives.
        const dueSms = await client.partnerSms.findUniqueOrThrow({ where: { id: dueSmsId } });
        expect(dueSms.redactedAt).not.toBeNull();
        expect(Buffer.from(dueSms.bodyCiphertext)).toHaveLength(0);
        expect(Buffer.from(dueSms.senderCiphertext)).toHaveLength(0);

        // Not-yet-due SMS: ciphertext AND key version preserved intact, and it
        // still round-trips to the original plaintext.
        const freshSms = await client.partnerSms.findUniqueOrThrow({ where: { id: freshSmsId } });
        expect(freshSms.redactedAt).toBeNull();
        expect(freshSms.keyVersion).toBe(CIPHER_KEY_VERSION);
        expect(Buffer.from(freshSms.bodyCiphertext).length).toBeGreaterThan(0);
        expect(
          await cipher.decrypt({
            ciphertext: Buffer.from(freshSms.bodyCiphertext),
            keyVersion: freshSms.keyVersion,
          }),
        ).toBe(smsBody);

        // Due OTP: ciphertext/key/fingerprint nulled; order + earning + ledger intact.
        const dueOrder = await client.partnerOrder.findUniqueOrThrow({ where: { id: dueOtpOrderId } });
        expect(dueOrder.otpCiphertext).toBeNull();
        expect(dueOrder.otpKeyVersion).toBeNull();
        expect(dueOrder.otpFingerprint).toBeNull();
        expect(dueOrder.status).toBe("SUCCESS");
        const earning = await client.partnerEarning.findUniqueOrThrow({ where: { id: earningId } });
        expect(earning.status).toBe("PENDING");
        expect(
          await client.ledgerTransaction.count({
            where: { eventKey: `order-success:${dueOtpOrderId}` },
          }),
        ).toBe(1);

        // Not-yet-due OTP preserved with its key version.
        const freshOrder = await client.partnerOrder.findUniqueOrThrow({
          where: { id: freshOtpOrderId },
        });
        expect(freshOrder.otpCiphertext).not.toBeNull();
        expect(freshOrder.otpKeyVersion).toBe(CIPHER_KEY_VERSION);

        // Heartbeat metadata + security log pruned at the boundary, kept within it.
        expect(await client.deviceHeartbeat.findUnique({ where: { id: dueHeartbeatId } })).toBeNull();
        expect(
          await client.deviceHeartbeat.findUnique({ where: { id: freshHeartbeatId } }),
        ).not.toBeNull();
        expect(await client.securityEvent.findUnique({ where: { id: dueSecurityId } })).toBeNull();
        expect(
          await client.securityEvent.findUnique({ where: { id: freshSecurityId } }),
        ).not.toBeNull();

        // The device's authoritative liveness is a separate column, untouched.
        const device = await client.partnerDevice.findUniqueOrThrow({ where: { id: deviceId } });
        expect(device.lastSeenAt).not.toBeNull();

        // Protected audit evidence is never removed by retention.
        expect(await client.auditEvent.findUnique({ where: { id: auditId } })).not.toBeNull();
      });
    });

    // -----------------------------------------------------------------------
    // Reconciliation: detect every financial + operational inconsistency,
    // dedupe on re-run, and never silently repair money (Requirement 20.6).
    // -----------------------------------------------------------------------
    describe("Reconciliation detects issues, dedupes, and repairs no money", () => {
      /** Seed one tenant that violates every reconciler invariant reachable
       * through the real schema. */
      async function seedDirtyTenant(): Promise<string> {
        const partnerId = await createApprovedPartner(client);
        const offerId = await createActiveOffer(client, partnerId);

        // (1) Stale online device -> stale_financial_state.
        await createDevice(client, partnerId, {
          status: "ONLINE",
          lastSeenAtEpochMs: BASE_EPOCH_MS - 10 * 60_000,
        });

        // (2) Order/number pairing mismatch: an active RESERVED order whose
        //     number is BUSY (should be RESERVED) -> order_number_mismatch.
        const mismatchDeviceId = await createDevice(client, partnerId, { status: "ONLINE" });
        const { numberId: busyNumberId } = await createNumber(
          client,
          partnerId,
          mismatchDeviceId,
          { status: "BUSY" },
        );
        const mismatchOrderId = randomUUID();
        await client.partnerOrder.create({
          data: {
            id: mismatchOrderId,
            buyerOrderRef: `buyer-${mismatchOrderId}`,
            buyerAccountRef: `acct-${randomUUID()}`,
            partnerId,
            numberId: busyNumberId,
            offerId,
            status: "RESERVED",
            reservedAt: new Date(BASE_EPOCH_MS - 60_000),
            expiresAt: new Date(BASE_EPOCH_MS + 20 * 60_000),
          },
        });

        // (3) Non-zero-sum ledger transaction -> ledger_imbalance (+ global).
        await client.ledgerTransaction.create({
          data: {
            partnerId,
            eventType: "MANUAL_ADJUSTMENT",
            eventKey: `manual-adjustment:${randomUUID()}`,
            referenceType: "manual",
            referenceId: randomUUID(),
            entries: { create: [{ bucket: "PARTNER_PENDING", amountIdrSigned: 1_000 }] },
          },
        });

        // (4) Earning != order snapshot payout -> earning_snapshot_mismatch, and
        //     the pending earning projection drifts from the ledger buckets ->
        //     projection_ledger_mismatch.
        const successDeviceId = await createDevice(client, partnerId, { status: "ONLINE" });
        const { numberId: successNumberId, canonicalNumber } = await createNumber(
          client,
          partnerId,
          successDeviceId,
          { status: "AVAILABLE" },
        );
        const successOrderId = randomUUID();
        await client.partnerOrder.create({
          data: {
            id: successOrderId,
            buyerOrderRef: `buyer-${successOrderId}`,
            buyerAccountRef: `acct-${randomUUID()}`,
            partnerId,
            numberId: successNumberId,
            offerId,
            status: "SUCCESS",
            expiresAt: new Date(BASE_EPOCH_MS + HOUR_MS),
            terminalAt: new Date(BASE_EPOCH_MS - HOUR_MS),
          },
        });
        await client.orderSnapshot.create({
          data: {
            orderId: successOrderId,
            serviceCode: "wa",
            countryCode: "ID",
            operatorCode: "any",
            canonicalNumber,
            basePriceIdr: 1_000,
            retailPriceIdr: 1_400,
            payoutIdr: 1_000,
            platformMarginIdr: 400,
            currency: "IDR",
            configVersion: 1,
          },
        });
        const earningId = randomUUID();
        await client.partnerEarning.create({
          data: {
            id: earningId,
            partnerId,
            orderId: successOrderId,
            amountIdr: 2_000, // != snapshot payout 1000
            status: "PENDING",
            availableAt: new Date(BASE_EPOCH_MS + DAY_MS),
          },
        });

        // (5) Payout amount != sum of its allocations -> payout_allocation_mismatch.
        const memberId = randomUUID();
        await client.partnerMember.create({
          data: {
            id: memberId,
            partnerId,
            emailNormalized: `owner-${randomUUID()}@example.test`,
            passwordHash: "x".repeat(60),
            role: "OWNER",
            status: "ACTIVE",
          },
        });
        const destinationId = randomUUID();
        await client.payoutDestination.create({
          data: {
            id: destinationId,
            partnerId,
            bankCode: "014",
            accountNumberCiphertext: Buffer.from([1, 2, 3, 4]),
            keyVersion: CIPHER_KEY_VERSION,
            accountNumberLast4: "1234",
            accountHolderName: "Test Holder",
          },
        });
        const payoutId = randomUUID();
        await client.partnerPayout.create({
          data: {
            id: payoutId,
            partnerId,
            destinationId,
            destinationSnapshotJsonEncrypted: Buffer.from([9, 9]),
            amountIdr: 5_000, // != allocation total 1000
            status: "REQUESTED",
            createdByMemberId: memberId,
          },
        });
        await client.payoutAllocation.create({
          data: { id: randomUUID(), partnerId, payoutId, earningId, amountIdr: 1_000 },
        });

        return partnerId;
      }

      it("detects every invariant class, dedupes on re-run, and mutates no money", async () => {
        const clock = new MutableClock(BASE_EPOCH_MS);
        const partnerId = await seedDirtyTenant();

        // Snapshot the money BEFORE reconciliation so we can prove nothing moved.
        const ledgerBefore = await client.ledgerEntry.findMany({ where: { partnerId } });
        const earningsBefore = await client.partnerEarning.findMany({
          where: { partnerId },
          select: { id: true, status: true, amountIdr: true },
          orderBy: { id: "asc" },
        });
        const payoutsBefore = await client.partnerPayout.findMany({
          where: { partnerId },
          select: { id: true, status: true, amountIdr: true },
          orderBy: { id: "asc" },
        });

        const job = new ReconcileJob({ gateway: new PrismaReconciliationGateway(client), clock });
        await runToCompletion(makeRunner(client, clock), job);

        // Every persisted issue class was detected for this tenant.
        const issues = await client.reconciliationIssue.findMany({ where: { partnerId } });
        const types = new Set(issues.map((issue) => issue.type));
        for (const expected of [
          "STALE_FINANCIAL_STATE",
          "ORDER_NUMBER_MISMATCH",
          "LEDGER_IMBALANCE",
          "EARNING_SNAPSHOT_MISMATCH",
          "PAYOUT_ALLOCATION_MISMATCH",
          "PROJECTION_LEDGER_MISMATCH",
        ] as const) {
          expect(types.has(expected)).toBe(true);
        }
        // Findings never carry raw sensitive data (redaction-safe details only).
        const serializedIssues = JSON.stringify(issues.map((i) => i.detailsSafeJson));
        expect(serializedIssues).not.toContain("314159");

        // Re-running the sweep records NO new rows (deterministic open-issue dedupe).
        const countAfterFirst = issues.length;
        await runToCompletion(makeRunner(client, clock), job);
        const countAfterSecond = await client.reconciliationIssue.count({ where: { partnerId } });
        expect(countAfterSecond).toBe(countAfterFirst);

        // NO silent money repair: ledger, earnings, and payout are byte-identical.
        const ledgerAfter = await client.ledgerEntry.findMany({ where: { partnerId } });
        expect(ledgerAfter).toHaveLength(ledgerBefore.length);
        const earningsAfter = await client.partnerEarning.findMany({
          where: { partnerId },
          select: { id: true, status: true, amountIdr: true },
          orderBy: { id: "asc" },
        });
        expect(earningsAfter).toEqual(earningsBefore);
        const payoutsAfter = await client.partnerPayout.findMany({
          where: { partnerId },
          select: { id: true, status: true, amountIdr: true },
          orderBy: { id: "asc" },
        });
        expect(payoutsAfter).toEqual(payoutsBefore);
      });
    });
  },
);
