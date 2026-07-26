import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { scanMigrationSql } from "../../scripts/lib/migration-safety.mjs";

const root = process.cwd();
const migrationName = "20260722000100_partner_baseline";
let migration = "";
let seed = "";
let seedRunner = "";
let roleTemplate = "";

beforeAll(async () => {
  [migration, seed, seedRunner, roleTemplate] = await Promise.all([
    readFile(path.join(root, "prisma/migrations", migrationName, "migration.sql"), "utf8"),
    readFile(path.join(root, "prisma/seed.sql"), "utf8"),
    readFile(path.join(root, "prisma/seed.mjs"), "utf8"),
    readFile(path.join(root, "prisma/admin/partner-role-grants.sql.template"), "utf8"),
  ]);
});

// **Validates: Requirements 8.2, 16.5, 19.4, 22.3, 22.4, 23.1**
describe("Task 3.4 Partner baseline migration and seed", () => {
  it("keeps the canonical Partner baseline first and every later migration additive", async () => {
    // The baseline is no longer the only migration: an applied schema evolves
    // through NEW additive migrations, never by editing the baseline in place —
    // an in-place edit keeps its recorded name, so Prisma never re-applies it and
    // already-migrated databases silently drift from the file on disk.
    const entries = await readdir(path.join(root, "prisma/migrations"), { withFileTypes: true });
    const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    expect(names[0]).toBe(migrationName);
    // Every migration, not just the baseline, must be free of destructive SQL.
    for (const name of names) {
      const sql = await readFile(path.join(root, "prisma/migrations", name, "migration.sql"), "utf8");
      expect(scanMigrationSql(sql, `${name}/migration.sql`)).toEqual([]);
    }
    expect(scanMigrationSql(migration, `${migrationName}/migration.sql`)).toEqual([]);
    expect(migration).not.toMatch(/\b(?:CREATE|ALTER|GRANT|REVOKE|CONNECT)\b[^;]*\bDATABASE\s+"?kirimkode"?(?:\s|;)/i);
  });

  it("materializes deferred CHECK, partial unique, immutable, and append-only guards", () => {
    for (const marker of [
      "platform_configs_policy_check", "partner_numbers_active_canonical_check",
      "partner_offers_active_dimension_check", "order_snapshots_financial_check",
      "partner_orders_one_active_per_number_key", "order_snapshots_immutable",
      "platform_configs_immutable", "ledger_transactions_append_only", "ledger_entries_append_only",
    ]) expect(migration).toContain(marker);
    expect(migration).toMatch(/WHERE "status" IN \('created', 'reserved', 'waiting_sms'\)/);
  });

  it("defers transaction-wide financial and reconciliation consistency checks", () => {
    for (const marker of [
      "partner_earnings_match_snapshot", "ledger_transactions_balanced", "ledger_entries_balanced",
      "partner_payouts_financial_consistency", "payout_allocations_financial_consistency",
      "partner_payouts_paid_check", "partner_payouts_snapshot_immutable",
      "reconciliation_issues_resolution_check", "reconciliation_resolution_same_partner",
    ]) expect(migration).toContain(marker);
    expect(migration.match(/DEFERRABLE INITIALLY DEFERRED/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("defines an immutable idempotent MVP configuration seed with exact values", () => {
    expect(seed).toContain("ON CONFLICT (\"version\") DO NOTHING");
    expect(seed).not.toMatch(/ON CONFLICT[\s\S]*DO UPDATE/i);
    expect(seed).toContain("PlatformConfig version 1 exists with non-MVP values");
    for (const value of [
      "'wa', 'ID', 'any', 'IDR'", "500, 5000, 250, 1500, 50", "30, 90, 30, 1200, 180, 30, 86400, 1000",
      "7, 24, 30, 90, 2557, 2557", "{\"partnerIds\":[]}",
    ]) expect(seed).toContain(value);
    expect(seedRunner).toContain('decodeURIComponent(databaseUrl.pathname) !== "/kirimkode_partner"');
    expect(seedRunner).toContain('identity.rows[0]?.name !== "kirimkode_partner"');
  });

  it("guards administrator role setup and grants only Partner schema objects", () => {
    expect(roleTemplate).toContain("current_database() = :'partner_database'");
    expect(roleTemplate).toContain("pg_database_owner");
    expect(roleTemplate).toContain("kirimkode_partner_app");
    expect(roleTemplate).toContain("GRANT CONNECT ON DATABASE kirimkode_partner TO kirimkode_partner_app");
    expect(roleTemplate).toContain("GRANT USAGE ON SCHEMA public TO kirimkode_partner_app");
    expect(roleTemplate).toContain("REVOKE UPDATE, DELETE ON TABLE order_snapshots, platform_configs, ledger_transactions, ledger_entries");
    expect(roleTemplate).toContain("has_database_privilege(:'partner_app_role', database_catalog.oid, 'CONNECT')");
    expect(roleTemplate).toContain("Refusing setup: kirimkode_partner_app can CONNECT to Main database kirimkode");
    expect(roleTemplate).not.toMatch(/(?:GRANT|REVOKE|CREATE|ALTER)\b[^;\n]*\bDATABASE\s+"?kirimkode"?(?:\s|;)/i);
  });
});