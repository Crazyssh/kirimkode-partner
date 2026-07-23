import { describe, expect, it } from "vitest";

import { createTestDatabaseName, databaseUrlFor } from "./disposable-database";

// **Validates: Requirements 1.1, 20.2**
describe("disposable database safety", () => {
  it("generates a dedicated Partner test database name", () => {
    expect(createTestDatabaseName("ABC-123")).toBe(
      "kirimkode_partner_test_abc_123",
    );
  });

  it("replaces the admin database without retaining schema options", () => {
    const url = databaseUrlFor(
      "postgresql://tester:secret@localhost:5432/postgres?schema=public&sslmode=disable",
      "kirimkode_partner_test_example",
    );
    const parsed = new URL(url);

    expect(parsed.pathname).toBe("/kirimkode_partner_test_example");
    expect(parsed.searchParams.has("schema")).toBe(false);
    expect(parsed.searchParams.get("sslmode")).toBe("disable");
  });

  it("refuses names outside the disposable test namespace", () => {
    expect(() => databaseUrlFor("postgresql://localhost/postgres", "kirimkode_partner"))
      .toThrow("Refusing unsafe test database name");
  });
});
