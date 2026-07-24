import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@/generated/prisma";

import type {
  AcquireLeaseInput,
  AcquiredLease,
  JobCursor,
  JobLeaseRepository,
  ReleaseLeaseInput,
  RenewLeaseInput,
} from "@application/cron/ports";

/**
 * Prisma-backed `JobLease` repository (task 16.1).
 *
 * A job lease is a platform-global row (`job_leases`, unique on `name`), not a
 * tenant-scoped aggregate, so this adapter binds to the raw Prisma client
 * rather than a `TenantContext` — mirroring the idempotency and reconciliation
 * gateways. Every operation is a single atomic, conditional SQL statement so
 * concurrent workers and crash/restart cycles stay correct (requirements 20.1,
 * 20.2, 20.5). Raw Prisma never leaves this module.
 *
 *  - `acquire` uses `INSERT ... ON CONFLICT (name) DO UPDATE ... WHERE` so the
 *    lease is inserted when absent, and on conflict is taken over *only* when
 *    the existing lease has expired or is already owned by the requester. The
 *    conditional `WHERE` runs inside the same statement, so two racing workers
 *    cannot both win — Postgres serializes the row update and the loser's
 *    `RETURNING` is empty. A takeover deliberately does not reset `"cursorJson"`,
 *    so work resumes where the crashed owner stopped.
 *  - `renew` extends the expiry (and optionally advances the cursor) only while
 *    the caller still owns an unexpired lease; a zero-row update means the lease
 *    was lost and the runner must stop.
 *  - `release` expires the lease immediately, conditioned on ownership, so a
 *    worker never releases a lease another worker has taken over.
 *
 * The `"cursorJson"` column is `jsonb`; cursors are serialized with an explicit
 * `::jsonb` cast (a `null` cursor stores SQL `NULL`), since raw-query parameters
 * are not implicitly coerced to json.
 */
interface LeaseRow {
  readonly ownerId: string;
  readonly leaseUntil: Date;
  readonly cursorJson: unknown;
}

export class PrismaJobLeaseRepository implements JobLeaseRepository {
  private readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  async acquire(input: AcquireLeaseInput): Promise<AcquiredLease | null> {
    const leaseUntil = new Date(input.leaseUntilEpochMs);
    const now = new Date(input.nowEpochMs);

    const rows = await this.client.$queryRaw<LeaseRow[]>(Prisma.sql`
      INSERT INTO job_leases (id, name, "ownerId", "leaseUntil", "cursorJson", "createdAt", "updatedAt")
      VALUES (${randomUUID()}::uuid, ${input.name}, ${input.ownerId}, ${leaseUntil}, NULL, now(), now())
      ON CONFLICT (name) DO UPDATE
        SET "ownerId" = ${input.ownerId},
            "leaseUntil" = ${leaseUntil},
            "updatedAt" = now()
        WHERE job_leases."leaseUntil" <= ${now}
           OR job_leases."ownerId" = ${input.ownerId}
      RETURNING "ownerId" AS "ownerId", "leaseUntil" AS "leaseUntil", "cursorJson" AS "cursorJson"
    `);

    const row = rows[0];
    if (row === undefined) return null;

    return Object.freeze({
      name: input.name,
      ownerId: row.ownerId,
      leaseUntilEpochMs: row.leaseUntil.getTime(),
      cursor: (row.cursorJson ?? null) as JobCursor,
    });
  }

  async renew(input: RenewLeaseInput): Promise<boolean> {
    const leaseUntil = new Date(input.leaseUntilEpochMs);
    const now = new Date();

    // A renewal only succeeds while the caller still holds an unexpired lease.
    // When the caller advances the cursor, write it in the same statement so a
    // crash after this point resumes from the advanced position.
    const cursorAssignment = "cursor" in input
      ? Prisma.sql`, "cursorJson" = ${cursorSql(input.cursor ?? null)}`
      : Prisma.empty;

    const affected = await this.client.$executeRaw(Prisma.sql`
      UPDATE job_leases
      SET "leaseUntil" = ${leaseUntil},
          "updatedAt" = now()${cursorAssignment}
      WHERE name = ${input.name}
        AND "ownerId" = ${input.ownerId}
        AND "leaseUntil" > ${now}
    `);

    return affected > 0;
  }

  async release(input: ReleaseLeaseInput): Promise<void> {
    // Expire the lease immediately (epoch) so the next tick can take it over,
    // but only while we still own it — never release another worker's lease.
    await this.client.$executeRaw(Prisma.sql`
      UPDATE job_leases
      SET "leaseUntil" = to_timestamp(0),
          "updatedAt" = now()
      WHERE name = ${input.name}
        AND "ownerId" = ${input.ownerId}
    `);
  }
}

/**
 * Build the `"cursorJson"` value fragment. A `null` cursor clears the column to
 * SQL `NULL`; any other cursor is serialized and cast to `jsonb`.
 */
function cursorSql(cursor: JobCursor): Prisma.Sql {
  if (cursor === null) return Prisma.sql`NULL`;
  return Prisma.sql`${JSON.stringify(cursor)}::jsonb`;
}
