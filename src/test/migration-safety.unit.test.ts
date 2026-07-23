import { describe, expect, it } from "vitest";

import {
  assertPartnerCiDatabaseUrl,
  assertPartnerRepository,
  scanMigrationSql,
} from "../../scripts/lib/migration-safety.mjs";

// **Validates: Requirements 1.1, 22.3, 22.6**
describe("Partner migration safety", () => {
  it("accepts additive SQL and ignores destructive words in comments", () => {
    const sql = `
      -- DROP TABLE legacy;
      /* TRUNCATE TABLE audit; */
      CREATE TABLE partner_device (id UUID PRIMARY KEY);
      ALTER TABLE partner_device ADD COLUMN label TEXT;
    `;

    expect(scanMigrationSql(sql)).toEqual([]);
  });

  it.each([
    ["DROP", "DROP TABLE partner_device;"],
    ["DROP", "DROP SCHEMA public CASCADE;"],
    ["TRUNCATE", "truncate table partner_device;"],
    ["TRUNCATE", "TRUNCATE ONLY partner_device RESTART IDENTITY;"],
    ["DROP", "ALTER TABLE partner_device DROP COLUMN label;"],
    ["DROP", "ALTER TABLE partner_device DROP COLUMN IF EXISTS label;"],
  ])("rejects destructive %s SQL", (keyword, sql) => {
    expect(scanMigrationSql(sql, "001/migration.sql")).toEqual([
      expect.objectContaining({ keyword, source: "001/migration.sql" }),
    ]);
  });

  it("only accepts disposable Partner migration database names", () => {
    for (const database of [
      "kirimkode_partner_ci_42",
      "kirimkode_partner_test_42",
    ]) {
      expect(
        assertPartnerCiDatabaseUrl(
          `postgresql://partner:secret@localhost:5432/${database}`,
        ).pathname,
      ).toBe(`/${database}`);
    }

    for (const database of [
      "kirimkode",
      "kirimkode_partner",
      "kirimkode_partner_testing",
      "postgres",
    ]) {
      expect(() =>
        assertPartnerCiDatabaseUrl(
          `postgresql://partner:secret@localhost:5432/${database}`,
        ),
      ).toThrow(/Partner migration database/);
    }
  });

  it("refuses execution outside the Partner repository", () => {
    expect(() =>
      assertPartnerRepository("@kirimkode/main-platform", "C:/repo/kirimkode-partner"),
    ).toThrow(/package/);
    expect(() =>
      assertPartnerRepository("@kirimkode/partner-platform", "C:/repo/main-platform"),
    ).toThrow(/directory/);
  });
});
