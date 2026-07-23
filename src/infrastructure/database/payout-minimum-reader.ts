import type { PayoutMinimumReader } from "@application/payouts/ports";

import type { PartnerDatabaseExecutor } from "./client";

/**
 * Prisma-backed {@link PayoutMinimumReader} (task 14.3).
 *
 * Reads the admin-editable `minimumPayoutIdr` from the single active
 * {@link PlatformConfig} — the row whose `activeKey` slot is set and whose
 * `retiredAt` is null; when several ever qualify we take the highest `version`
 * — mirroring how the reservation and portal gateways select the active config
 * (requirement 8.5: a newer config is published as a fresh version, never
 * mutated in place, so this projection is always a read). Returns `null` when
 * no active config exists so the payout-request service can fall back to the
 * domain minimum. Raw Prisma never leaves this adapter.
 */
export class PrismaPayoutMinimumReader implements PayoutMinimumReader {
  private readonly executor: PartnerDatabaseExecutor;

  constructor(executor: PartnerDatabaseExecutor) {
    this.executor = executor;
  }

  async readMinimumPayoutIdr(): Promise<number | null> {
    const config = await this.executor.platformConfig.findFirst({
      where: { retiredAt: null, activeKey: { not: null } },
      orderBy: { version: "desc" },
      select: { minimumPayoutIdr: true },
    });
    return config?.minimumPayoutIdr ?? null;
  }
}
