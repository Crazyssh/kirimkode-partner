import { describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma";

import type { PartnerDatabaseExecutor, PartnerTransactionClient } from "./client";
import { PrismaEarningProjectionRepository } from "./earning-projection-repository";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EARNING_1 = "11111111-1111-4111-8111-111111111111";
const ORDER_1 = "22222222-2222-4222-8222-222222222222";

type Row = Record<string, unknown>;

/**
 * In-memory `PartnerEarning` delegate honouring the `(orderId, partnerId)`
 * unique constraint (so a duplicate create throws P2002) and the tenant-scoped
 * predicates the repository builds.
 */
function fakeExecutor(seed: Row[] = []): {
  executor: PartnerDatabaseExecutor & PartnerTransactionClient;
  rows: Row[];
} {
  const rows: Row[] = [...seed];

  function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, value]) => row[key] === value);
  }

  const partnerEarning = {
    async findFirst(args: { where: Row; select?: Row }) {
      return rows.find((row) => matches(row, args.where)) ?? null;
    },
    async create(args: { data: Row }) {
      const data = args.data;
      if (rows.some((r) => r.orderId === data.orderId && r.partnerId === data.partnerId)) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
          meta: { target: ["orderId", "partnerId"] },
        });
      }
      rows.push({ reversedAt: null, ...data });
      return { id: data.id };
    },
    async updateMany(args: { where: Row; data: Row }) {
      let count = 0;
      for (const row of rows) {
        if (matches(row, args.where)) {
          for (const [key, value] of Object.entries(args.data)) {
            if (value !== undefined) row[key] = value;
          }
          count += 1;
        }
      }
      return { count };
    },
  };

  const executor = { partnerEarning } as unknown as PartnerDatabaseExecutor &
    PartnerTransactionClient;
  return { executor, rows };
}

// **Validates: Requirements 13.1, 13.2, 13.7**
describe("PrismaEarningProjectionRepository", () => {
  it("creates the single pending Earning for an order", async () => {
    const { executor, rows } = fakeExecutor();
    const repo = new PrismaEarningProjectionRepository(executor);

    const result = await repo.createEarning(executor, {
      id: EARNING_1,
      partnerId: TENANT_A,
      orderId: ORDER_1,
      amountIdr: 1000,
      availableAtEpochMs: 5000,
    });

    expect(result).toEqual({ created: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: EARNING_1,
      status: "PENDING",
      amountIdr: 1000,
    });
  });

  it("is a no-op when an Earning already exists for the order", async () => {
    const { executor, rows } = fakeExecutor([
      { id: EARNING_1, partnerId: TENANT_A, orderId: ORDER_1, amountIdr: 1000, status: "PENDING" },
    ]);
    const repo = new PrismaEarningProjectionRepository(executor);

    const result = await repo.createEarning(executor, {
      id: "33333333-3333-4333-8333-333333333333",
      partnerId: TENANT_A,
      orderId: ORDER_1,
      amountIdr: 1000,
      availableAtEpochMs: 5000,
    });

    expect(result).toEqual({ created: false });
    expect(rows).toHaveLength(1);
  });

  it("reads an Earning by id and by order within the tenant", async () => {
    const { executor } = fakeExecutor([
      {
        id: EARNING_1,
        partnerId: TENANT_A,
        orderId: ORDER_1,
        amountIdr: 1000,
        status: "PENDING",
        availableAt: new Date(5000),
        reversedAt: null,
      },
    ]);
    const repo = new PrismaEarningProjectionRepository(executor);

    const byId = await repo.findEarningById(TENANT_A, EARNING_1);
    const byOrder = await repo.findEarningByOrderId(TENANT_A, ORDER_1);

    expect(byId).toMatchObject({
      id: EARNING_1,
      status: "pending",
      amountIdr: 1000,
      availableAtEpochMs: 5000,
      reversedAtEpochMs: null,
    });
    expect(byOrder).toEqual(byId);
  });

  it("hides a cross-tenant Earning (returns null)", async () => {
    const { executor } = fakeExecutor([
      {
        id: EARNING_1,
        partnerId: TENANT_A,
        orderId: ORDER_1,
        amountIdr: 1000,
        status: "PENDING",
        availableAt: new Date(5000),
        reversedAt: null,
      },
    ]);
    const repo = new PrismaEarningProjectionRepository(executor);

    expect(await repo.findEarningById(TENANT_B, EARNING_1)).toBeNull();
    expect(await repo.findEarningByOrderId(TENANT_B, ORDER_1)).toBeNull();
  });

  it("advances status with a compare-and-set on the current status", async () => {
    const { executor, rows } = fakeExecutor([
      { id: EARNING_1, partnerId: TENANT_A, orderId: ORDER_1, status: "PENDING", reversedAt: null },
    ]);
    const repo = new PrismaEarningProjectionRepository(executor);

    const ok = await repo.updateEarningStatus(executor, {
      earningId: EARNING_1,
      partnerId: TENANT_A,
      expectedStatus: "pending",
      nextStatus: "available",
    });
    // A retry against the stale expected status matches no row.
    const stale = await repo.updateEarningStatus(executor, {
      earningId: EARNING_1,
      partnerId: TENANT_A,
      expectedStatus: "pending",
      nextStatus: "available",
    });

    expect(ok).toEqual({ outcome: "updated" });
    expect(stale).toEqual({ outcome: "no_op" });
    expect(rows[0].status).toBe("AVAILABLE");
  });

  it("stamps reversedAt only on a reversal", async () => {
    const { executor, rows } = fakeExecutor([
      { id: EARNING_1, partnerId: TENANT_A, orderId: ORDER_1, status: "AVAILABLE", reversedAt: null },
    ]);
    const repo = new PrismaEarningProjectionRepository(executor);

    const result = await repo.updateEarningStatus(executor, {
      earningId: EARNING_1,
      partnerId: TENANT_A,
      expectedStatus: "available",
      nextStatus: "reversed",
      reversedAtEpochMs: 9000,
    });

    expect(result).toEqual({ outcome: "updated" });
    expect(rows[0].status).toBe("REVERSED");
    expect((rows[0].reversedAt as Date).getTime()).toBe(9000);
  });
});
