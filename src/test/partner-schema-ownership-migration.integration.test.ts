import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scanMigrationDirectory } from "../../scripts/lib/migration-safety.mjs";
import {
  createDisposableTestDatabase,
  type DisposableTestDatabase,
} from "./disposable-database";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const migrationName = "20260722000100_partner_baseline";
const adminUrl = process.env.PARTNER_TEST_DATABASE_ADMIN_URL ?? "";
const hasPostgres = adminUrl.length > 0;

async function deployFromEmpty(connectionString: string): Promise<void> {
  await execFileAsync(process.execPath, ["scripts/migrate-from-empty.mjs"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PARTNER_MIGRATION_DATABASE_URL: connectionString,
    },
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function deployAgain(connectionString: string): Promise<void> {
  await execFileAsync(
    process.execPath,
    [
      "node_modules/prisma/build/index.js",
      "migrate",
      "deploy",
      "--schema",
      "prisma/schema.prisma",
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, PARTNER_DATABASE_URL: connectionString },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

async function schemaObjectCounts(client: Client): Promise<Record<string, number>> {
  const result = await client.query<{ kind: string; count: number }>(`
    SELECT c.relkind::text AS kind, COUNT(*)::int AS count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'i', 'S', 'v', 'm')
    GROUP BY c.relkind
    ORDER BY c.relkind
  `);
  return Object.fromEntries(result.rows.map(({ kind, count }) => [kind, count]));
}

function roleConnectionString(
  connectionString: string,
  role: string,
  password: string,
): string {
  const url = new URL(connectionString);
  url.username = role;
  url.password = password;
  return url.toString();
}

// **Validates: Requirements 22.3, 22.4**
describe("Partner destructive migration scanner integration", () => {
  it("scans migration files while ignoring destructive words in comments", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "partner-migrations-"));
    try {
      await writeFile(
        path.join(directory, "migration.sql"),
        [
          "-- DROP TABLE ignored_comment;",
          "/* TRUNCATE TABLE ignored_block_comment; */",
          "DROP TABLE forbidden_drop;",
          "TRUNCATE TABLE forbidden_truncate;",
        ].join("\n"),
      );

      expect(await scanMigrationDirectory(directory)).toEqual([
        expect.objectContaining({ keyword: "DROP", source: "migration.sql" }),
        expect.objectContaining({ keyword: "TRUNCATE", source: "migration.sql" }),
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

// **Validates: Requirements 20.1, 22.3, 22.4**
describe.runIf(hasPostgres)("Partner schema ownership and migration", () => {
  let database: DisposableTestDatabase;

  beforeAll(async () => {
    database = await createDisposableTestDatabase(adminUrl);
    await deployFromEmpty(database.connectionString);
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  }, 30_000);

  it("applies the baseline from empty with required tables, constraints, and indexes", async () => {
    const client = new Client({ connectionString: database.connectionString });
    await client.connect();
    try {
      const tables = await client.query<{ table_name: string }>(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
      `);
      const tableNames = new Set(tables.rows.map(({ table_name }) => table_name));
      for (const table of [
        "partners",
        "partner_members",
        "partner_orders",
        "order_snapshots",
        "ledger_entries",
      ]) {
        expect(tableNames.has(table)).toBe(true);
      }

      const constraints = await client.query<{ conname: string; contype: string }>(`
        SELECT conname, contype
        FROM pg_constraint
        WHERE conname = ANY($1::text[])
      `, [[
        "partners_pkey",
        "partner_members_partnerId_fkey",
        "partner_members_security_version_check",
        "partner_offers_base_price_check",
      ]]);
      expect(Object.fromEntries(constraints.rows.map((row) => [row.conname, row.contype])))
        .toEqual({
          partner_members_partnerId_fkey: "f",
          partner_members_security_version_check: "c",
          partner_offers_base_price_check: "c",
          partners_pkey: "p",
        });

      const indexes = await client.query<{ indexname: string; indexdef: string }>(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = ANY($1::text[])
      `, [[
        "partner_members_emailNormalized_key",
        "partner_orders_one_active_per_number_key",
      ]]);
      expect(indexes.rows).toHaveLength(2);
      const activeOrderIndex = indexes.rows.find(
        ({ indexname }) => indexname === "partner_orders_one_active_per_number_key",
      )?.indexdef;
      expect(activeOrderIndex).toContain("CREATE UNIQUE INDEX");
      expect(activeOrderIndex).toContain("WHERE");
      for (const status of ["created", "reserved", "waiting_sms"]) {
        expect(activeOrderIndex).toContain(status);
      }
    } finally {
      await client.end();
    }
  });

  it("enforces foreign-key, unique, and CHECK constraints", async () => {
    const client = new Client({ connectionString: database.connectionString });
    const partnerId = randomUUID();
    const email = `owner-${randomUUID()}@example.test`;
    await client.connect();
    try {
      await client.query(`
        INSERT INTO partners (id, "legalName", "displayName", "updatedAt")
        VALUES ($1, 'Constraint Partner', 'Constraint', NOW())
      `, [partnerId]);

      await expect(client.query(`
        INSERT INTO partner_members
          (id, "partnerId", "emailNormalized", "passwordHash", role,
           "securityVersion", "updatedAt")
        VALUES ($1, $2, $3, 'hash', 'owner', 0, NOW())
      `, [randomUUID(), partnerId, `invalid-${email}`])).rejects.toMatchObject({
        code: "23514",
        constraint: "partner_members_security_version_check",
      });

      await expect(client.query(`
        INSERT INTO partner_members
          (id, "partnerId", "emailNormalized", "passwordHash", role,
           "securityVersion", "updatedAt")
        VALUES ($1, $2, $3, 'hash', 'owner', 1, NOW())
      `, [randomUUID(), randomUUID(), `missing-${email}`])).rejects.toMatchObject({
        code: "23503",
        constraint: "partner_members_partnerId_fkey",
      });

      await client.query(`
        INSERT INTO partner_members
          (id, "partnerId", "emailNormalized", "passwordHash", role,
           "securityVersion", "updatedAt")
        VALUES ($1, $2, $3, 'hash', 'owner', 1, NOW())
      `, [randomUUID(), partnerId, email]);
      await expect(client.query(`
        INSERT INTO partner_members
          (id, "partnerId", "emailNormalized", "passwordHash", role,
           "securityVersion", "updatedAt")
        VALUES ($1, $2, $3, 'hash', 'member', 1, NOW())
      `, [randomUUID(), partnerId, email])).rejects.toMatchObject({
        code: "23505",
        constraint: "partner_members_emailNormalized_key",
      });
    } finally {
      await client.end();
    }
  });

  it("rolls back writes without leaving partial Partner state", async () => {
    const client = new Client({ connectionString: database.connectionString });
    const partnerId = randomUUID();
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO partners (id, "legalName", "displayName", "updatedAt")
        VALUES ($1, 'Rollback Partner', 'Rollback', NOW())
      `, [partnerId]);
      await client.query("ROLLBACK");

      const result = await client.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM partners WHERE id = $1",
        [partnerId],
      );
      expect(result.rows[0]?.count).toBe(0);
    } finally {
      await client.end();
    }
  });

  it("reapplies the migration idempotently without duplicating schema objects", async () => {
    const client = new Client({ connectionString: database.connectionString });
    await client.connect();
    try {
      const before = await schemaObjectCounts(client);
      await deployAgain(database.connectionString);
      const after = await schemaObjectCounts(client);
      expect(after).toEqual(before);

      // Re-deploying records no duplicate rows: the ledger of applied
      // migrations is exactly the set on disk, baseline first. Later additive
      // migrations are the correct way to evolve an already-applied schema, so
      // this asserts the ORDER and the set — never a fixed count of one.
      const applied = await client.query<{ migration_name: string }>(`
        SELECT migration_name
        FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        ORDER BY migration_name
      `);
      const onDisk = (await readdir(path.join(repositoryRoot, "prisma/migrations"), {
        withFileTypes: true,
      }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      expect(applied.rows.map((row) => row.migration_name)).toEqual(onDisk);
      expect(onDisk[0]).toBe(migrationName);
    } finally {
      await client.end();
    }
  }, 60_000);

  it("grants the app role Partner access but no cross-database access", async ({ skip }) => {
    const administrator = new Client({ connectionString: adminUrl });
    await administrator.connect();
    const capability = await administrator.query<{ can_create_role: boolean }>(`
      SELECT rolsuper OR rolcreaterole AS can_create_role
      FROM pg_roles WHERE rolname = current_user
    `);
    if (!capability.rows[0]?.can_create_role) {
      await administrator.end();
      skip("PostgreSQL administrator lacks CREATEROLE; role isolation test skipped");
      return;
    }

    const role = `kirimkode_partner_test_role_${randomUUID().replaceAll("-", "")}`;
    const password = randomUUID().replaceAll("-", "");
    const identifier = `"${role}"`;
    let otherDatabase: DisposableTestDatabase | undefined;
    let partnerAdministrator: Client | undefined;
    let partnerRoleClient: Client | undefined;
    let roleCreated = false;

    try {
      await administrator.query(`
        CREATE ROLE ${identifier}
        LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
        PASSWORD '${password}'
      `);
      roleCreated = true;
      otherDatabase = await createDisposableTestDatabase(adminUrl);
      await administrator.query(
        `REVOKE CONNECT ON DATABASE "${otherDatabase.databaseName}" FROM PUBLIC`,
      );

      partnerAdministrator = new Client({ connectionString: database.connectionString });
      await partnerAdministrator.connect();
      await partnerAdministrator.query(
        `REVOKE ALL ON DATABASE "${database.databaseName}" FROM PUBLIC`,
      );
      await partnerAdministrator.query(
        `GRANT CONNECT ON DATABASE "${database.databaseName}" TO ${identifier}`,
      );
      await partnerAdministrator.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
      await partnerAdministrator.query(`GRANT USAGE ON SCHEMA public TO ${identifier}`);
      await partnerAdministrator.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${identifier}`,
      );
      await partnerAdministrator.query(`
        REVOKE UPDATE, DELETE ON TABLE
          order_snapshots, platform_configs, ledger_transactions, ledger_entries
        FROM ${identifier}
      `);

      partnerRoleClient = new Client({
        connectionString: roleConnectionString(
          database.connectionString,
          role,
          password,
        ),
      });
      await partnerRoleClient.connect();
      expect(
        (await partnerRoleClient.query<{ name: string }>(
          "SELECT current_database() AS name",
        )).rows[0]?.name,
      ).toBe(database.databaseName);
      const partnerId = randomUUID();
      await partnerRoleClient.query(`
        INSERT INTO partners (id, "legalName", "displayName", "updatedAt")
        VALUES ($1, 'Role Partner', 'Role Test', NOW())
      `, [partnerId]);
      expect(
        (await partnerRoleClient.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM partners WHERE id = $1",
          [partnerId],
        )).rows[0]?.count,
      ).toBe(1);

      const immutablePrivileges = await partnerRoleClient.query<{
        can_update: boolean;
        can_delete: boolean;
      }>(`
        SELECT
          has_table_privilege(current_user, 'platform_configs', 'UPDATE') AS can_update,
          has_table_privilege(current_user, 'platform_configs', 'DELETE') AS can_delete
      `);
      expect(immutablePrivileges.rows[0]).toEqual({
        can_delete: false,
        can_update: false,
      });

      await expect(
        partnerRoleClient.query(
          "UPDATE platform_configs SET version = version WHERE false",
        ),
      ).rejects.toMatchObject({ code: "42501" });

      const forbiddenClient = new Client({
        connectionString: roleConnectionString(
          otherDatabase.connectionString,
          role,
          password,
        ),
      });
      try {
        await expect(forbiddenClient.connect()).rejects.toMatchObject({
          code: "42501",
        });
      } finally {
        await forbiddenClient.end().catch(() => undefined);
      }
    } finally {
      await partnerRoleClient?.end().catch(() => undefined);
      if (partnerAdministrator) {
        if (roleCreated) {
          await partnerAdministrator
            .query(`DROP OWNED BY ${identifier}`)
            .catch(() => undefined);
        }
        await partnerAdministrator.end().catch(() => undefined);
      }
      await otherDatabase?.dispose().catch(() => undefined);
      if (roleCreated) {
        await administrator
          .query(`DROP ROLE IF EXISTS ${identifier}`)
          .catch(() => undefined);
      }
      await administrator.end().catch(() => undefined);
    }
  }, 60_000);
});