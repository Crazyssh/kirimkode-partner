import { $Enums, type PrismaClient } from "@/generated/prisma";

import type {
  EarningReleaseGateway,
  ReleasableEarningRow,
} from "@application/cron-jobs";

/**
 * Prisma-backed read gateway for the `earning-release` job (task 16.3).
 *
 * Resolves a bounded, id-ordered page of `pending` Earnings whose 24h hold has
 * elapsed (`availableAt <= now`), so the job can drive each `pending →
 * available` through the shared task 14.2 hold-release command. A job lease is
 * platform-global (task 16.1), so this adapter binds to the raw Prisma client
 * rather than a `TenantContext` and returns each earning's `partnerId` for the
 * tenant-scoped command. This gateway only reads ids; the release itself (the
 * projection CAS + zero-sum ledger append) lives entirely in the shared
 * command, so no financial rule leaks here. Raw Prisma never leaves this module.
 */
export class PrismaEarningReleaseGateway implements EarningReleaseGateway {
  private readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  async listReleasableEarnings(input: {
    readonly nowEpochMs: number;
    readonly limit: number;
    readonly afterId: string | null;
  }): Promise<readonly ReleasableEarningRow[]> {
    const earnings = await this.client.partnerEarning.findMany({
      where: {
        status: $Enums.PartnerEarningStatus.PENDING,
        availableAt: { lte: new Date(input.nowEpochMs) },
        ...(input.afterId === null ? {} : { id: { gt: input.afterId } }),
      },
      select: { id: true, partnerId: true },
      orderBy: { id: "asc" },
      take: input.limit,
    });
    return earnings.map((earning) => ({
      earningId: earning.id,
      partnerId: earning.partnerId,
    }));
  }
}
