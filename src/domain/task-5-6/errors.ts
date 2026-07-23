export type Task56DomainErrorCode =
  | "INVALID_AMOUNT"
  | "INVALID_TIMESTAMP"
  | "INVALID_IDENTIFIER"
  | "LEDGER_IMBALANCE"
  | "INSUFFICIENT_LEDGER_ENTRIES"
  | "INVALID_BUCKET"
  | "EMPTY_PAYOUT"
  | "DUPLICATE_EARNING"
  | "EARNING_NOT_AVAILABLE"
  | "PAYOUT_BELOW_MINIMUM"
  | "MISSING_PAYMENT_REFERENCE"
  | "DUPLICATE_PAYMENT_REFERENCE"
  | "MISSING_REASON"
  | "ALLOCATION_AMOUNT_MISMATCH";

/**
 * Domain error for the earning, ledger, and manual payout domain (task 5.6).
 * Mirrors the `code`-carrying error convention used elsewhere in `src/domain`.
 */
export class Task56DomainError extends Error {
  constructor(
    public readonly code: Task56DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "Task56DomainError";
  }
}

export function assertSafeAmount(value: number, name: string, minimum = 1): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Task56DomainError(
      "INVALID_AMOUNT",
      `${name} must be a safe integer >= ${minimum}`,
    );
  }
}

export function assertValidTimestamp(value: Date, name: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Task56DomainError("INVALID_TIMESTAMP", `${name} must be a valid Date`);
  }
}

export function assertIdentifier(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Task56DomainError("INVALID_IDENTIFIER", `${name} is required`);
  }
}
