/**
 * Pure operational + financial reconciler (task 16.4).
 *
 * The MVP reconciler is a *read-only* detective: it inspects a single tenant's
 * persisted state and reports every invariant violation it finds as a
 * {@link PersistedFinding}. It NEVER repairs money or mutates state — a finding
 * is a durable signal for manual, out-of-band action (requirement 20.6; design
 * section 10: "earning paid tidak dapat dibalik otomatis ... menjadi
 * reconciliation issue"). Remediation is always a separate, audited command.
 *
 * This module composes the task 5.7 financial/lifecycle detector
 * ({@link reconcile}, which verifies zero-sum ledger transactions, global
 * ledger balance, earning=snapshot, one-earning-per-order, allocation
 * uniqueness, payout=Σallocations, projection=ledger, order/number pairing, and
 * stale online devices — design section 10) with the number-centric checks the
 * design's section 7 also requires ("number tanpa/berganda order aktif"): a
 * held number with no active order, a number backing more than one active
 * order, and an idle number that still backs an active order.
 *
 * Every raw detector finding is then *classified* onto the fixed persisted
 * {@link PersistedIssueType} vocabulary (the six values the
 * `ReconciliationIssue` table and `PrismaReconciliationIssueRepository` accept),
 * carrying the precise detector name in `detailsSafeJson.detector` so no
 * information is lost. The `(type, referenceId)` pair is the deterministic
 * dedupe key the repository uses, so re-running the reconciler over unchanged
 * state records no new rows.
 */
import type { LedgerBucket, LedgerEntry, LedgerTransaction } from "../task-5-6/ledger";
import {
  reconcile,
  type ReconciliationDevice,
  type ReconciliationEarning,
  type ReconciliationIssue as DetailedIssue,
  type ReconciliationOrderNumberPair,
  type ReconciliationPayout,
  type ReconciliationSnapshot,
} from "../task-5-7/reconciliation";

/**
 * A ledger transaction as seen by the reconciler. Structurally the pure task
 * 5.6 {@link LedgerTransaction} but with `eventType` widened to `string`, so the
 * persistence adapter can pass the raw persisted event type (including the
 * `manual_adjustment` type the pure event-builder union does not mint) without
 * fabricating a value. The reconciler only reads the signed entries and the
 * event key/type, so the widening is safe.
 */
export interface ReconciliationLedgerTransaction {
  readonly eventType: string;
  readonly eventKey: string;
  readonly referenceType: string;
  readonly referenceId: string;
  readonly entries: readonly LedgerEntry[];
}

export type {
  ReconciliationDevice,
  ReconciliationEarning,
  ReconciliationOrderNumberPair,
  ReconciliationPayout,
  ReconciliationSnapshot,
};

/**
 * The fixed set of persisted reconciliation issue categories. These mirror the
 * `ReconciliationIssueType` Prisma enum and the application-layer union the
 * `PrismaReconciliationIssueRepository` accepts, so every finding maps onto one
 * of exactly these six values.
 */
export type PersistedIssueType =
  | "order_number_mismatch"
  | "earning_snapshot_mismatch"
  | "ledger_imbalance"
  | "payout_allocation_mismatch"
  | "projection_ledger_mismatch"
  | "stale_financial_state";

/** Persisted issue severity (mirrors the `ReconciliationSeverity` enum). */
export type PersistedIssueSeverity = "low" | "medium" | "high" | "critical";

/** A redaction-safe details payload; only non-sensitive scalars are allowed. */
export type PersistedIssueDetails = Readonly<
  Record<string, string | number | boolean | null>
>;

/**
 * A single detected invariant violation, classified onto the persisted
 * vocabulary and ready to hand to the reconciliation-issue repository. The
 * `(type, referenceId)` pair is the deterministic dedupe key.
 */
export interface PersistedFinding {
  readonly type: PersistedIssueType;
  /** The entity the finding is about (device id, number id, order id, …). */
  readonly referenceId: string;
  readonly severity: PersistedIssueSeverity;
  readonly detailsSafeJson: PersistedIssueDetails;
}

/**
 * A number and the set of active (`reserved`/`waiting_sms`) orders that
 * reference it. Used for the section-7 number-centric checks.
 */
export interface ReconciliationNumberState {
  readonly numberId: string;
  /** `offline | available | reserved | busy | disabled`. */
  readonly status: string;
  /** Ids of orders in an active (`reserved`/`waiting_sms`) state on this number. */
  readonly activeOrderIds: readonly string[];
}

/** The full per-tenant snapshot the reconciler inspects. */
export interface ReconcilePartnerInput {
  readonly ledgerTransactions?: readonly ReconciliationLedgerTransaction[];
  readonly earnings?: readonly ReconciliationEarning[];
  readonly orderSnapshots?: readonly ReconciliationSnapshot[];
  readonly payouts?: readonly ReconciliationPayout[];
  /** Bucket balances the projection layer believes it holds. */
  readonly projectionBalances?: Partial<Record<LedgerBucket, number>>;
  readonly orderNumberPairs?: readonly ReconciliationOrderNumberPair[];
  readonly numbers?: readonly ReconciliationNumberState[];
  readonly devices?: readonly ReconciliationDevice[];
  readonly nowEpochMs?: number;
  readonly heartbeatTimeoutMs?: number;
}

