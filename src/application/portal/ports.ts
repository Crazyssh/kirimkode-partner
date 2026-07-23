/**
 * Ports for the Partner portal read model (task 15.1).
 *
 * The portal dashboard is a pure read: it aggregates tenant-scoped counts and
 * the ledger-derived balances into a single view. These ports keep the query
 * service free of Prisma so it can be unit-tested with in-memory fakes, and so
 * the raw client stays behind the infrastructure boundary. Every method takes a
 * validated {@link TenantContext} whose `partnerId` comes only from the
 * authenticated session (requirement 4.2), never from a client field.
 */
import type { TenantContext } from "@infrastructure/database";
import type { BucketBalances } from "@application/ledger";

/** The four Partner lifecycle states surfaced on the dashboard (req 3.1). */
export type PartnerStatus = "pending" | "approved" | "suspended" | "rejected";

/** The partner's identity + lifecycle status shown at the top of the shell. */
export interface PartnerSummary {
  readonly displayName: string;
  readonly status: PartnerStatus;
  /** Reason recorded on the last status change, when present (req 3.5). */
  readonly statusReason: string | null;
}

/** Tenant-scoped counts derived from the operational tables. */
export interface DashboardCounts {
  readonly devicesOnline: number;
  readonly devicesTotal: number;
  readonly numbersAvailable: number;
  readonly ordersActive: number;
  readonly ordersTotal: number;
  readonly ordersSuccess: number;
  readonly payoutsOpen: number;
  readonly payoutsPaid: number;
}

/**
 * Read side of the dashboard. Implementations fold the tenant's `partnerId`
 * into every predicate for defense-in-depth isolation.
 */
export interface DashboardQueryGateway {
  /** The partner row for the session's tenant, or null if it is missing. */
  loadPartnerSummary(tenant: TenantContext): Promise<PartnerSummary | null>;
  /** Aggregate operational counts for the tenant. */
  loadCounts(tenant: TenantContext): Promise<DashboardCounts>;
}

/**
 * Balance source. The ledger is the single source of monetary truth: balances
 * are the SUM of signed entries per bucket, never a mutable column
 * (design section 10, task 14.1, requirement 13.6).
 */
export interface BalanceReader {
  computeBucketBalances(partnerId: string): Promise<BucketBalances>;
}
