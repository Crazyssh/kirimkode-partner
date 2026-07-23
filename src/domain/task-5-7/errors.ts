export type Task57DomainErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_AUDIT_DESCRIPTOR"
  | "INVALID_RAW_SMS_ACCESS"
  | "INVALID_RETENTION_INPUT"
  | "INVALID_CAPABILITY"
  | "INVALID_AMOUNT"
  | "INVALID_TIMESTAMP"
  | "INVALID_IDENTIFIER";

/**
 * Domain error for the config/audit/retention/reconciliation/simulator/formatter
 * domain (task 5.7). Mirrors the `code`-carrying error convention used across
 * `src/domain`.
 */
export class Task57DomainError extends Error {
  constructor(
    public readonly code: Task57DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "Task57DomainError";
  }
}

export function assertPositiveInteger(
  value: number,
  name: string,
  minimum = 1,
): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Task57DomainError(
      "INVALID_AMOUNT",
      `${name} must be a safe integer >= ${minimum}`,
    );
  }
}

export function assertNonNegativeInteger(value: number, name: string): void {
  assertPositiveInteger(value, name, 0);
}

export function assertValidEpochMs(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Task57DomainError(
      "INVALID_TIMESTAMP",
      `${name} must be a non-negative safe integer epoch (ms)`,
    );
  }
}

export function assertIdentifier(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Task57DomainError("INVALID_IDENTIFIER", `${name} is required`);
  }
}
