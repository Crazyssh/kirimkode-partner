import type { TenantContext } from "./tenant-context";
import { ConcurrencyConflictError, ResourceNotFoundError } from "./repository-errors";

/**
 * Pure query-predicate helpers shared by every tenant-scoped repository.
 *
 * These functions never touch the database; they only build the `where`
 * objects and `data` fragments that guarantee tenant isolation and
 * compare-and-set semantics. Keeping them pure makes the isolation and
 * versioning rules exhaustively unit-testable without a live database.
 */

/** A minimal Prisma `where` shape: a record of predicate fields. */
export type WhereInput = Record<string, unknown>;

/**
 * Fold the tenant's `partnerId` into a `where` predicate (defense-in-depth).
 * Any caller-provided `partnerId` is overwritten by the trusted context value,
 * so a spoofed field can never widen the query to another tenant.
 */
export function scopedWhere<W extends WhereInput>(
  tenant: TenantContext,
  where?: W,
): W & { partnerId: string } {
  return { ...(where ?? ({} as W)), partnerId: tenant.partnerId };
}

/** Build a tenant-scoped `where` that also pins a specific row id. */
export function scopedIdWhere(
  tenant: TenantContext,
  id: string,
): { id: string; partnerId: string } {
  return { id, partnerId: tenant.partnerId };
}

/**
 * Build the `where` for a compare-and-set update: the row must belong to the
 * tenant AND still be at the expected `version`.
 */
export function casWhere(
  tenant: TenantContext,
  id: string,
  expectedVersion: number,
): { id: string; partnerId: string; version: number } {
  assertVersion(expectedVersion);
  return { id, partnerId: tenant.partnerId, version: expectedVersion };
}

/** The next monotonic version after a successful compare-and-set. */
export function nextVersion(expectedVersion: number): number {
  assertVersion(expectedVersion);
  return expectedVersion + 1;
}

/**
 * Merge update fields with the version bump applied by a compare-and-set.
 * The `version` field is always controlled here, never by the caller's data.
 */
export function withVersionBump<D extends WhereInput>(
  data: D,
  expectedVersion: number,
): D & { version: number } {
  return { ...data, version: nextVersion(expectedVersion) };
}

/**
 * Interpret the row-count returned by a scoped `updateMany`/`deleteMany`.
 *
 * A count of exactly one is success. Zero means the target either does not
 * exist, belongs to another tenant, or (for a compare-and-set) has moved past
 * the expected version. When a version was asserted we treat zero as a
 * retryable concurrency conflict; otherwise as a not-found (which also absorbs
 * cross-tenant access into RESOURCE_NOT_FOUND).
 */
export function assertAffectedExactlyOne(
  count: number,
  options: { readonly compareAndSet: boolean },
): void {
  if (count === 1) return;
  if (count === 0) {
    throw options.compareAndSet
      ? new ConcurrencyConflictError()
      : new ResourceNotFoundError();
  }
  // A scoped predicate must never affect more than one row. Reaching here means
  // an invariant (unique id per tenant) was violated upstream.
  throw new Error(`Tenant-scoped mutation affected ${count} rows`);
}

function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("version must be a positive safe integer");
  }
}
