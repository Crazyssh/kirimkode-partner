import { Pool } from "pg";

import type { ReadinessProbe } from "@application/health/partner-health-service";

export class PostgresReadinessProbe implements ReadinessProbe {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 1_000,
      idleTimeoutMillis: 10_000,
      max: 2,
      query_timeout: 1_000,
    });
  }

  async isReady(): Promise<boolean> {
    const result = await this.pool.query<{ ready: number }>("SELECT 1 AS ready");
    return result.rows[0]?.ready === 1;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
