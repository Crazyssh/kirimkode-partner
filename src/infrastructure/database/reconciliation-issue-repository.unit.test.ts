import { describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma";

import type { PartnerTransactionClient } from "./client";
import { PrismaReconciliationIssueRepository } from "./reconciliation-issue-repository";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EARNING_1 = "11111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;

/**
 * In-memory `ReconciliationIssue` delegate honouring the primary-key unique
 * constraint and the tenant/type/reference/status predicates the repository
 * builds for its open-issue dedupe.
 */
function fakeTx(seed: Row[] = []): {
  tx: PartnerTransactionClient;
  rows: Row[];
} {
  const rows: Row[] = [...seed];

  function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, value]) => row[key] === value);
  }

  const reconciliationIssue = {
    async findFirst(args: { where: Row; select?: Row }) {
      return rows.find((row) => matches(row, args.where)) ?? null;
    },
    async create(args: { data: Row; select?: Row }) {
      const data = args.data;
      if (rows.some((r) => r.id === data.id)) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
          meta: { target: ["id"] },
        });
      }
      rows.push({ status: "OPEN", ...data });
      return { id: data.id };
    },
  };

  const tx = { reconciliationIssue } as unknown as PartnerTransactionClient;
  return { tx, rows };
}

// **Validates: Requirements 20.6**
describe("PrismaReconciliationIssueRepository", () => {
  it("records a new stale_financial_state issue", async () => {
    const { tx, rows } = fakeTx();
    const repo = new PrismaReconciliationIssueRepository();

    const result = await repo.recordIssue(tx, {
      id: "issue-1",
      partnerId: TENANT_A,
      type: "stale_financial_state",
      referenceId: EARNING_1,
      severity: "high",
      detailsSafeJson: { issue: "paid_earning_reversal_blocked", amountIdr: 1000 },
    });

    expect(result).toEqual({ outcome: "recorded", issueId: "issue-1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      partnerId: TENANT_A,
      type: "STALE_FINANCIAL_STATE",
      severity: "HIGH",
      referenceId: EARNING_1,
      status: "OPEN",
    });
  });

  it("reuses an existing open issue for the same tenant/type/reference", async () => {
    const { tx, rows } = fakeTx([
      {
        id: "issue-existing",
        partnerId: TENANT_A,
        type: "STALE_FINANCIAL_STATE",
        referenceId: EARNING_1,
        status: "OPEN",
      },
    ]);
    const repo = new PrismaReconciliationIssueRepository();

    const result = await repo.recordIssue(tx, {
      id: "issue-new",
      partnerId: TENANT_A,
      type: "stale_financial_state",
      referenceId: EARNING_1,
      severity: "high",
      detailsSafeJson: { issue: "paid_earning_reversal_blocked" },
    });

    expect(result).toEqual({ outcome: "duplicate_no_op", issueId: "issue-existing" });
    expect(rows).toHaveLength(1);
  });

  it("records a fresh issue when the prior one is resolved (not open)", async () => {
    const { tx, rows } = fakeTx([
      {
        id: "issue-old",
        partnerId: TENANT_A,
        type: "STALE_FINANCIAL_STATE",
        referenceId: EARNING_1,
        status: "RESOLVED",
      },
    ]);
    const repo = new PrismaReconciliationIssueRepository();

    const result = await repo.recordIssue(tx, {
      id: "issue-2",
      partnerId: TENANT_A,
      type: "stale_financial_state",
      referenceId: EARNING_1,
      severity: "high",
      detailsSafeJson: {},
    });

    expect(result).toEqual({ outcome: "recorded", issueId: "issue-2" });
    expect(rows).toHaveLength(2);
  });
});