/** A raw detector finding before classification onto the persisted vocabulary. */
interface RawFinding {
  readonly detector: string;
  readonly referenceId: string;
  readonly severity: PersistedIssueSeverity;
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Map each raw detector name onto the persisted issue category it belongs to.
 * Several distinct detectors deliberately fold into one persisted type (e.g.
 * both zero-sum and global-balance failures are a `ledger_imbalance`); the
 * precise detector is preserved in `detailsSafeJson.detector`, and the
 * referenceIds never collide across detectors that share a persisted type.
 */
const DETECTOR_TO_PERSISTED_TYPE: Readonly<Record<string, PersistedIssueType>> = {
  // Ledger (design section 10: zero-sum per transaction + global balance).
  ledger_transaction_not_zero_sum: "ledger_imbalance",
  ledger_global_imbalance: "ledger_imbalance",
  // Earning vs snapshot + one earning per order.
  earning_snapshot_mismatch: "earning_snapshot_mismatch",
  duplicate_earning_for_order: "earning_snapshot_mismatch",
  // Allocation uniqueness + payout = Σ allocations.
  duplicate_allocation_for_earning: "payout_allocation_mismatch",
  payout_allocation_mismatch: "payout_allocation_mismatch",
  // Projection drift vs ledger bucket sums.
  projection_ledger_mismatch: "projection_ledger_mismatch",
  // Order/number state (design section 7).
  order_number_pairing_mismatch: "order_number_mismatch",
  number_missing_active_order: "order_number_mismatch",
  number_multiple_active_orders: "order_number_mismatch",
  number_active_order_not_held: "order_number_mismatch",
  // Stale online device (design section 7): a stale state flagged for manual
  // action; the generic stale-state bucket carries the detector detail.
  stale_online_device: "stale_financial_state",
};

/** Number statuses that mean the number is currently backing an order. */
const HELD_NUMBER_STATUSES: ReadonlySet<string> = new Set(["reserved", "busy"]);

/**
 * Section-7 number-centric checks: a number's status and the set of active
 * orders on it must agree. A held (`reserved`/`busy`) number must back exactly
 * one active order; an idle number must back none.
 */
function detectNumberIssues(
  numbers: readonly ReconciliationNumberState[],
): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const number of numbers) {
    const activeCount = number.activeOrderIds.length;
    const held = HELD_NUMBER_STATUSES.has(number.status);

    if (activeCount > 1) {
      // A number can never legitimately back two active orders at once.
      findings.push({
        detector: "number_multiple_active_orders",
        referenceId: number.numberId,
        severity: "high",
        details: {
          numberStatus: number.status,
          activeOrderCount: activeCount,
          activeOrderIds: number.activeOrderIds.join(","),
        },
      });
      continue;
    }

    if (held && activeCount === 0) {
      // Number busy/reserved but nothing is actually holding it.
      findings.push({
        detector: "number_missing_active_order",
        referenceId: number.numberId,
        severity: "medium",
        details: { numberStatus: number.status, activeOrderCount: 0 },
      });
    } else if (!held && activeCount === 1) {
      // An active order exists but the number was released back to the pool.
      findings.push({
        detector: "number_active_order_not_held",
        referenceId: number.numberId,
        severity: "medium",
        details: {
          numberStatus: number.status,
          activeOrderId: number.activeOrderIds[0],
        },
      });
    }
  }
  return findings;
}

/** Adapt a task 5.7 detailed issue into the raw-finding shape. */
function fromDetailedIssue(issue: DetailedIssue): RawFinding {
  return {
    detector: issue.type,
    referenceId: issue.referenceId,
    severity: issue.severity,
    details: issue.details,
  };
}

/** Classify a raw detector finding onto the persisted issue vocabulary. */
function classify(finding: RawFinding): PersistedFinding {
  const type = DETECTOR_TO_PERSISTED_TYPE[finding.detector];
  if (type === undefined) {
    // Defensive: an unmapped detector is a programming error, not silent data.
    throw new Error(`Unclassified reconciliation detector: ${finding.detector}`);
  }
  return {
    type,
    referenceId: finding.referenceId,
    severity: finding.severity,
    detailsSafeJson: { detector: finding.detector, ...finding.details },
  };
}

/**
 * Reconcile one tenant's state. Runs every financial and operational invariant
 * check and returns the classified findings in a deterministic order (financial
 * and lifecycle checks first, then the number-centric checks). The result is
 * purely a list of detected issues — no money or state is ever mutated.
 */
export function reconcilePartner(
  input: ReconcilePartnerInput,
): readonly PersistedFinding[] {
  const report = reconcile({
    // Safe widening: the task 5.7 reconciler only reads entries + event
    // key/type, never depending on the narrow pure event-type union.
    ledgerTransactions: input.ledgerTransactions as
      | readonly LedgerTransaction[]
      | undefined,
    earnings: input.earnings,
    orderSnapshots: input.orderSnapshots,
    payouts: input.payouts,
    projectionBalances: input.projectionBalances,
    orderNumberPairs: input.orderNumberPairs,
    devices: input.devices,
    nowEpochMs: input.nowEpochMs,
    heartbeatTimeoutMs: input.heartbeatTimeoutMs,
  });

  const raw: RawFinding[] = [
    ...report.issues.map(fromDetailedIssue),
    ...detectNumberIssues(input.numbers ?? []),
  ];

  return Object.freeze(raw.map((finding) => Object.freeze(classify(finding))));
}
