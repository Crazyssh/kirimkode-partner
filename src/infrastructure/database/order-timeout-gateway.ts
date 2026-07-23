import { $Enums, type PrismaClient } from "@/generated/prisma";

import type { OrderTimeoutGateway } from "@application/cron-jobs";

/**
 * Prisma-backed read gateway for the `order-timeout` job (task 16.2).
 *
 * Resolves a bounded, id-ordered page of orders that are past their 20-minute
 * expiry and still awaiting an OTP (`reserved`/`waiting_sms`, `otpKeyVersion`
 * unset), so the job can drive each to `timeout` through the shared task 9.4
 * transition command. A `success` order (OTP received) is excluded here and, as
 * defence-in-depth, rejected by the state machine inside that command. This
 * gateway only reads ids; it never writes state, so all lifecycle rules stay in
 * the shared command. Raw Prisma never leaves this module.
 */
export class PrismaOrderTimeoutGateway implements OrderTimeoutGateway {
  private readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  async listExpiredOrderIds(input: {
    readonly nowEpochMs: number;
    readonly limit: number;
    readonly afterId: string | null;
  }): Promise<readonly string[]> {
    const orders = await this.client.partnerOrder.findMany({
      where: {
        status: {
          in: [
            $Enums.PartnerOrderStatus.RESERVED,
            $Enums.PartnerOrderStatus.WAITING_SMS,
          ],
        },
        expiresAt: { lte: new Date(input.nowEpochMs) },
        otpKeyVersion: null,
        ...(input.afterId === null ? {} : { id: { gt: input.afterId } }),
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: input.limit,
    });
    return orders.map((order) => order.id);
  }
}
