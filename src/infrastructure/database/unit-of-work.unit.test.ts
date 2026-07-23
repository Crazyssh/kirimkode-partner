import { describe, expect, it, vi } from "vitest";

import { Prisma, type PrismaClient } from "@/generated/prisma";

import { ConcurrencyConflictError } from "./repository-errors";
import { createTenantContext, InvalidTenantContextError } from "./tenant-context";
import { PrismaUnitOfWork } from "./unit-of-work";

const TENANT = createTenantContext("11111111-1111-4111-8111-111111111111");

/** Fake client whose `$transaction` invokes the callback with a marker tx. */
function fakeClient(
  onTransaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>,
): PrismaClient {
  return { $transaction: vi.fn(onTransaction) } as unknown as PrismaClient;
}

// **Validates: Requirements 4.2, 20.1**
describe("PrismaUnitOfWork", () => {
  it("runs work inside a transaction bound to the tenant and tx client", async () => {
    const tx = { marker: "tx" };
    const client = fakeClient((fn) => fn(tx));
    const uow = new PrismaUnitOfWork(client);

    const result = await uow.run(TENANT, async (context) => {
      expect(context.tenant).toBe(TENANT);
      expect(context.tx).toBe(tx);
      return "ok";
    });

    expect(result).toBe("ok");
  });

  it("rejects an invalid tenant before opening a transaction", async () => {
    const transaction = vi.fn();
    const client = { $transaction: transaction } as unknown as PrismaClient;
    const uow = new PrismaUnitOfWork(client);

    await expect(
      uow.run({ partnerId: "bad" }, async () => "unreachable"),
    ).rejects.toBeInstanceOf(InvalidTenantContextError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("wraps a write-conflict failure as a retryable concurrency conflict", async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError(
      "write conflict",
      { code: "P2034", clientVersion: "6.19.0" },
    );
    const client = fakeClient(() => Promise.reject(conflict));
    const uow = new PrismaUnitOfWork(client);

    await expect(
      uow.run(TENANT, async () => "unreachable"),
    ).rejects.toBeInstanceOf(ConcurrencyConflictError);
  });

  it("propagates non-conflict errors unchanged", async () => {
    const boom = new Error("boom");
    const client = fakeClient(() => Promise.reject(boom));
    const uow = new PrismaUnitOfWork(client);

    await expect(uow.run(TENANT, async () => "unreachable")).rejects.toBe(boom);
  });
});
