import { randomUUID } from "node:crypto";
import { Client } from "pg";

const SAFE_TEST_DATABASE = /^kirimkode_partner_test_[a-z0-9_]+$/;

export interface DisposableTestDatabase {
  readonly connectionString: string;
  readonly databaseName: string;
  dispose(): Promise<void>;
}

export function createTestDatabaseName(suffix: string = randomUUID()): string {
  const normalized = suffix.toLowerCase().replaceAll(/[^a-z0-9]/g, "_");
  return `kirimkode_partner_test_${normalized}`;
}

export function databaseUrlFor(adminUrl: string, databaseName: string): string {
  assertSafeTestDatabaseName(databaseName);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  url.searchParams.delete("schema");
  return url.toString();
}

function assertSafeTestDatabaseName(databaseName: string): void {
  if (!SAFE_TEST_DATABASE.test(databaseName)) {
    throw new Error(`Refusing unsafe test database name: ${databaseName}`);
  }
}

export async function createDisposableTestDatabase(
  adminUrl = process.env.PARTNER_TEST_DATABASE_ADMIN_URL,
): Promise<DisposableTestDatabase> {
  if (!adminUrl) {
    throw new Error("PARTNER_TEST_DATABASE_ADMIN_URL is required");
  }

  const databaseName = createTestDatabaseName();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }

  let disposed = false;
  return {
    connectionString: databaseUrlFor(adminUrl, databaseName),
    databaseName,
    async dispose() {
      if (disposed) return;
      disposed = true;
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      try {
        await cleanup.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [databaseName],
        );
        await cleanup.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

export async function withDisposableTestDatabase<T>(
  run: (database: DisposableTestDatabase) => Promise<T>,
): Promise<T> {
  const database = await createDisposableTestDatabase();
  try {
    return await run(database);
  } finally {
    await database.dispose();
  }
}