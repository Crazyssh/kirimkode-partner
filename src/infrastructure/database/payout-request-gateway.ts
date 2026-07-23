import { $Enums, Prisma } from "@/generated/prisma";

import type { PayoutAllocation } from "@domain/task-5-6";
import type { AuditActorType } from "@domain/task-5-7";
import {
  EarningAlreadyAllocatedError,
  type AuditWriteInput,
  type NewPartnerPayout,
  type NewPayoutTransition,
  type PayoutDestinationRecord,
  type PayoutRequestRepository,
} from "@application/payouts/ports";

import { hashActorRef, PrismaAuditEventRepository } from "./audit-event-repository";
import type { PartnerDatabaseExecutor, PartnerTransactionClient } from "./client";

const ACTOR_TYPE_TO_DB: Readonly<Record<AuditActorType, $Enums.AuditActorType>> = {
  partner_member: $Enums.AuditActorType.PARTNER_MEMBER,
  partner_admin: $Enums.AuditActorType.PARTNER_ADMIN,
  device: $Enums.AuditActorType.DEVICE,
  system: $Enums.AuditActorType.SYSTEM,
};

/** True when a Prisma error is a unique-constraint violation (P2002). */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

/**
 * Prisma-backed {@link PayoutRequestRepository} for the atomic payout request
 * (task 14.3).
 *
 * The request service reuses the task 14.1 ledger and Earning projection
 * repositories on the SAME transaction handle; this adapter supplies the
 * remaining payout-specific writes — the `PartnerPayout` row with its immutable
 * encrypted destination snapshot, one `PayoutAllocation` per whole Earning, the
 * initial `PayoutTransition`, and the audit event — so the entire request
 * commits atomically (requirements 14.1, 14.2, 14.3, 14.6, 14.7).
 *
 * Exactly-once Earning locking is guaranteed twice over: the service's
 * compare-and-set on the Earning projection status, and the unique
 * `PayoutAllocation.earningId` slot enforced here. A collision on that slot
 * surfaces as {@link EarningAlreadyAllocatedError}, which the service maps to a
 * conflict outcome. Every predicate folds in the trusted `partnerId` (task
 * 7.1); raw Prisma never leaves this adapter.
 */
export class PrismaPayoutRequestGateway
  implements PayoutRequestRepository<PartnerTransactionClient>
{
  private readonly executor: PartnerDatabaseExecutor;

  constructor(executor: PartnerDatabaseExecutor) {
    this.executor = executor;
  }

  async findActiveDestination(
    partnerId: string,
    destinationId: string,
  ): Promise<PayoutDestinationRecord | null> {
    const row = await this.executor.payoutDestination.findFirst({
      where: {
        id: destinationId,
        partnerId,
        status: $Enums.PayoutDestinationStatus.ACTIVE,
      },
      select: {
        id: true,
        partnerId: true,
        bankCode: true,
        accountNumberCiphertext: true,
        keyVersion: true,
        accountNumberLast4: true,
        accountHolderName: true,
        status: true,
      },
    });
    if (row === null) return null;
    return {
      id: row.id,
      partnerId: row.partnerId,
      bankCode: row.bankCode,
      accountNumberCiphertext: Uint8Array.from(row.accountNumberCiphertext),
      keyVersion: row.keyVersion,
      accountNumberLast4: row.accountNumberLast4,
      accountHolderName: row.accountHolderName,
      status:
        row.status === $Enums.PayoutDestinationStatus.ACTIVE ? "active" : "disabled",
    };
  }

  async createPayout(
    tx: PartnerTransactionClient,
    partnerId: string,
    input: NewPartnerPayout,
  ): Promise<void> {
    await tx.partnerPayout.create({
      data: {
        id: input.id,
        partnerId,
        destinationId: input.destinationId,
        destinationSnapshotJsonEncrypted: Buffer.from(
          input.destinationSnapshotJsonEncrypted,
        ),
        amountIdr: input.amountIdr,
        status: $Enums.PartnerPayoutStatus.REQUESTED,
        paymentMethod: $Enums.PayoutPaymentMethod.BANK_TRANSFER_MANUAL,
        createdByMemberId: input.createdByMemberId,
        requestedAt: new Date(input.requestedAtEpochMs),
      },
    });
  }

  async createAllocations(
    tx: PartnerTransactionClient,
    partnerId: string,
    payoutId: string,
    allocations: readonly PayoutAllocation[],
  ): Promise<void> {
    // Insert one row per allocation so a P2002 on the unique `earningId` slot
    // pinpoints the conflicting Earning (exactly-once locking backstop).
    for (const allocation of allocations) {
      try {
        await tx.payoutAllocation.create({
          data: {
            partnerId,
            payoutId,
            earningId: allocation.earningId,
            amountIdr: allocation.amountIdr,
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new EarningAlreadyAllocatedError(allocation.earningId);
        }
        throw error;
      }
    }
  }

  async recordTransition(
    tx: PartnerTransactionClient,
    partnerId: string,
    input: NewPayoutTransition,
  ): Promise<void> {
    await tx.payoutTransition.create({
      data: {
        id: input.id,
        partnerId,
        payoutId: input.payoutId,
        fromStatus:
          input.fromStatus === null ? null : $Enums.PartnerPayoutStatus.REQUESTED,
        toStatus: $Enums.PartnerPayoutStatus.REQUESTED,
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
