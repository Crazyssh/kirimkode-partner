/**
 * Application-owned ports for the Earning hold-release and reversal lifecycle
 * (task 14.2).
 *
 * These commands sit on top of the task 14.1 {@link LedgerRepository} and
 * {@link EarningProjectionRepository}: legality lives in the pure task 5.6
 * domain (`decideHoldRelease`, `decideEarningReversal`), while these seams only
 * supply the transaction handle, the current time, and — for the one case the
 * domain refuses to auto-repair — a way to record a ReconciliationIssue rather
 * than move money silently (requirement 20.6; design section 10: "earning paid
 * tidak dapat dibalik otomatis ... menjadi reconciliation issue").
 *
 * Idempotency is inherited from task 14.1: the append is a deterministic no-op
 * on a duplicate `eventKey` and the projection advance is a compare-and-set on
 * the expected status, so a retried hold-release (the earning-release cron of
 * task 16.3 re-runs the same command) or a retried reversal produces at most
 * one real effect. Infrastructure supplies the Prisma adapters; raw Prisma
 * never leaves that layer.
 */

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Generates the opaque UUID for a freshly persisted ReconciliationIssue row. */
export interface IdGenerator {
  uuid(): string;
}

/**
 * Runs a unit of work inside a single database transaction, exposing the
 * transaction handle `Tx` to the work function so the ledger append and the
 * paired projection advance commit atomically (or, for the paid-earning block,
 * so the ReconciliationIssue is persisted durably). Structurally identical to
 * the Internal API idempotency runner, so the shared Prisma adapter satisfies
 * both — no tenant is bound because the ledger/earning repositories already
 * fold the trusted `partnerId` into every predicate.
 */
export interface EarningLifecycleTransactionRunner<Tx> {
  run<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}

/**
 * The set of financial-invariant issue categories persisted for manual review
 * (design section 10). Task 14.2 only records `stale_financial_state` — an
 * attempt to auto-reverse a `paid` Earning — but the full set is declared here
 * so the task 16.4 reconciler can reuse the same seam.
 */
export type ReconciliationIssueType =
  | "order_number_mismatch"
  | "earning_snapshot_mismatch"
  | "ledger_imbalance"
  | "payout_allocation_mismatch"
  | "projection_ledger_mismatch"
  | "stale_financial_state";

/** Severity of a recorded reconciliation issue. */
export type ReconciliationSeverity = "low" | "medium" | "high" | "critical";

/** A redaction-safe details payload; only non-sensitive scalars are allowed. */
export type ReconciliationIssueDetails = Readonly<
  Record<string, string | number | boolean | null>
>;

/** Everything needed to record one reconciliation issue. */
export interface RecordReconciliationIssueInput {
  /** Opaque UUID for the new issue (ignored when an open issue already exists). */
  readonly id: string;
  /** Trusted tenant id (from the earning being processed, never client input). */
  readonly partnerId: string;
  readonly type: ReconciliationIssueType;
  /** The entity the issue is about (e.g. the earning id). */
  readonly referenceId: string;
  readonly severity: ReconciliationSeverity;
  readonly detailsSafeJson: ReconciliationIssueDetails;
}

/**
 * The result of recording an issue. Recording is idempotent per open issue:
 * when an `open` issue of the same `(partnerId, type, referenceId)` already
 * exists it is reused rather than duplicated, so a retried block does not spawn
 * a second row (design section 10: "persist/dedupe issue").
 */
export type RecordReconciliationIssueResult =
  | { readonly outcome: "recorded"; readonly issueId: string }
  | { readonly outcome: "duplicate_no_op"; readonly issueId: string };

/**
 * Persistence for reconciliation issues, parameterized by the transaction
 * handle `Tx` so a recorded issue commits atomically with the caller's unit of
 * work. No silent money repair ever happens here — an issue is a durable
 * signal for manual, out-of-band action (requirement 20.6).
 */
export interface ReconciliationIssueRepository<Tx> {
  recordIssue(
    tx: Tx,
    input: RecordReconciliationIssueInput,
  ): Promise<RecordReconciliationIssueResult>;
}
