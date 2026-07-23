import { beforeEach, describe, expect, it } from "vitest";

import type { PartnerDatabaseExecutor } from "./client";
import { PartnerMemberRepository } from "./partner-member-repository";
import { PartnerOrderRepository } from "./partner-order-repository";
import {
  ConcurrencyConflictError,
  ResourceNotFoundError,
} from "./repository-errors";
import { createTenantContext } from "./tenant-context";

const TENANT_A = createTenantContext("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const TENANT_B = createTenantContext("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

type Row = Record<string, unknown>;

/** Minimal in-memory Prisma delegate that honours the where predicate. */
class FakeTable {
  readonly rows: Row[] = [];
  private readonly defaults: Row;

  constructor(defaults: Row = {}) {
    this.defaults = defaults;
  }

  private matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, value]) => row[key] === value);
  }

  async findFirst(args: { where: Row }): Promise<Row | null> {
    return this.rows.find((row) => this.matches(row, args.where)) ?? null;
  }

  async findMany(args: { where: Row }): Promise<Row[]> {
    return this.rows.filter((row) => this.matches(row, args.where));
  }

  async create(args: { data: Row }): Promise<Row> {
    const row: Row = { ...this.defaults, ...args.data };
    this.rows.push(row);
    return row;
  }

  async updateMany(args: { where: Row; data: Row }): Promise<{ count: number }> {
    let count = 0;
    for (const row of this.rows) {
      if (this.matches(row, args.where)) {
        Object.assign(row, args.data);
        count += 1;
      }
    }
    return { count };
  }
}

function fakeExecutor(): {
  executor: PartnerDatabaseExecutor;
  partnerOrder: FakeTable;
  partnerMember: FakeTable;
} {
  const partnerOrder = new FakeTable({ version: 1 });
  const partnerMember = new FakeTable();
  const executor = { partnerOrder, partnerMember } as unknown as PartnerDatabaseExecutor;
  return { executor, partnerOrder, partnerMember };
}

// **Validates: Requirements 4.2, 4.3, 20.1**
describe("PartnerOrderRepository tenant isolation", () => {
  let fake: ReturnType<typeof fakeExecutor>;

  beforeEach(() => {
    fake = fakeExecutor();
    fake.partnerOrder.rows.push(
      { id: "order-a", partnerId: TENANT_A.partnerId, status: "RESERVED", version: 1 },
      { id: "order-b", partnerId: TENANT_B.partnerId, status: "RESERVED", version: 1 },
    );
  });

  it("returns only rows owned by the tenant", async () => {
    const repo = new PartnerOrderRepository(fake.executor, TENANT_A);
    expect(await repo.findById("order-a")).toMatchObject({ id: "order-a" });
    // order-b belongs to tenant B, so tenant A can never see it.
    expect(await repo.findById("order-b")).toBeNull();
  });

  it("maps cross-tenant access to RESOURCE_NOT_FOUND", async () => {
    const repo = new PartnerOrderRepository(fake.executor, TENANT_A);
    await expect(repo.requireById("order-b")).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it("forces the tenant partnerId on create", async () => {
    const repo = new PartnerOrderRepository(fake.executor, TENANT_A);
    const created = await repo.create({
      id: "order-new",
      buyerOrderRef: "buyer-1",
      buyerAccountRef: "acct-1",
      numberId: "num-1",
      offerId: "offer-1",
      expiresAt: new Date(),
    } as never);
    expect(created).toMatchObject({ partnerId: TENANT_A.partnerId, version: 1 });
  });
});

// **Validates: Requirements 4.2, 4.3**
describe("PartnerOrderRepository compare-and-set", () => {
  let fake: ReturnType<typeof fakeExecutor>;

  beforeEach(() => {
    fake = fakeExecutor();
    fake.partnerOrder.rows.push({
      id: "order-a",
      partnerId: TENANT_A.partnerId,
      status: "RESERVED",
      version: 1,
    });
  });

  it("applies the mutation and bumps the version when the version matches", async () => {
    const repo = new PartnerOrderRepository(fake.executor, TENANT_A);
    const updated = await repo.updateWithCas("order-a", 1, { status: "WAITING_SMS" });
    expect(updated).toMatchObject({ status: "WAITING_SMS", version: 2 });
  });

  it("raises a retryable conflict when the version has moved on", async () => {
    const repo = new PartnerOrderRepository(fake.executor, TENANT_A);
    await repo.updateWithCas("order-a", 1, { status: "WAITING_SMS" });
    await expect(
      repo.updateWithCas("order-a", 1, { status: "SUCCESS" }),
    ).rejects.toBeInstanceOf(ConcurrencyConflictError);
  });

  it("raises RESOURCE_NOT_FOUND when the row is missing or cross-tenant", async () => {
    const repoA = new PartnerOrderRepository(fake.executor, TENANT_A);
    await expect(
      repoA.updateWithCas("missing", 1, { status: "SUCCESS" }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);

    const repoB = new PartnerOrderRepository(fake.executor, TENANT_B);
    await expect(
      repoB.updateWithCas("order-a", 1, { status: "SUCCESS" }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// **Validates: Requirements 4.2, 4.3**
describe("PartnerMemberRepository tenant isolation", () => {
  let fake: ReturnType<typeof fakeExecutor>;

  beforeEach(() => {
    fake = fakeExecutor();
    fake.partnerMember.rows.push(
      { id: "member-a", partnerId: TENANT_A.partnerId, role: "OWNER", status: "ACTIVE" },
      { id: "member-b", partnerId: TENANT_B.partnerId, role: "OWNER", status: "ACTIVE" },
    );
  });

  it("never updates another tenant's member", async () => {
    const repoA = new PartnerMemberRepository(fake.executor, TENANT_A);
    await expect(
      repoA.update("member-b", { status: "SUSPENDED" }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    // Tenant B's row is untouched.
    expect(fake.partnerMember.rows[1]).toMatchObject({ status: "ACTIVE" });
  });

  it("updates the tenant's own member", async () => {
    const repoA = new PartnerMemberRepository(fake.executor, TENANT_A);
    const updated = await repoA.update("member-a", { status: "SUSPENDED" });
    expect(updated).toMatchObject({ id: "member-a", status: "SUSPENDED" });
  });
});
