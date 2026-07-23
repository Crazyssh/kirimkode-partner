/**
 * Portal dashboard query service (task 15.1).
 *
 * Assembles the tenant dashboard view (requirement 15.1): partner status,
 * online device count, available numbers, order counts, pending/available
 * earnings, and the payout summary. Monetary figures are read from the ledger
 * SUM per bucket (task 14.1) — pending earnings from `partner_pending`,
 * available balance from `partner_available`, and the payout buckets from
 * `partner_payout_locked`/`partner_paid` — so the numbers reconcile with the
 * append-only ledger rather than any mutable column. All reads are bound to the
 * session's tenant scope; the service never sees a client-supplied partnerId.
 */
import type { TenantContext } from "@infrastructure/database";

import type {
  BalanceReader,
  DashboardCounts,
  DashboardQueryGateway,
  PartnerSummary,
} from "./ports";

export interface DashboardOrdersView {
  readonly active: number;
  readonly total: number;
  readonly success: number;
}

export interface DashboardEarningsView {
  /** Held earnings awaiting the 24h release window (IDR). */
  readonly pendingIdr: number;
  /** Released balance available for payout (IDR). */
  readonly availableIdr: number;
}

export interface DashboardPayoutView {
  /** Earnings locked into open payout requests (IDR). */
  readonly lockedIdr: number;
  /** Total already paid out (IDR). */
  readonly paidIdr: number;
  /** Count of payouts not yet in a terminal paid state. */
  readonly openCount: number;
  /** Count of payouts marked paid. */
  readonly paidCount: number;
}

export interface DashboardView {
  readonly partner: PartnerSummary;
  readonly devices: { readonly online: number; readonly total: number };
  readonly numbersAvailable: number;
  readonly orders: DashboardOrdersView;
  readonly earnings: DashboardEarningsView;
  readonly payout: DashboardPayoutView;
}

export interface DashboardQueryServiceDeps {
  readonly gateway: DashboardQueryGateway;
  readonly balances: BalanceReader;
}

export type LoadDashboardOutcome =
  | { readonly ok: true; readonly view: DashboardView }
  | { readonly ok: false; readonly reason: "partner_not_found" };

export class DashboardQueryService {
  private readonly deps: DashboardQueryServiceDeps;

  constructor(deps: DashboardQueryServiceDeps) {
    this.deps = deps;
  }

  async load(tenant: TenantContext): Promise<LoadDashboardOutcome> {
    const [partner, counts, bucketBalances] = await Promise.all([
      this.deps.gateway.loadPartnerSummary(tenant),
      this.deps.gateway.loadCounts(tenant),
      this.deps.balances.computeBucketBalances(tenant.partnerId),
    ]);

    if (partner === null) {
      return { ok: false, reason: "partner_not_found" };
    }

    return { ok: true, view: toView(partner, counts, bucketBalances) };
  }
}

function toView(
  partner: PartnerSummary,
  counts: DashboardCounts,
  balances: Awaited<ReturnType<BalanceReader["computeBucketBalances"]>>,
): DashboardView {
  return {
    partner,
    devices: { online: counts.devicesOnline, total: counts.devicesTotal },
    numbersAvailable: counts.numbersAvailable,
    orders: {
      active: counts.ordersActive,
      total: counts.ordersTotal,
      success: counts.ordersSuccess,
    },
    earnings: {
      pendingIdr: balances.partner_pending,
      availableIdr: balances.partner_available,
    },
    payout: {
      lockedIdr: balances.partner_payout_locked,
      paidIdr: balances.partner_paid,
      openCount: counts.payoutsOpen,
      paidCount: counts.payoutsPaid,
    },
  };
}
