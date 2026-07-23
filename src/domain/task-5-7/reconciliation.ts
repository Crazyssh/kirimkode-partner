import {
  computeBalancesFromTransactions,
  LEDGER_BUCKETS,
  type LedgerBucket,
  type LedgerTransaction,
} from "../task-5-6/ledger";

/**
 * Reconciliation issue types (Req 20.6 / Property 31). Each corresponds to a
 * financial or lifecycle invariant that must hold across the persisted state.
 */
export type ReconciliationIssueType =
  | "ledger_transaction_not_zero_sum"
  | "ledger_global_imbalance"
  | "earning_snapshot_mismatch"
  | "duplicate_earning_for_order"
  | "duplicate_allocation_for_earning"
  | "payout_allocation_mismatch"
  | "projection_ledger_mismatch"
  | "order_number_pairing_mismatch"
  | "stale_online_device";

export type ReconciliationSeverity = "high" | "medium";

export interface ReconciliationIssue {
  readonly type: ReconciliationIssueType;
  readonly referenceId: string;
  readonly severity: ReconciliationSeverity;
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

export interface ReconciliationEarning {
  readonly id: string;
  readonly orderId: string;
  readonly amountIdr: number;
  readonly status: string;
}

export interface ReconciliationSnapshot {
  readonly orderId: string;
  readonly payoutIdr: number;
}

export interface ReconciliationAllocation {
  readonly earningId: string;
  readonly amountIdr: number;
}

export interface ReconciliationPayout {
  readonly id: string;
  readonly amountIdr: number;
  readonly allocations: readonly ReconciliationAllocation[];
}

export interface ReconciliationOrderNumberPair {
  readonly orderId: string;
  readonly orderStatus: string;
  readonly numberId: string;
  readonly numberStatus: string;
}

export interface ReconciliationDevice {
  readonly id: string;
  readonly effectiveStatus: "online" | "offline" | "disabled";
  readonly lastSeenAtEpochMs: number;
}

export interface ReconciliationInput {
  readonly ledgerTransactions?: readonly LedgerTransaction[];
  readonly earnings?: readonly ReconciliationEarning[];
  readonly orderSnapshots?: readonly ReconciliationSnapshot[];
  readonly payouts?: readonly ReconciliationPayout[];
  /**
   * Bucket balances the projection layer believes it holds. When provided, they
   * are compared against the balances derived from the ledger.
   */
  readonly projectionBalances?: Partial<Record<LedgerBucket, number>>;
  readonly orderNumberPairs?: readonly ReconciliationOrderNumberPair[];
  readonly devices?: readonly ReconciliationDevice[];
  readonly nowEpochMs?: number;
  readonly heartbeatTimeoutMs?: number;
}

export interface ReconciliationReport {
  readonly issues: readonly ReconciliationIssue[];
  readonly checkedInvariants: number;
  readonly consistent: boolean;
}

function sumEntries(transaction: LedgerTransaction): number {
  let sum = 0;
  for (const entry of transaction.entries) {
    sum += entry.amountIdrSigned;
  }
  return sum;
}

/**
 * Order status → number status pairs that constitute a consistent assignment.
 * `waiting_sms|success` implies the number is `busy`; a terminal-but-released
 * order implies the number is no longer held.
 */
function isConsistentOrderNumberPair(
  orderStatus: string,
  numberStatus: string,
): boolean {
  switch (orderStatus) {
    case "reserved":
      return numberStatus === "reserved";
    case "waiting_sms":
    case "success":
      return numberStatus === "busy";
    case "cancelled":
    case "timeout":
    case "failed":
      // Released back to the pool or parked offline/disabled — never still held.
      return numberStatus !== "reserved" && numberStatus !== "busy";
    default:
      return true;
  }
}

/**
 * Read-only financial/lifecycle reconciler (Req 20.6). It inspects the supplied
 * state, reports every invariant violation it finds, and NEVER mutates or
 * "repairs" money — remediation is always a separate, audited compensating
 * action. The report only ever contains detected issues.
 */
export function reconcile(input: ReconciliationInput): ReconciliationReport {
  const issues: ReconciliationIssue[] = [];
  let checkedInvariants = 0;

  const transactions = input.ledgerTransactions ?? [];

  // 1. Every ledger transaction must be zero-sum.
  checkedInvariants += 1;
  for (const transaction of transactions) {
    const sum = sumEntries(transaction);
    if (sum !== 0) {
      issues.push({
        type: "ledger_transaction_not_zero_sum",
        referenceId: transaction.eventKey,
        severity: "high",
        details: { signedSum: sum, eventType: transaction.eventType },
      });
    }
  }

  // 2. The whole ledger must be globally balanced.
  checkedInvariants += 1;
  const derived = computeBalancesFromTransactions(transactions);
  let globalTotal = 0;
  for (const bucket of LEDGER_BUCKETS) {
    globalTotal += derived[bucket];
  }
  if (globalTotal !== 0) {
    issues.push({
      type: "ledger_global_imbalance",
      referenceId: "ledger",
      severity: "high",
      details: { total: globalTotal },
    });
  }

  // 3. Earning amount must equal the order snapshot payout.
  checkedInvariants += 1;
  if (input.earnings && input.orderSnapshots) {
    const payoutByOrder = new Map<string, number>();
    for (const snapshot of input.orderSnapshots) {
      payoutByOrder.set(snapshot.orderId, snapshot.payoutIdr);
    }
    for (const earning of input.earnings) {
      const expected = payoutByOrder.get(earning.orderId);
      if (expected !== undefined && expected !== earning.amountIdr) {
        issues.push({
          type: "earning_snapshot_mismatch",
          referenceId: earning.id,
          severity: "high",
          details: {
            orderId: earning.orderId,
            expectedPayoutIdr: expected,
            earningAmountIdr: earning.amountIdr,
          },
        });
      }
    }
  }

  // 4. At most one earning per order.
  checkedInvariants += 1;
  if (input.earnings) {
    const earningsByOrder = new Map<string, string[]>();
    for (const earning of input.earnings) {
      const list = earningsByOrder.get(earning.orderId) ?? [];
      list.push(earning.id);
      earningsByOrder.set(earning.orderId, list);
    }
    for (const [orderId, earningIds] of earningsByOrder) {
      if (earningIds.length > 1) {
        issues.push({
          type: "duplicate_earning_for_order",
          referenceId: orderId,
          severity: "high",
          details: { count: earningIds.length, earningIds: earningIds.join(",") },
        });
      }
    }
  }

  // 5. Each earning is allocated to at most one payout, and payout amount
  //    equals the sum of its allocations.
  checkedInvariants += 2;
  if (input.payouts) {
    const allocationCount = new Map<string, number>();
    for (const payout of input.payouts) {
      let allocationTotal = 0;
      for (const allocation of payout.allocations) {
        allocationTotal += allocation.amountIdr;
        allocationCount.set(
          allocation.earningId,
          (allocationCount.get(allocation.earningId) ?? 0) + 1,
        );
      }
      if (allocationTotal !== payout.amountIdr) {
        issues.push({
          type: "payout_allocation_mismatch",
          referenceId: payout.id,
          severity: "high",
          details: {
            payoutAmountIdr: payout.amountIdr,
            allocationTotalIdr: allocationTotal,
          },
        });
      }
    }
    for (const [earningId, count] of allocationCount) {
      if (count > 1) {
        issues.push({
          type: "duplicate_allocation_for_earning",
          referenceId: earningId,
          severity: "high",
          details: { count },
        });
      }
    }
  }

  // 6. Projection balances must match the ledger-derived balances.
  checkedInvariants += 1;
  if (input.projectionBalances) {
    for (const bucket of LEDGER_BUCKETS) {
      const projected = input.projectionBalances[bucket];
      if (projected !== undefined && projected !== derived[bucket]) {
        issues.push({
          type: "projection_ledger_mismatch",
          referenceId: bucket,
          severity: "high",
          details: { projected, ledgerDerived: derived[bucket] },
        });
      }
    }
  }

  // 7. Order/number states must be paired consistently.
  checkedInvariants += 1;
  if (input.orderNumberPairs) {
    for (const pair of input.orderNumberPairs) {
      if (!isConsistentOrderNumberPair(pair.orderStatus, pair.numberStatus)) {
        issues.push({
          type: "order_number_pairing_mismatch",
          referenceId: pair.orderId,
          severity: "medium",
          details: {
            orderStatus: pair.orderStatus,
            numberId: pair.numberId,
            numberStatus: pair.numberStatus,
          },
        });
      }
    }
  }

  // 8. Devices marked online must not be stale beyond the heartbeat timeout.
  checkedInvariants += 1;
  if (
    input.devices &&
    input.nowEpochMs !== undefined &&
    input.heartbeatTimeoutMs !== undefined
  ) {
    for (const device of input.devices) {
      if (device.effectiveStatus !== "online") continue;
      const age = input.nowEpochMs - device.lastSeenAtEpochMs;
      if (age > input.heartbeatTimeoutMs) {
        issues.push({
          type: "stale_online_device",
          referenceId: device.id,
          severity: "medium",
          details: { ageMs: age, heartbeatTimeoutMs: input.heartbeatTimeoutMs },
        });
      }
    }
  }

  return {
    issues: Object.freeze(issues.map((issue) => Object.freeze(issue))),
    checkedInvariants,
    consistent: issues.length === 0,
  };
}
