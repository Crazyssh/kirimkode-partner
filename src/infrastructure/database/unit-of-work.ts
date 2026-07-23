import type { PrismaClient } from "@/generated/prisma";

import type { PartnerTransactionClient } from "./client";
import { assertTenantContext, type TenantContext } from "./tenant-context";
import { ConcurrencyConflictError, isRetryableWriteConflict } from "./repository-errors";

/**
 * Unit-of-work abstraction.
 *
 * A unit of work runs a piece of application logic inside a single database
 * transaction, bound to a validated `TenantContext`. All repository work that
 * must be atomic (e.g. registering a partner and its owner, reserving an order
 * and writing its snapshot) executes through `run`, so either every write
 * commits or none do. The raw Prisma client stays hidden behind this port.
 */
export interface UnitOfWorkContext {
  readonly tenant: TenantContext;
  readonly tx: PartnerTransactionClient;
}

export interface UnitOfWork {
  run<T>(
    tenant: TenantContext,
    work: (context: UnitOfWorkContext) => Promise<T>,
  ): Promise<T>;
}

export interface PrismaUnitOfWorkOptions {
  /** Transaction timeout in milliseconds (Prisma default is 5000). */
  readonly timeoutMs?: number;
  /** Max time to wait for a connection from the pool, in milliseconds. */
  readonly maxWaitMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_WAIT_MS = 5_000;

export class PrismaUnitOfWork implements UnitOfWork {
  private readonly client: PrismaClient;
  private readonly timeoutMs: number;
  private readonly maxWaitMs: number;

  constructor(client: PrismaClient, options: PrismaUnitOfWorkOptions = {}) {
    this.client = client;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  async run<T>(
    tenant: TenantContext,
    work: (context: UnitOfWorkContext) => Promise<T>,
  ): Promise<T> {
    assertTenantContext(tenant);
    try {
      return await this.client.$transaction(
        (tx) => work({ tenant, tx }),
        { timeout: this.timeoutMs, maxWait: this.maxWaitMs },
      );
    } catch (error) {
      // Surface serialization/write-conflict failures as retryable concurrency
      // conflicts so callers can re-read and retry instead of seeing an opaque
      // internal error.
      if (isRetryableWriteConflict(error)) {
        throw new ConcurrencyConflictError();
      }
      throw error;
    }
  }
}
