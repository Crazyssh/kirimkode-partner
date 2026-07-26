import { $Enums, type PrismaClient } from "@/generated/prisma";

import type { OrderCompletionSweepGateway } from "@application/cron-jobs";

/**
 * Prisma-backed read gateway for the `order-completion-sweep` job (listening
 * window).
 *
 * Resolves a bounded, id-ordered page of orders whose listening window has
 * closed — `success`, `completedAt` still unset (the number hold was never
 * released), and past `expiresAt` — so the job can release each hold through the
 * shared task 9.4 completion command. There is a dedicated partial index for
 * exactly this predicate (`partner_orders_listening_idx` on `expiresAt` WHERE
 * `status = 'success' AND "completedAt" IS NULL`), so the scan stays cheap as the
 * order table grows.
 *
 * The `expiresAt` comparison is strict (`<`, not `<=`). The listening window is
 * inclusive of its deadline, so the pure release decision rejects an
 * `expiry_sweep` observed exactly at `expiresAt`; because the job replays a
 * constant Idempotency-Key per order, that rejection would be persisted and
 * replayed forever, permanently stranding the number. Excluding the boundary here
 * guarantees every row returned is one the command will accept.
 *
 * This gateway only reads ids; it never writes state, so all lifecycle rules stay
 * in the shared command. Raw Prisma never leaves this module.
 */
export class PrismaOrderCompletionSweepGateway implements OrderCompletionSweepGateway {
  private readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  async listExpiredListeningOrderIds(input: {
    readonly nowEpochMs: number;
    readonly limit: number;
    readonly afterId: string | null;
  }): Promise<readonly string[]> {
    const orders = await this.client.partnerOrder.findMany({
      where: {
        status: $Enums.PartnerOrderStatus.SUCCESS,
        completedAt: null,
        expiresAt: { lt: new Date(input.nowEpochMs) },
        ...(input.afterId === null ? {} : { id: { gt: input.afterId } }),
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: input.limit,
    });
    return orders.map((order) => order.id);
  }
}
