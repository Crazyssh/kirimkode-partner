import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CronBatchRunner, type BatchJob, type BatchStepResult } from "@application/cron";
import {
  CronLivenessService,
  type CronLivenessSnapshot,
} from "@application/health/cron-liveness-service";

import { CRON_JOB_CADENCE_SECONDS, STALENESS_CADENCE_MULTIPLIER } from "@domain/task-16-5";

import {
  createPartnerDatabaseClient,
  PrismaCronLastSeenGateway,
  PrismaJobLeaseRepository,
  type PartnerDatabaseClient,
} from "@infrastructure/database";

import {
  createDisposableTestDatabase,
  type DisposableTestDatabase,
} from "./disposable-database";

/**
 * Cron liveness persistence integration tests (requirement 20.3).
 *
 * The cron liveness signal only works if the {@link PrismaCronLastSeenGateway}
 * reads the real `job_leases` rows the {@link CronBatchRunner} writes. A unit
 * test with a fake port cannot prove that: the column choice (`updatedAt`, not
 * `leaseUntil`), the snake_case table name in the raw SQL, and the `MIN(createdAt)`
 * grace anchor are all things only a real PostgreSQL round-trip can confirm — the
 * repository's recurring bug class (raw SQL vs. camelCase Prisma columns).
 *
 * So these tests seed leases at genuinely different ages against a disposable
 * database and assert the composed signal classifies them, then drive the real
 * runner end-to-end and assert its lease write restores liveness.
 *
 * **Validates: Requirements 20.1, 20.2, 20.3**
 */
const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const adminUrl = process.env.PARTNER_TEST_DATABASE_ADMIN_URL ?? "";
const hasPostgres = adminUrl.length > 0;

const MINUTE_MS = 60_000;

/** The real declared job names, so the test judges what production judges. */
const JOB_NAMES = Object.keys(CRON_JOB_CADENCE_SECONDS);

async function deployFromEmpty(connectionString: string): Promise<void> {
  await execFileAsync(process.execPath, ["scripts/migrate-from-empty.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, PARTNER_MIGRATION_DATABASE_URL: connectionString },
    maxBuffer: 10 * 1024 * 1024,
  });
}

/** A job's staleness threshold in ms, as the domain derives it. */
function thresholdMs(job: string): number {
  const cadence = CRON_JOB_CADENCE_SECONDS[job];
  if (cadence === undefined) throw new Error(`Unknown job ${job}`);
  return cadence * 1000 * STALENESS_CADENCE_MULTIPLIER;
}

function jobIn(snapshot: CronLivenessSnapshot, job: string) {
  const found = snapshot.jobs.find((entry) => entry.job === job);
  if (found === undefined) throw new Error(`Snapshot is missing job ${job}`);
  return found;
}

