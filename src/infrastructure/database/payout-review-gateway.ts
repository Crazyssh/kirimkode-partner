import { $Enums, Prisma } from "@/generated/prisma";

import type { PayoutStatus } from "@domain/task-5-6";
import type { AuditActorType } from "@domain/task-5-7";
import {
  type AuditWriteInput,
  type PayoutAdminRecord,
  type PayoutAdminRepository,
  type RecordPayoutTransitionInput,
  type UpdatePayoutStatusInput,
  type UpdatePayoutStatusResult,
} from "@application/payouts/ports";

import { hashActorRef, PrismaAuditEventRepository } from "./audit-event-repository";
import type { PartnerDatabaseExecutor, PartnerTransactionClient } from "./client";

const ACTOR_TYPE_TO_DB: Readonly<Record<AuditActorType, $Enums.AuditActorType>> = {
  partner_member: $Enums.AuditActorType.PARTNER_MEMBER,
  partner_admin: $Enums.AuditActorType.PARTNER_ADMIN,
  device: $Enums.AuditActorType.DEVICE,
  system: $Enums.AuditActorType.SYSTEM,
};

/** Map a pure-domain payout status onto its persisted Prisma enum. */
const PAYOUT_STATUS_TO_DB: Readonly<
  Record<PayoutStatus, $Enums.PartnerPayoutStatus>
> = {
  requested: $Enums.PartnerPayoutStatus.REQUESTED,
  approved: $Enums.PartnerPayoutStatus.APPROVED,
  processing: $Enums.PartnerPayoutStatus.PROCESSING,
  paid: $Enums.PartnerPayoutStatus.PAID,
  rejected: $Enums.PartnerPayoutStatus.REJECTED,
  failed: $Enums.PartnerPayoutStatus.FAILED,
};

/** Map a persisted Prisma payout status back onto the pure-domain status. */
const PAYOUT_STATUS_FROM_DB: Readonly<
  Record<$Enums.PartnerPayoutStatus, PayoutStatus>
> = {
  REQUESTED: "requested",
  APPROVED: "approved",
  PROCESSING: "processing",
  PAID: "paid",
  REJECTED: "rejected",
  FAILED: "failed",
};

/** True when a Prisma error is a unique-constraint violation (P2002). */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

/**
 * Prisma-backed {@link PayoutAdminRepository} for the Partner Admin payout
 * review + settlement transitions (task 14.4).
 *
 * The review service reuses the task 14.1 ledger and Earning projection
 * repositories on the SAME transaction handle; this adapter supplies the
 * payout-specific reads/writes — loading the payout with its allocations,
 * compare-and-setting the payout status (with the settlement fields on `paid`
 * and the failure reason on `rejected`/`failed`), the `PayoutTransition`, and
 * the audit event — so the whole transition commits atomically (requirements
 * 14.3–14.7, 16.6).
 *
 * The payout is read by id because the Partner Admin realm is global (an admin
 * has no `partnerId`); every write then folds in the payout's own trusted
 * `partnerId`. Payment-reference uniqueness (requirement 14.6) is enforced by
 * the unique `paymentReference` column: a collision on it surfaces as a
 * `duplicate_reference` outcome rather than a thrown error. Raw Prisma never
 * leaves this adapter.
 */
export class PrismaPayoutReviewGateway
  implements PayoutAdminRepository<PartnerTransactionClient>
{
  private readonly executor: PartnerDatabaseExecutor;

  constructor(executor: PartnerDatabaseExecutor) {
    this.executor = executor;
  }

  async findPayoutForReview(
    payoutId: string,
  ): Promise<PayoutAdminRecord | null> {
    const row = await this.executor.partnerPayout.findUnique({
      where: { id: payoutId },
      select: {
        id: true,
        partnerId: true,
        status: true,
        amountIdr: true,
        paymentReference: true,
        allocations: {
          select: { earningId: true, amountIdr: true },
        },
      },
    });
    if (row === null) return null;
    return {
      id: row.id,
      partnerId: row.partnerId,
      status: PAYOUT_STATUS_FROM_DB[row.status],
      amountIdr: row.amountIdr,
      paymentReference: row.paymentReference,
      allocations: row.allocations.map((allocation) => ({
        earningId: allocation.earningId,
        amountIdr: allocation.amountIdr,
      })),
    };
  }

  async updatePayoutStatus(
    tx: PartnerTransactionClient,
    input: UpdatePayoutStatusInput,
  ): Promise<UpdatePayoutStatusResult> {
    try {
      // Compare-and-set on the current status: only the row still at
      // `expectedStatus` for this payout is advanced, so a concurrent or retried
      // transition matches zero rows and is reported as a no-op.
      const updated = await tx.partnerPayout.updateMany({
        where: {
          id: input.payoutId,
          partnerId: input.partnerId,
          status: PAYOUT_STATUS_TO_DB[input.expectedStatus],
        },
        data: {
          status: PAYOUT_STATUS_TO_DB[input.nextStatus],
          ...(input.paymentReference === undefined
            ? {}
            : { paymentReference: input.paymentReference }),
          ...(input.paidAtEpochMs === undefined
            ? {}
            : { paidAt: new Date(input.paidAtEpochMs) }),
          ...(input.processedByAdminId === undefined
            ? {}
            : { processedByAdminId: input.processedByAdminId }),
          ...(input.failureReason === undefined
            ? {}
            : { failureReason: input.failureReason }),
        },
      });
      return updated.count === 1 ? { outcome: "updated" } : { outcome: "no_op" };
    } catch (error) {
      // The unique `paymentReference` slot is already taken by another payout
      // (requirement 14.6); surface a stable conflict without leaking it.
      if (isUniqueViolation(error)) {
        return { outcome: "duplicate_reference" };
      }
      throw error;
    }
  }

  async recordTransition(
    tx: PartnerTransactionClient,
    partnerId: string,
    input: RecordPayoutTransitionInput,
  ): Promise<void> {
    await tx.payoutTransition.create({
      data: {
        id: input.id,
        partnerId,
        payoutId: input.payoutId,
        fromStatus: PAYOUT_STATUS_TO_DB[input.fromStatus],
        toStatus: PAYOUT_STATUS_TO_DB[input.toStatus],
        actorType: ACTOR_TYPE_TO_DB[input.actorType],
        actorRefHash: hashActorRef(input.actorRef),
        reason: input.reason,
        operationKey: input.operationKey,
        createdAt: new Date(input.occurredAtEpochMs),
      },
    });
  }

  async recordAudit(
    tx: PartnerTransactionClient,
    input: AuditWriteInput,
  ): Promise<void> {
    const audit = new PrismaAuditEventRepository(tx);
    await audit.record({
      id: input.id,
      partnerId: input.partnerId,
      requestId: input.requestId,
      descriptor: input.descriptor,
    });
  }
}
