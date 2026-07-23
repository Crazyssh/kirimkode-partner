/**
 * Application-owned ports for the Earning projection and append-only ledger
 * repository (task 14.1).
 *
 * The ledger is the single source of monetary truth (design section 10):
 * balances are always derived from the SUM of signed `LedgerEntry` rows per
 * bucket, never from a mutable balance column (requirement 13.6). Every event —
 * order success, hold release, reversal, and payout lock/unlock/paid — is
 * persisted as one `LedgerTransaction` with a globally unique `eventKey` and at
 * least two zero-sum entries, so a retried event with the same key is a
 * deterministic no-op (requirement 13.5, 13.7). `PartnerEarning` is a workflow
 * projection layered on top of the ledger; this module owns the seams for
 * creating, reading, and advancing an Earning's status consistently with the
 * ledger.
 *
 * These ports are parameterized by the transaction handle `Tx` so the ledger
 * append and any paired projection write commit atomically with the caller's
 * unit of work — the SMS-success unit (task 13.3) and the later hold-release,
 * reversal, and payout units (tasks 14.2–14.4). Infrastructure supplies the
 * Prisma adapter; raw Prisma never leaves that adapter.
 */
import type {
  BucketBalances,
  EarningStatus,
  LedgerTransaction,
} from "@domain/task-5-6";

export type { BucketBalances, EarningStatus, LedgerTransaction };

/** Input for appending one validated, zero-sum ledger transaction. */
export interface AppendLedgerTransactionInput {
  /** Trusted tenant id (from session/service principal, never client input). */
  readonly partnerId: string;
  /** A validated pure-domain transaction (already asserted zero-sum). */
  readonly transaction: LedgerTransaction;
}

/**
 * The result of an append. A first write reports `appended` with the new
 * transaction id; a retry whose `eventKey` already exists reports
 * `duplicate_no_op` without writing a second transaction or duplicate entries.
 */
export type AppendLedgerResult =
  | { readonly outcome: "appended"; readonly transactionId: string }
  | { readonly outcome: "duplicate_no_op" };

/**
 * Append-only ledger persistence. `appendTransaction` is idempotent on
 * `eventKey`; `computeBucketBalances` derives per-bucket balances by SUM.
 */
export interface LedgerRepository<Tx> {
  /**
   * Append one zero-sum transaction and its entries atomically on the caller's
   * transaction handle. Re-validates the zero-sum invariant as defense in
   * depth, then either inserts the transaction (with its entries) or, when a
   * transaction with the same `eventKey` already exists, returns a no-op.
   */
  appendTransaction(
    tx: Tx,
    input: AppendLedgerTransactionInput,
  ): Promise<AppendLedgerResult>;

  /**
   * Compute the partner's balance per bucket as the SUM of signed ledger
   * entries (design section 10). Every bucket is present in the result, zero
   * when it has no entries. This is a read; it may run on the root executor or
   * inside a transaction.
   */
  computeBucketBalances(partnerId: string): Promise<BucketBalances>;
}

/** The Earning projection row exposed to application services. */
export interface EarningProjection {
  readonly id: string;
  readonly partnerId: string;
  readonly orderId: string;
  readonly amountIdr: number;
  readonly status: EarningStatus;
  readonly availableAtEpochMs: number;
  readonly reversedAtEpochMs: number | null;
}

/** Fields needed to create the single pending Earning on first order success. */
export interface CreateEarningInput {
  readonly id: string;
  readonly partnerId: string;
  readonly orderId: string;
  readonly amountIdr: number;
  readonly availableAtEpochMs: number;
}

/**
 * A compare-and-set advance of an Earning's projection status. The write only
 * succeeds when the row is still at `expectedStatus`, so a concurrent or
 * retried transition is detected rather than double-applied. `reversedAtEpochMs`
 * is stamped only for the `reversed` target.
 */
export interface UpdateEarningStatusInput {
  readonly earningId: string;
  readonly partnerId: string;
  readonly expectedStatus: EarningStatus;
  readonly nextStatus: EarningStatus;
  readonly reversedAtEpochMs?: number;
}

export type UpdateEarningStatusResult =
  | { readonly outcome: "updated" }
  | { readonly outcome: "no_op" };

/**
 * Projection persistence for `PartnerEarning`. The ledger remains the source of
 * monetary truth; these methods keep the workflow projection consistent with
 * it. Creates and status advances run on the caller's transaction handle.
 */
export interface EarningProjectionRepository<Tx> {
  /**
   * Create the single pending Earning for an order. The `(orderId, partnerId)`
   * unique constraint makes a retried success a no-op (requirement 13.7),
   * reported as `created: false`.
   */
  createEarning(
    tx: Tx,
    input: CreateEarningInput,
  ): Promise<{ readonly created: boolean }>;

  /** Read one Earning by id within the tenant, or `null` when absent. */
  findEarningById(
    partnerId: string,
    earningId: string,
  ): Promise<EarningProjection | null>;

  /** Read the Earning bound to an order within the tenant, or `null`. */
  findEarningByOrderId(
    partnerId: string,
    orderId: string,
  ): Promise<EarningProjection | null>;

  /**
   * Advance an Earning's status with a compare-and-set on `expectedStatus`.
   * Returns `no_op` when no row matched (already advanced or absent), so the
   * caller can treat an already-applied transition as success.
   */
  updateEarningStatus(
    tx: Tx,
    input: UpdateEarningStatusInput,
  ): Promise<UpdateEarningStatusResult>;
}
