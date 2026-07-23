import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { withDisposableTestDatabase } from "./disposable-database";

const hasPostgresAdmin = Boolean(process.env.PARTNER_TEST_DATABASE_ADMIN_URL);

// **Validates: Requirements 1.1, 20.2**
describe.runIf(hasPostgresAdmin)("disposable PostgreSQL database", () => {
  it("creates an isolated empty database and disposes it", async () => {
    await withDisposableTestDatabase(async (database) => {
      const client = new Client({ connectionString: database.connectionString });
      await client.connect();
      try {
        const result = await client.query<{ current_database: string }>(
          "SELECT current_database()",
        );
        expect(result.rows[0]?.current_database).toBe(database.databaseName);
      } finally {
        await client.end();
      }
    });
  });
});
