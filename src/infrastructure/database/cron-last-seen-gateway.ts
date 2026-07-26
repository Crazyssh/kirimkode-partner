import { Prisma, type PrismaClient } from "@/generated/prisma";

import type {
  CronLastSeenReader,
  CronLastSeenSnapshot,
} from "@application/health/cron-liveness-service";

/**
 * Prisma-backed reader for the cron liveness signal (requirement 20.3).
 *
 * The `job_leases` table is the only durable record of background-job activity,
 * so it is the source of truth for "when did this job last run". Like the
 * {@link import("./job-lease-repository").PrismaJobLeaseRepository} it binds to
 * the raw Prisma client rather than a `TenantContext`: a lease is a
 * platform-global row, not a tenant-scoped aggregate. Raw Prisma never leaves
 * this module.
 *
 * ## Which column, and why
 *
 * `job_leases` has `ownerId`, `leaseUntil`, `cursorJson`, `createdAt`, and
 * `updatedAt`. There is no `lastSuccessAt`, so this adapter reads `updatedAt`,
 * which the schema stamps (`@updatedAt`) on every acquire, every renew, and the
 * release the runner performs in a `finally`. That makes it "a runner last
 * touched this job" — dispatch liveness, not success. It is deliberately the
 * closest honest signal the existing schema supports; no column is invented and
 * no migration is added for it.
 *
 * `leaseUntil` would be the wrong choice: a healthy release rewrites it to the
 * epoch (`to_timestamp(0)`) precisely so the next tick can take the lease over,
 * so a well-behaved job looks decades stale by that column.
 *
 * `MIN("createdAt")` is read in the same statement as the grace anchor for jobs
 * that have no row yet: it marks when cron demonstrably started dispatching and,
 * unlike a process-start timestamp, survives redeploys.
 *
 * `cursorJson` is never selected — it references tenant rows and has no place in
 * an operational health payload.
 */
interface LastSeenRow {
  readonly name: string;
  readonly updatedAt: Date;
}

interface OldestRow {
  readonly oldest: Date | null;
}

export class PrismaCronLastSeenGateway implements CronLastSeenReader {
  private readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  async readLastSeen(): Promise<CronLastSeenSnapshot> {
    // Seven rows at most (one per registered job), so an unbounded select is
    // safe here; ordering by name keeps the payload deterministic.
    const [rows, oldest] = await Promise.all([
      this.client.$queryRaw<LastSeenRow[]>(Prisma.sql`
        SELECT name AS "name", "updatedAt" AS "updatedAt"
        FROM job_leases
        ORDER BY name ASC
      `),
      this.client.$queryRaw<OldestRow[]>(Prisma.sql`
        SELECT MIN("createdAt") AS "oldest" FROM job_leases
      `),
    ]);

    const oldestCreatedAt = oldest[0]?.oldest ?? null;

    return Object.freeze({
      jobs: Object.freeze(
        rows.map((row) =>
          Object.freeze({
            job: row.name,
            lastSeenAtEpochMs: row.updatedAt.getTime(),
          }),
        ),
      ),
      oldestLeaseCreatedAtEpochMs:
        oldestCreatedAt === null ? null : oldestCreatedAt.getTime(),
    });
  }
}
