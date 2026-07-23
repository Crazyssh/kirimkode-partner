/**
 * Public API of the ledger + Earning projection application module (task 14.1).
 * Adapters implement these ports; later tasks (14.2 hold-release/reversal,
 * 14.3/14.4 payout) reuse them to persist their ledger events and projection
 * status advances. Transport and composition roots import the port types from
 * here; the Prisma adapters stay in the infrastructure layer.
 */
export type {
  AppendLedgerTransactionInput,
  AppendLedgerResult,
  BucketBalances,
  CreateEarningInput,
  EarningProjection,
  EarningProjectionRepository,
  EarningStatus,
  LedgerRepository,
  LedgerTransaction,
  UpdateEarningStatusInput,
  UpdateEarningStatusResult,
} from "./ports";

/**
 * Hold-release / reversal lifecycle (task 14.2): the reusable commands that
 * advance an Earning `pending → available` after the hold and reverse a
 * pending/available Earning, plus the seam that records a ReconciliationIssue
 * when a `paid` Earning reversal is blocked.
 */
export {
  EarningLifecycleService,
  type EarningLifecycleServiceDeps,
  type ReleaseHoldInput,
  type ReleaseHoldResult,
  type ReverseEarningInput,
  type ReverseEarningResult,
} from "./earning-lifecycle-service";
export type {
  Clock,
  EarningLifecycleTransactionRunner,
  IdGenerator,
  ReconciliationIssueDetails,
  ReconciliationIssueRepository,
  ReconciliationIssueType,
  ReconciliationSeverity,
  RecordReconciliationIssueInput,
  RecordReconciliationIssueResult,
} from "./earning-lifecycle-ports";
