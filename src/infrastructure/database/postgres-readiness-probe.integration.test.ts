import { describe, expect, it } from "vitest";

import { withDisposableTestDatabase } from "@test/disposable-database";

import { PostgresReadinessProbe } from "./postgres-readiness-probe";

const hasPostgresAdmin = Boolean(process.env.PARTNER_TEST_DATABASE_ADMIN_URL);

// **Validates: Requirements 1.4, 20.1, 20.4**
describe.runIf(hasPostgresAdmin)("PostgreSQL readiness probe", () => {
  it("checks the persisted Partner database with a shallow query", async () => {
    await withDisposableTestDatabase(async ({ connectionString }) => {
      const probe = new PostgresReadinessProbe(connectionString);
      try {
        await expect(probe.isReady()).resolves.toBe(true);
      } finally {
        await probe.close();
      }
    });
  });
});
