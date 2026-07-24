import { describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma";
import type { LedgerTransaction } from "@application/ledger";
import {
  createTransferTransaction,
  orderSuccessEventKey,
} from "@domain/task-5-6";

import type { PartnerDatabaseExecutor, PartnerTransactionClient } from "./client";
import { PrismaLedgerRepository } from "./ledger-repository";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Row = Record<string, unknown>;

/**
 * In-memory `LedgerTransaction` + `LedgerEntry` delegates that honour the
 * unique `eventKey` constraint (so a duplicate insert throws the same P2002 the
 * real client would) and support the `groupBy` used for balance SUMs.
 */
function fakeExecutor(): {
  executor: PartnerDatabaseExecutor & PartnerTransactionClient;
  transactions: Row[];
  entries: Row[];
} {
  const transactions: Row[] = [];
  const entries: Row[] = [];
  let seq = 0;

  const ledgerTransaction = {
    async findUnique(args: { where: { eventKey: string }; select?: Row }) {
      const found = transactions.find((t) => t.eventKey === args.where.eventKey);
      return found ? { id: found.id } : null;
    },
    async create(args: { data: Row; select?: Row }) {
      const data = args.data;
      if (transactions.some((t) => t.eventKey === data.eventKey)) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
          meta: { target: ["eventKey"] },
        });
      }
      const id = `tx-${(seq += 1)}`;
      transactions.push({ id, eventKey: data.eventKey, partnerId: data.partnerId });
      const nested = data.entries as { create: Row[] };
      for (const entry of nested.create) {
        // Entries inherit partnerId (and transactionId) from the parent
        // transaction via the composite relation, exactly as the real Prisma
        // client derives them — the nested create never carries partnerId.
        entries.push({ ...entry, transactionId: id, partnerId: data.partnerId });
      }
      return { id };
    },
  };

  const ledgerEntry = {
    async groupBy(args: {
      by: string[];
      where: { partnerId: string };
      _sum: { amountIdrSigned: boolean };
    }) {
      const byBucket = new Map<string, number>();
      for (const entry of entries) {
        if (entry.partnerId !== args.where.partnerId) continue;
        const bucket = entry.bucket as string;
        byBucket.set(
          bucket,
          (byBucket.get(bucket) ?? 0) + (entry.amountIdrSigned as number),
        );
      }
      return [...byBucket.entries()].map(([bucket, sum]) => ({
        bucket,
        _sum: { amountIdrSigned: sum },
      }));
    },
  };

  const executor = { ledgerTransaction, ledgerEntry } as unknown as
    PartnerDatabaseExecutor & PartnerTransactionClient;
  return { executor, transactions, entries };
}

function successTx(orderId: string, amountIdr: number): LedgerTransaction {
  return createTransferTransaction({
    eventType: "order-success",
    eventKey: orderSuccessEventKey(orderId),
    referenceType: "order",
    referenceId: orderId,
    fromBucket: "platform_partner_payable",
    toBucket: "partner_pending",
    amountIdr,
  });
}

// **Validates: Requirements 13.1, 13.5, 13.6, 13.7**
describe("PrismaLedgerRepository", () => {
  it("appends a zero-sum transaction with its entries", async () => {
    const { executor, transactions, entries } = fakeExecutor();
    const repo = new PrismaLedgerRepository(executor);

    const result = await repo.appendTransaction(executor, {
      partnerId: TENANT_A,
      transaction: successTx("order-1", 1000),
    });

    expect(result.outcome).toBe("appended");
    expect(transactions).toHaveLength(1);
    expect(entries).toHaveLength(2);
    // Zero-sum double entry: payable -1000, pending +1000.
    expect(entries.reduce((s, e) => s + (e.amountIdrSigned as number), 0)).toBe(0);
  });

  it("is a deterministic no-op when the eventKey already exists", async () => {
    const { executor, transactions, entries } = fakeExecutor();
    const repo = new PrismaLedgerRepository(executor);

    await repo.appendTransaction(executor, {
      partnerId: TENANT_A,
      transaction: successTx("order-1", 1000),
    });
    const replay = await repo.appendTransaction(executor, {
      partnerId: TENANT_A,
      transaction: successTx("order-1", 1000),
    });

    expect(replay).toEqual({ outcome: "duplicate_no_op" });
    // No second transaction or duplicate entries were written.
    expect(transactions).toHaveLength(1);
    expect(entries).toHaveLength(2);
  });

  it("absorbs a concurrent unique-constraint race as a no-op", async () => {
    // A racing writer committed the same eventKey after our up-front lookup
    // missed: findUnique returns null but create still trips the P2002 guard.
    const racingExecutor = {
      ledgerTransaction: {
        async findUnique() {
          return null;
        },
        async create() {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "test",
            meta: { target: ["eventKey"] },
          });
        },
      },
    } as unknown as PartnerDatabaseExecutor & PartnerTransactionClient;
    const repo = new PrismaLedgerRepository(racingExecutor);

    const result = await repo.appendTransaction(racingExecutor, {
      partnerId: TENANT_A,
      transaction: successTx("order-9", 1000),
    });

    expect(result).toEqual({ outcome: "duplicate_no_op" });
  });

  it("rejects a non-zero-sum transaction before writing", async () => {
    const { executor, transactions } = fakeExecutor();
    const repo = new PrismaLedgerRepository(executor);

    // Hand-build an imbalanced transaction, bypassing the domain builder.
    const imbalanced = {
      eventType: "order-success",
      eventKey: "order-success:bad",
      referenceType: "order",
      referenceId: "bad",
      entries: [
        { bucket: "platform_partner_payable", amountIdrSigned: -1000 },
        { bucket: "partner_pending", amountIdrSigned: 900 },
      ],
    } as unknown as LedgerTransaction;

    await expect(
      repo.appendTransaction(executor, { partnerId: TENANT_A, transaction: imbalanced }),
    ).rejects.toThrow();
    expect(transactions).toHaveLength(0);
  });

  it("computes per-bucket balances as the SUM of signed entries", async () => {
    const { executor } = fakeExecutor();
    const repo = new PrismaLedgerRepository(executor);

    // success (payable -1000, pending +1000) then a second success of 500.
    await repo.appendTransaction(executor, {
      partnerId: TENANT_A,
      transaction: successTx("order-1", 1000),
    });
    await repo.appendTransaction(executor, {
      partnerId: TENANT_A,
      transaction: successTx("order-2", 500),
    });

    const balances = await repo.computeBucketBalances(TENANT_A);

    expect(balances.platform_partner_payable).toBe(-1500);
    expect(balances.partner_pending).toBe(1500);
    // Untouched buckets default to zero, and the whole ledger nets to zero.
    expect(balances.partner_available).toBe(0);
    const total = Object.values(balances).reduce((s, v) => s + v, 0);
    expect(total).toBe(0);
  });

  it("returns all-zero balances for a partner with no entries", async () => {
    const { executor } = fakeExecutor();
    const repo = new PrismaLedgerRepository(executor);

    const balances = await repo.computeBucketBalances(TENANT_A);

    expect(Object.values(balances).every((v) => v === 0)).toBe(true);
  });
});
