import { Prisma } from "@/generated/prisma";

import type {
  AppendLedgerResult,
  AppendLedgerTransactionInput,
  BucketBalances,
  LedgerRepository,
} from "@application/ledger";
import { assertZeroSumEntries, LEDGER_BUCKETS } from "@domain/task-5-6";

import type { PartnerDatabaseExecutor, PartnerTransactionClient } from "./client";
import {
  LEDGER_BUCKET_FROM_DB,
  LEDGER_BUCKET_TO_DB,
  LEDGER_EVENT_TYPE_TO_DB,
} from "./ledger-enum-maps";

/**
 * Prisma-backed append-only ledger repository (task 14.1).
 *
 * The ledger is the single source of monetary truth (design section 10). This
 * repository persists any pure-domain {@link LedgerTransaction} — the
 * order-success, hold-release, reversal, and payout lock/unlock/paid events
 * built in task 5.6 — as one `LedgerTransaction` row plus its (>= 2) signed,
 * zero-sum `LedgerEntry` rows, and derives balances by SUM per bucket rather
 * than from any mutable column (requirement 13.5, 13.6).
 *
 * Writes run on the caller-provided transaction handle so the ledger append
 * commits atomically with the paired projection write and workflow effect (the
 * SMS-success unit of task 13.3 and the payout units of tasks 14.2–14.4). The
 * globally unique `eventKey` makes a retried event a deterministic no-op
 * (requirement 13.7): a duplicate is detected up front and, to be safe against a
 * concurrent writer, a unique-constraint violation on insert is also absorbed.
 * Balance reads bind the root executor. Raw Prisma never leaves this adapter.
 */
export class PrismaLedgerRepository
  implements LedgerRepository<PartnerTransactionClient>
{
  private readonly executor: PartnerDatabaseExecutor;

  constructor(executor: PartnerDatabaseExecutor) {
    this.executor = executor;
  }

  async appendTransaction(
    tx: PartnerTransactionClient,
    input: AppendLedgerTransactionInput,
  ): Promise<AppendLedgerResult> {
    const { partnerId, transaction } = input;
    // Defense in depth: re-assert the double-entry, zero-sum invariant before
    // any row is written, even though the pure domain already validated it.
    assertZeroSumEntries(transaction.entries);

    // A prior event with the same key means this is a retry: a deterministic
    // no-op that must not write a second transaction or duplicate entries.
    const existing = await tx.ledgerTransaction.findUnique({
      where: { eventKey: transaction.eventKey },
      select: { id: true },
    });
    if (existing !== null) {
      return { outcome: "duplicate_no_op" };
    }

    try {
      const created = await tx.ledgerTransaction.create({
        data: {
          partnerId,
          eventType: LEDGER_EVENT_TYPE_TO_DB[transaction.eventType],
          eventKey: transaction.eventKey,
          referenceType: transaction.referenceType,
          referenceId: transaction.referenceId,
          entries: {
            create: transaction.entries.map((entry) => ({
              partnerId,
              bucket: LEDGER_BUCKET_TO_DB[entry.bucket],
              amountIdrSigned: entry.amountIdrSigned,
            })),
          },
        },
        select: { id: true },
      });
      return { outcome: "appended", transactionId: created.id };
    } catch (error) {
      // A concurrent writer won the race on the unique `eventKey`; treat the
      // lost race as the same idempotent no-op rather than a hard failure.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return { outcome: "duplicate_no_op" };
      }
      throw error;
    }
  }

  async computeBucketBalances(partnerId: string): Promise<BucketBalances> {
    // Balances are the SUM of signed entries per bucket (design section 10);
    // there is no mutable balance column to read (requirement 13.6).
    const grouped = await this.executor.ledgerEntry.groupBy({
      by: ["bucket"],
      where: { partnerId },
      _sum: { amountIdrSigned: true },
    });

    const balances = {} as Record<(typeof LEDGER_BUCKETS)[number], number>;
    for (const bucket of LEDGER_BUCKETS) {
      balances[bucket] = 0;
    }
    for (const row of grouped) {
      balances[LEDGER_BUCKET_FROM_DB[row.bucket]] = row._sum.amountIdrSigned ?? 0;
    }
    return Object.freeze(balances);
  }
}
