import { $Enums, Prisma } from "@/generated/prisma";

import type {
  ReconciliationIssueRepository,
  ReconciliationIssueType,
  ReconciliationSeverity,
  RecordReconciliationIssueInput,
  RecordReconciliationIssueResult,
} from "@application/ledger";

import type { PartnerTransactionClient } from "./client";

/**
 * Prisma-backed reconciliation-issue repository (task 14.2, reused by task
 * 16.4).
 *
 * A reconciliation issue is a durable signal for manual, out-of-band action —
 * it never repairs money on its own (requirement 20.6). Task 14.2 records one
 * `stale_financial_state` issue when a `paid` Earning reversal is refused
 * (design section 10). Recording is idempotent per open issue: before inserting
 * we look for an existing `open` issue of the same `(partnerId, type,
 * referenceId)` and reuse it, so a retried block does not spawn a duplicate row
 * ("persist/dedupe issue"). Writes run on the caller-provided transaction
 * handle; raw Prisma never leaves this adapter.
 */
const ISSUE_TYPE_TO_DB: Readonly<
  Record<ReconciliationIssueType, $Enums.ReconciliationIssueType>
> = {
  order_number_mismatch: $Enums.ReconciliationIssueType.ORDER_NUMBER_MISMATCH,
  earning_snapshot_mismatch:
    $Enums.ReconciliationIssueType.EARNING_SNAPSHOT_MISMATCH,
  ledger_imbalance: $Enums.ReconciliationIssueType.LEDGER_IMBALANCE,
  payout_allocation_mismatch:
    $Enums.ReconciliationIssueType.PAYOUT_ALLOCATION_MISMATCH,
  projection_ledger_mismatch:
    $Enums.ReconciliationIssueType.PROJECTION_LEDGER_MISMATCH,
  stale_financial_state: $Enums.ReconciliationIssueType.STALE_FINANCIAL_STATE,
};

const SEVERITY_TO_DB: Readonly<
  Record<ReconciliationSeverity, $Enums.ReconciliationSeverity>
> = {
  low: $Enums.ReconciliationSeverity.LOW,
  medium: $Enums.ReconciliationSeverity.MEDIUM,
  high: $Enums.ReconciliationSeverity.HIGH,
  critical: $Enums.ReconciliationSeverity.CRITICAL,
};

export class PrismaReconciliationIssueRepository
  implements ReconciliationIssueRepository<PartnerTransactionClient>
{
  async recordIssue(
    tx: PartnerTransactionClient,
    input: RecordReconciliationIssueInput,
  ): Promise<RecordReconciliationIssueResult> {
    const type = ISSUE_TYPE_TO_DB[input.type];

    // Dedupe: an already-open issue for the same tenant/type/reference is
    // reused rather than duplicated, so a retried block is a no-op.
    const existing = await tx.reconciliationIssue.findFirst({
      where: {
        partnerId: input.partnerId,
        type,
        referenceId: input.referenceId,
        status: $Enums.ReconciliationIssueStatus.OPEN,
      },
      select: { id: true },
    });
    if (existing !== null) {
      return { outcome: "duplicate_no_op", issueId: existing.id };
    }

    try {
      const created = await tx.reconciliationIssue.create({
        data: {
          id: input.id,
          partnerId: input.partnerId,
          type,
          referenceId: input.referenceId,
          severity: SEVERITY_TO_DB[input.severity],
          detailsSafeJson: input.detailsSafeJson as Prisma.InputJsonValue,
          status: $Enums.ReconciliationIssueStatus.OPEN,
        },
        select: { id: true },
      });
      return { outcome: "recorded", issueId: created.id };
    } catch (error) {
      // A concurrent writer inserted the same primary key first; re-read the
      // open issue and report the lost race as an idempotent no-op.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const winner = await tx.reconciliationIssue.findFirst({
          where: {
            partnerId: input.partnerId,
            type,
            referenceId: input.referenceId,
            status: $Enums.ReconciliationIssueStatus.OPEN,
          },
          select: { id: true },
        });
        if (winner !== null) {
          return { outcome: "duplicate_no_op", issueId: winner.id };
        }
      }
      throw error;
    }
  }
}
