import {
  assertIdentifier,
  assertSafeAmount,
  Task56DomainError,
} from "./errors";

/**
 * Append-only ledger buckets. Balances are always derived from the SUM of
 * signed entries per bucket; no mutable balance column exists (Req 13.6).
 */
export const LEDGER_BUCKETS = [
  "platform_partner_payable",
  "partner_pending",
  "partner_available",
  "partner_payout_locked",
  "partner_paid",
  "partner_reversed",
] as const;

export type LedgerBucket = (typeof LEDGER_BUCKETS)[number];

export const LEDGER_EVENT_TYPES = [
  "order-success",
  "hold-release",
  "payout-lock",
  "payout-paid",
  "payout-unlock",
  "earning-reversal",
] as const;

export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

export interface LedgerEntry {
  readonly bucket: LedgerBucket;
  readonly amountIdrSigned: number;
}

export interface LedgerTransaction {
  readonly eventType: LedgerEventType;
  readonly eventKey: string;
  readonly referenceType: string;
  readonly referenceId: string;
  readonly entries: readonly LedgerEntry[];
}

const BUCKET_SET: ReadonlySet<string> = new Set(LEDGER_BUCKETS);

function isSignedSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value);
}

/**
 * A well-formed ledger transaction has at least two entries whose signed
 * amounts sum to exactly zero (double-entry, zero-sum invariant).
 */
export function assertZeroSumEntries(
  entries: readonly LedgerEntry[],
): void {
  if (entries.length < 2) {
    throw new Task56DomainError(
      "INSUFFICIENT_LEDGER_ENTRIES",
      "A ledger transaction requires at least two entries",
    );
  }
  let sum = 0;
  for (const entry of entries) {
    if (!BUCKET_SET.has(entry.bucket)) {
      throw new Task56DomainError(
        "INVALID_BUCKET",
        `Unknown ledger bucket: ${String(entry.bucket)}`,
      );
    }
    if (!isSignedSafeInteger(entry.amountIdrSigned)) {
      throw new Task56DomainError(
        "INVALID_AMOUNT",
        "Ledger entry amount must be a safe integer",
      );
    }
    sum += entry.amountIdrSigned;
  }
  if (sum !== 0) {
    throw new Task56DomainError(
      "LEDGER_IMBALANCE",
      `Signed ledger entries must sum to zero (got ${sum})`,
    );
  }
}

/**
 * Build an immutable, validated ledger transaction. The transaction is the
 * single source of monetary truth; projections (earning/payout) are derived.
 */
export function createLedgerTransaction(input: {
  readonly eventType: LedgerEventType;
  readonly eventKey: string;
  readonly referenceType: string;
  readonly referenceId: string;
  readonly entries: readonly LedgerEntry[];
}): LedgerTransaction {
  assertIdentifier(input.eventKey, "eventKey");
  assertIdentifier(input.referenceType, "referenceType");
  assertIdentifier(input.referenceId, "referenceId");
  assertZeroSumEntries(input.entries);
  return Object.freeze({
    eventType: input.eventType,
    eventKey: input.eventKey,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    entries: Object.freeze(
      input.entries.map((entry) =>
        Object.freeze({
          bucket: entry.bucket,
          amountIdrSigned: entry.amountIdrSigned,
        }),
      ),
    ),
  });
}

/**
 * Helper for the common two-entry "move funds between buckets" event.
 */
export function createTransferTransaction(input: {
  readonly eventType: LedgerEventType;
  readonly eventKey: string;
  readonly referenceType: string;
  readonly referenceId: string;
  readonly fromBucket: LedgerBucket;
  readonly toBucket: LedgerBucket;
  readonly amountIdr: number;
}): LedgerTransaction {
  assertSafeAmount(input.amountIdr, "amountIdr");
  return createLedgerTransaction({
    eventType: input.eventType,
    eventKey: input.eventKey,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    entries: [
      { bucket: input.fromBucket, amountIdrSigned: -input.amountIdr },
      { bucket: input.toBucket, amountIdrSigned: input.amountIdr },
    ],
  });
}

export type BucketBalances = Readonly<Record<LedgerBucket, number>>;

function emptyBalances(): Record<LedgerBucket, number> {
  const balances = {} as Record<LedgerBucket, number>;
  for (const bucket of LEDGER_BUCKETS) {
    balances[bucket] = 0;
  }
  return balances;
}

/**
 * Compute per-bucket balances from a flat list of ledger entries (the portal
 * saldo is derived exactly this way).
 */
export function computeBucketBalances(
  entries: readonly LedgerEntry[],
): BucketBalances {
  const balances = emptyBalances();
  for (const entry of entries) {
    if (!BUCKET_SET.has(entry.bucket)) {
      throw new Task56DomainError(
        "INVALID_BUCKET",
        `Unknown ledger bucket: ${String(entry.bucket)}`,
      );
    }
    balances[entry.bucket] += entry.amountIdrSigned;
  }
  return Object.freeze(balances);
}

/**
 * Compute balances from a set of full transactions.
 */
export function computeBalancesFromTransactions(
  transactions: readonly LedgerTransaction[],
): BucketBalances {
  const allEntries: LedgerEntry[] = [];
  for (const transaction of transactions) {
    allEntries.push(...transaction.entries);
  }
  return computeBucketBalances(allEntries);
}

/**
 * The whole ledger must be globally zero-sum across every bucket.
 */
export function isLedgerBalanced(balances: BucketBalances): boolean {
  let total = 0;
  for (const bucket of LEDGER_BUCKETS) {
    total += balances[bucket];
  }
  return total === 0;
}

// Deterministic event keys. A duplicate key makes a retry a no-op (Req 13.7).
export function orderSuccessEventKey(orderId: string): string {
  return `order-success:${orderId}`;
}

export function holdReleaseEventKey(earningId: string): string {
  return `hold-release:${earningId}`;
}

export function earningReversalEventKey(earningId: string): string {
  return `earning-reversal:${earningId}`;
}

export function payoutLockEventKey(payoutId: string): string {
  return `payout-lock:${payoutId}`;
}

export function payoutPaidEventKey(payoutId: string): string {
  return `payout-paid:${payoutId}`;
}

export function payoutUnlockEventKey(payoutId: string): string {
  return `payout-unlock:${payoutId}`;
}