describe.runIf(hasPostgres)("Cron liveness persistence integration", () => {
  let database: DisposableTestDatabase;
  let client: PartnerDatabaseClient;
  /** Wall-clock anchor shared by the seeded rows and the service clock. */
  let now: number;

  beforeAll(async () => {
    database = await createDisposableTestDatabase(adminUrl);
    await deployFromEmpty(database.connectionString);
    client = createPartnerDatabaseClient({ databaseUrl: database.connectionString });
    await client.$connect();
  }, 120_000);

  afterAll(async () => {
    await client?.$disconnect();
    await database?.dispose();
  }, 30_000);

  beforeEach(async () => {
    // Each test owns the whole (platform-global) lease table.
    await client.jobLease.deleteMany({});
    now = Date.now();
  });

  /**
   * Seed one lease row at an explicit age. `updatedAt` is written with raw SQL
   * because Prisma's `@updatedAt` overwrites any value supplied through the
   * model API, and this test's whole point is controlling that column's age.
   */
  async function seedLease(
    job: string,
    options: { readonly lastSeenAgoMs: number; readonly createdAgoMs?: number },
  ): Promise<void> {
    const lastSeen = new Date(now - options.lastSeenAgoMs);
    const created = new Date(now - (options.createdAgoMs ?? options.lastSeenAgoMs));

    await client.$executeRaw`
      INSERT INTO job_leases (id, name, "ownerId", "leaseUntil", "cursorJson", "createdAt", "updatedAt")
      VALUES (
        ${randomUUID()}::uuid,
        ${job},
        ${`owner-${job}`},
        to_timestamp(0),
        ${JSON.stringify({ afterId: `partner-${randomUUID()}` })}::jsonb,
        ${created},
        ${lastSeen}
      )
    `;
  }

  function service(startedAgoMs = 30 * 24 * 60 * MINUTE_MS): CronLivenessService {
    return new CronLivenessService({
      version: "1.2.3",
      reader: new PrismaCronLastSeenGateway(client),
      clock: () => new Date(now),
      startedAtEpochMs: now - startedAgoMs,
    });
  }

  it("classifies real lease rows of different ages as healthy or stale", async () => {
    // Fresh: every minutely job ran a minute ago.
    await seedLease("offline-sweep", { lastSeenAgoMs: MINUTE_MS });
    await seedLease("reservation-recovery", { lastSeenAgoMs: MINUTE_MS });
    await seedLease("order-timeout", { lastSeenAgoMs: MINUTE_MS });
    // Stale: the completion sweep stopped 30 minutes ago, so held numbers are
    // never returning to sale.
    await seedLease("order-completion-sweep", { lastSeenAgoMs: 30 * MINUTE_MS });
    // Stale: earning-release stopped 2 hours ago (threshold 15 minutes), so no
    // partner can cash out.
    await seedLease("earning-release", { lastSeenAgoMs: 2 * 60 * MINUTE_MS });
    // Healthy: hourly jobs ran within their 3-hour thresholds.
    await seedLease("retention-redaction", { lastSeenAgoMs: 30 * MINUTE_MS });
    await seedLease("reconcile", { lastSeenAgoMs: 90 * MINUTE_MS });

    const snapshot = await service().liveness();

    expect(snapshot.status).toBe("degraded");
    expect([...snapshot.staleJobs].sort()).toEqual([
      "earning-release",
      "order-completion-sweep",
    ]);

    expect(jobIn(snapshot, "offline-sweep").status).toBe("healthy");
    expect(jobIn(snapshot, "reservation-recovery").status).toBe("healthy");
    expect(jobIn(snapshot, "order-timeout").status).toBe("healthy");
    expect(jobIn(snapshot, "retention-redaction").status).toBe("healthy");
    expect(jobIn(snapshot, "reconcile").status).toBe("healthy");

    const stalled = jobIn(snapshot, "earning-release");
    expect(stalled.status).toBe("stale");
    expect(stalled.ageMs).toBe(2 * 60 * MINUTE_MS);
    expect(stalled.staleAfterMs).toBe(thresholdMs("earning-release"));
    expect(stalled.reason).toContain("staleness threshold");
    expect(snapshot.version).toBe("1.2.3");
  });

  it("reads updatedAt, not leaseUntil, so a released lease still reads as fresh", async () => {
    // A healthy run RELEASES its lease, which rewrites leaseUntil to the epoch
    // (1970) precisely so the next tick can take it over. Reading that column
    // would report every well-behaved job as decades stale.
    await seedLease("offline-sweep", { lastSeenAgoMs: 30_000 });

    const row = await client.jobLease.findUnique({ where: { name: "offline-sweep" } });
    expect(row?.leaseUntil.getTime()).toBe(0);

    const snapshot = await service().liveness();
    expect(jobIn(snapshot, "offline-sweep").status).toBe("healthy");
    expect(jobIn(snapshot, "offline-sweep").ageMs).toBe(30_000);
  });

  it("classifies the threshold boundary exactly, from real rows", async () => {
    const threshold = thresholdMs("offline-sweep");
    const month = 30 * 24 * 60 * MINUTE_MS;

    /** Seed every job fresh, with `offline-sweep` at the age under test. */
    async function seedWithSweepAge(ageMs: number): Promise<void> {
      await client.jobLease.deleteMany({});
      for (const job of JOB_NAMES) {
        await seedLease(job, {
          lastSeenAgoMs: job === "offline-sweep" ? ageMs : 30_000,
          createdAgoMs: month,
        });
      }
    }

    // Exactly at the threshold: the boundary instant belongs to healthy.
    await seedWithSweepAge(threshold);
    const atBoundary = await service().liveness();

    expect(jobIn(atBoundary, "offline-sweep").ageMs).toBe(threshold);
    expect(jobIn(atBoundary, "offline-sweep").status).toBe("healthy");
    expect(atBoundary.status).toBe("healthy");
    expect(atBoundary.staleJobs).toEqual([]);

    // One millisecond past it: stale, and the only stale job.
    await seedWithSweepAge(threshold + 1);
    const pastBoundary = await service().liveness();

    expect(jobIn(pastBoundary, "offline-sweep").status).toBe("stale");
    expect(pastBoundary.status).toBe("degraded");
    expect(pastBoundary.staleJobs).toEqual(["offline-sweep"]);
  });

  it("reports jobs with no lease row as never_run once the platform is demonstrably cron-active", async () => {
    // Only one job has ever run, and its lease row is 6 hours old — so cron has
    // been active for 6 hours and every other job is genuinely missing.
    await seedLease("offline-sweep", { lastSeenAgoMs: MINUTE_MS, createdAgoMs: 6 * 60 * MINUTE_MS });

    const snapshot = await service().liveness();

    expect(jobIn(snapshot, "offline-sweep").status).toBe("healthy");
    for (const job of JOB_NAMES.filter((name) => name !== "offline-sweep")) {
      expect(jobIn(snapshot, job).status).toBe("never_run");
      expect(jobIn(snapshot, job).ageMs).toBeNull();
      expect(jobIn(snapshot, job).lastSeenAtEpochMs).toBeNull();
    }
    expect(snapshot.status).toBe("degraded");
  });

  it("derives the cron-active anchor from the oldest lease row, not the deployment", async () => {
    // A young lease row means cron only started dispatching 2 minutes ago, so a
    // just-redeployed platform must not report the other jobs as never_run —
    // even though this deployment claims a month of uptime.
    await seedLease("offline-sweep", { lastSeenAgoMs: 30_000, createdAgoMs: 2 * MINUTE_MS });

    const snapshot = await service().liveness();

    expect(snapshot.status).toBe("healthy");
    expect(jobIn(snapshot, "earning-release").status).toBe("pending_first_run");
    expect(jobIn(snapshot, "reconcile").status).toBe("pending_first_run");
  });

  it("stays healthy on a cold lease table and degrades once the deployment outlives the thresholds", async () => {
    // Nothing has ever run and this deployment is one minute old: quiet.
    const fresh = await service(MINUTE_MS).liveness();
    expect(fresh.status).toBe("healthy");
    expect(fresh.jobs.every((job) => job.status === "pending_first_run")).toBe(true);

    // Same cold table, but six hours of uptime: the scheduler was never wired up.
    const stalled = await service(6 * 60 * MINUTE_MS).liveness();
    expect(stalled.status).toBe("degraded");
    expect([...stalled.staleJobs].sort()).toEqual([...JOB_NAMES].sort());
  });

  it("surfaces a lease for an undeclared job without degrading the signal", async () => {
    for (const job of JOB_NAMES) {
      await seedLease(job, { lastSeenAgoMs: 30_000 });
    }
    await seedLease("legacy-sweep", { lastSeenAgoMs: 30 * 24 * 60 * MINUTE_MS });

    const snapshot = await service().liveness();

    expect(jobIn(snapshot, "legacy-sweep").status).toBe("unknown_job");
    expect(jobIn(snapshot, "legacy-sweep").cadenceMs).toBeNull();
    expect(snapshot.status).toBe("healthy");
    expect(snapshot.staleJobs).toEqual([]);
  });

  it("never exposes the lease cursor, owner, or tenant ids in the signal", async () => {
    // Every seeded lease carries a tenant-referencing cursor and an owner id.
    for (const job of JOB_NAMES) {
      await seedLease(job, { lastSeenAgoMs: 4 * 60 * MINUTE_MS });
    }

    const snapshot = await service().liveness();

    expect(snapshot.status).toBe("degraded");
    expect(JSON.stringify(snapshot)).not.toMatch(/owner|cursor|afterId|partner-/i);
  });

  it("restores liveness when the real CronBatchRunner runs the job", async () => {
    // Seed the job as long stale, then let the PRODUCTION runner take its lease
    // through the production lease repository. Its acquire/renew/release cycle
    // must be what refreshes `updatedAt`.
    await seedLease("offline-sweep", { lastSeenAgoMs: 4 * 60 * MINUTE_MS });

    const before = await service().liveness();
    expect(jobIn(before, "offline-sweep").status).toBe("stale");

    let ran = 0;
    const job: BatchJob = {
      name: "offline-sweep",
      async runBatch(): Promise<BatchStepResult> {
        ran += 1;
        return { processed: 0, nextCursor: null, done: true };
      },
    };

    const runner = new CronBatchRunner({
      leases: new PrismaJobLeaseRepository(client),
      clock: { nowEpochMs: () => Date.now() },
      ownerIdFactory: () => randomUUID(),
    });
    const result = await runner.run(job);

    expect(result.status).toBe("completed");
    expect(ran).toBe(1);

    // Re-observe with the clock anchored at the real "now" the runner used.
    now = Date.now();
    const after = await service().liveness();

    expect(jobIn(after, "offline-sweep").status).toBe("healthy");
    expect(jobIn(after, "offline-sweep").ageMs).toBeLessThan(thresholdMs("offline-sweep"));
    expect(after.staleJobs).not.toContain("offline-sweep");
  });
});
