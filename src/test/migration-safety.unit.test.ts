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

  it("does not let a comment token inside a string literal hide a later destructive statement", () => {
    // The `--` lives inside a single-quoted string, so it is data, not a
    // comment; the DROP that follows the closed string is real SQL and must
    // still be flagged (the string-literal-aware masker closes this bypass).
    const sql =
      "INSERT INTO note (body) VALUES ('-- keep'); DROP TABLE partner_device;";
    expect(scanMigrationSql(sql, "001/migration.sql")).toEqual([
      expect.objectContaining({ keyword: "DROP", source: "001/migration.sql" }),
    ]);
  });

  it("keeps a doubled-quote escaped literal intact so an inner /* */ cannot mask a later TRUNCATE", () => {
    // `''` is an escaped quote, so the whole VALUES(...) is one string literal;
    // the block-comment token inside it is data and cannot hide the trailing
    // TRUNCATE that runs after the closing quote.
    const sql =
      "INSERT INTO note (body) VALUES ('it''s /* fine */'); TRUNCATE TABLE partner_device;";
    expect(scanMigrationSql(sql)).toEqual([
      expect.objectContaining({ keyword: "TRUNCATE" }),
    ]);
  });

  it("does not flag a destructive keyword that is only string-literal data", () => {
    // A DROP that is purely the contents of a string literal is data, never an
    // executed statement, so masking it avoids a false positive.
    const sql = "INSERT INTO note (body) VALUES ('DROP TABLE later');";
    expect(scanMigrationSql(sql)).toEqual([]);
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
