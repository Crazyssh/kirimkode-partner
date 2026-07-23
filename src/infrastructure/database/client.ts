import { PrismaClient } from "@/generated/prisma";

/**
 * Prisma client ownership.
 *
 * This module is the ONLY place allowed to construct the raw Prisma client.
 * The architectural import-boundary lint rules (task 1.3) forbid routes,
 * components, and handlers from importing `@infrastructure/**` or the generated
 * Prisma client directly, so the raw client is never exposed to the transport
 * layer. Application services reach persistence exclusively through the
 * tenant-scoped repositories and unit of work built on top of this client.
 */

/**
 * The subset of the Prisma client available inside an interactive transaction.
 * It exposes every model delegate but omits connection- and transaction-control
 * methods, matching the value Prisma passes to a `$transaction` callback. Both
 * the root client and a transaction client structurally satisfy this type, so
 * repositories can run against either.
 */
export type PartnerTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/**
 * The full Partner database client, including transaction control. Platform-
 * global gateways that own their own `$transaction` (the job/cron adapters)
 * bind to this; tenant-scoped repositories bind to {@link PartnerTransactionClient}.
 */
export type PartnerDatabaseClient = PrismaClient;

/** Any executor a repository can bind to: the root client or a transaction. */
export type PartnerDatabaseExecutor = PartnerTransactionClient;

export interface PartnerDatabaseClientOptions {
  readonly databaseUrl: string;
}

/**
 * Construct a dedicated Prisma client pinned to the Partner database URL. The
 * URL is injected (never read from ambient globals here) so the caller — the
 * application bootstrap — owns configuration resolution.
 */
export function createPartnerDatabaseClient(
  options: PartnerDatabaseClientOptions,
): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: options.databaseUrl } },
  });
}

let singleton: PrismaClient | undefined;

/**
 * Lazily create and reuse a process-wide Prisma client. Reusing a single
 * instance avoids exhausting the connection pool across hot reloads and
 * serverless invocations.
 */
export function getPartnerDatabaseClient(
  options: PartnerDatabaseClientOptions,
): PrismaClient {
  singleton ??= createPartnerDatabaseClient(options);
  return singleton;
}

/** Dispose the shared client. Intended for graceful shutdown and tests. */
export async function disposePartnerDatabaseClient(): Promise<void> {
  if (singleton) {
    const client = singleton;
    singleton = undefined;
    await client.$disconnect();
  }
}
