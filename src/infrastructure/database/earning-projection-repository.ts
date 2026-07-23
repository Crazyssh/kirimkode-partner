import { $Enums, Prisma } from "@/generated/prisma";

import type {
  CreateEarningInput,
  EarningProjection,
  EarningProjectionRepository,
  UpdateEarningStatusInput,
  UpdateEarningStatusResult,
} from "@application/ledger";

import type { PartnerDatabaseExecutor, PartnerTransactionClient } from "./client";
import { EARNING_STATUS_FROM_DB, EARNING_STATUS_TO_DB } from "./ledger-enum-maps";
import { createTenantContext } from "./tenant-context";
import { scopedIdWhere } from "./tenant-scoping";

/**
 * Prisma-backed Earning projection repository (task 14.1).
 *
 * `PartnerEarning` is the workflow projection layered on the append-only ledger
 * (design section 10): the ledger holds the authoritative amounts, while this
 * row tracks the Earning lifecycle (`pending → available → requested → paid`,
 * plus `reversed`). Creates and status advances run on the caller-provided
 * transaction handle so the projection write commits atomically with the ledger
 * append and workflow effect (task 13.3 SMS-success unit; tasks 14.2–14.4).
 *
 * Idempotency and isolation are enforced by the schema: the `(orderId,
 * partnerId)` unique constraint makes a retried order success a no-op
 * (requirement 13.7), and every predicate folds in the trusted `partnerId` so a
 * cross-tenant Earning is indistinguishable from a missing one. Status advances
 * are a compare-and-set on the current status, so a concurrent or retried
 * transition is detected rather than double-applied. Raw Prisma never leaves
 * this adapter.
 */
export class PrismaEarningProjectionRepository
  implements EarningProjectionRepository<PartnerTransactionClient>
{
  private readonly executor: PartnerDatabaseExecutor;

  constructor(executor: PartnerDatabaseExecutor) {
    this.executor = executor;
  }

  async createEarning(
    tx: PartnerTransactionClient,
    input: CreateEarningInput,
  ): Promise<{ readonly created: boolean }> {
    // A pre-existing Earning for the order means the success was already
    // applied; the unique `(orderId, partnerId)` constraint keeps the retry a
    // no-op (requirement 13.7). Check first, then guard the insert against a
    // concurrent winner via the same constraint.
    const existing = await tx.partnerEarning.findFirst({
      where: { orderId: input.orderId, partnerId: input.partnerId },
      select: { id: true },
    });
    if (existing !== null) {
      return { created: false };
    }

    try {
      await tx.partnerEarning.create({
        data: {
          id: input.id,
          partnerId: input.partnerId,
          orderId: input.orderId,
          amountIdr: input.amountIdr,
          status: $Enums.PartnerEarningStatus.PENDING,
          availableAt: new Date(input.availableAtEpochMs),
        },
      });
      return { created: true };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { created: false };
      }
      throw error;
    }
  }

  async findEarningById(
    partnerId: string,
    earningId: string,
  ): Promise<EarningProjection | null> {
    const tenant = createTenantContext(partnerId);
    const row = await this.executor.partnerEarning.findFirst({
      where: scopedIdWhere(tenant, earningId),
      select: EARNING_SELECT,
    });
    return row === null ? null : toProjection(row);
  }

  async findEarningByOrderId(
    partnerId: string,
    orderId: string,
  ): Promise<EarningProjection | null> {
    const tenant = createTenantContext(partnerId);
    const row = await this.executor.partnerEarning.findFirst({
      where: { orderId, partnerId: tenant.partnerId },
      select: EARNING_SELECT,
    });
    return row === null ? null : toProjection(row);
  }

  async updateEarningStatus(
    tx: PartnerTransactionClient,
    input: UpdateEarningStatusInput,
  ): Promise<UpdateEarningStatusResult> {
    // Compare-and-set on the current status: only the row still at
    // `expectedStatus` for this tenant is advanced, so a concurrent or retried
    // transition matches zero rows and is reported as a no-op.
    const updated = await tx.partnerEarning.updateMany({
      where: {
        id: input.earningId,
        partnerId: input.partnerId,
        status: EARNING_STATUS_TO_DB[input.expectedStatus],
      },
      data: {
        status: EARNING_STATUS_TO_DB[input.nextStatus],
        reversedAt:
          input.reversedAtEpochMs === undefined
            ? undefined
            : new Date(input.reversedAtEpochMs),
      },
    });
    return updated.count === 1 ? { outcome: "updated" } : { outcome: "no_op" };
  }
}

const EARNING_SELECT = {
  id: true,
  partnerId: true,
  orderId: true,
  amountIdr: true,
  status: true,
  availableAt: true,
  reversedAt: true,
} as const;

interface EarningRow {
  readonly id: string;
  readonly partnerId: string;
  readonly orderId: string;
  readonly amountIdr: number;
  readonly status: $Enums.PartnerEarningStatus;
  readonly availableAt: Date;
  readonly reversedAt: Date | null;
}

function toProjection(row: EarningRow): EarningProjection {
  return {
    id: row.id,
    partnerId: row.partnerId,
    orderId: row.orderId,
    amountIdr: row.amountIdr,
    status: EARNING_STATUS_FROM_DB[row.status],
    availableAtEpochMs: row.availableAt.getTime(),
    reversedAtEpochMs: row.reversedAt === null ? null : row.reversedAt.getTime(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
