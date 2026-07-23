import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import {
  assertPartnerCiDatabaseUrl,
  assertPartnerRepository,
  scanMigrationDirectory,
} from "./lib/migration-safety.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
assertPartnerRepository(packageJson.name, repositoryRoot);

const databaseUrl = assertPartnerCiDatabaseUrl(
  process.env.PARTNER_MIGRATION_DATABASE_URL,
);
const client = new Client({ connectionString: databaseUrl.toString() });
await client.connect();
try {
  const identity = await client.query("SELECT current_database() AS name");
  const connectedDatabase = identity.rows[0]?.name;
  if (connectedDatabase !== databaseUrl.pathname.slice(1)) {
    throw new Error(`Connected to unexpected database: ${connectedDatabase}`);
  }

  const existing = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
  `);
  if (existing.rows[0]?.count !== 0) {
    throw new Error("Partner migration-from-empty target is not empty");
  }
} finally {
  await client.end();
}

const migrationsRoot = path.join(repositoryRoot, "prisma", "migrations");
const violations = await scanMigrationDirectory(migrationsRoot);
if (violations.length > 0) {
  throw new Error("Destructive Partner migration SQL detected; run npm run migration:check");
}

const schemaPath = path.join(repositoryRoot, "prisma", "schema.prisma");
if (!existsSync(schemaPath)) {
  console.log("No Partner Prisma schema yet; empty migration baseline verified.");
  process.exit(0);
}

const prismaCli = path.join(repositoryRoot, "node_modules", "prisma", "build", "index.js");
if (!existsSync(prismaCli)) {
  throw new Error("Partner Prisma schema exists but the pinned local Prisma CLI is unavailable");
}

const migration = spawnSync(
  process.execPath,
  [prismaCli, "migrate", "deploy", "--schema", schemaPath],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PARTNER_DATABASE_URL: databaseUrl.toString(),
    },
    stdio: "inherit",
  },
);
if (migration.error) throw migration.error;
if (migration.status !== 0) {
  throw new Error(`Partner migration-from-empty failed with exit code ${migration.status}`);
}
console.log("Partner migrations applied successfully from an empty database.");
