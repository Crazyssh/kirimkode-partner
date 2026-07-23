import { Prisma } from "@/generated/prisma";

/**
 * Persistence-layer errors.
 *
 * Both errors carry a `kind` field so that the transport boundary's
 * `mapDomainError` (src/domain/task-5-3/safe-errors.ts) turns them into the
 * stable safe error envelope without any extra glue:
 *   - `not_found`      -> 404 RESOURCE_NOT_FOUND
 *   - `state_conflict` -> 409 STATE_CONFLICT
 *
 * Cross-tenant access is deliberately mapped to `ResourceNotFoundError`
 * (RESOURCE_NOT_FOUND) so a caller can never distinguish "does not exist" from
 * "belongs to another tenant" (design.md: "Resource tenant lain diperlakukan
 * `404 RESOURCE_NOT_FOUND`").
 */
export class ResourceNotFoundError extends Error {
  readonly kind = "not_found" as const;

  constructor(message = "Resource was not found.") {
    super(message);
    this.name = "ResourceNotFoundError";
  }
}

/**
 * Raised when a compare-and-set (optimistic concurrency) update does not match
 * because the persisted `version` moved on. It is retryable: the caller should
 * re-read and retry against the new state.
 */
export class ConcurrencyConflictError extends Error {
  readonly kind = "state_conflict" as const;
  readonly retryableStateConflict = true;

  constructor(message = "The resource state changed; refresh before retrying.") {
    super(message);
    this.name = "ConcurrencyConflictError";
  }
}

/**
 * Detects the Prisma-level write conflict / deadlock codes so a serialized
 * transaction failure surfaces as a retryable concurrency conflict rather than
 * an opaque internal error.
 *   - P2034: transaction failed due to a write conflict or deadlock.
 *   - P2025: an operation depended on a record that was not found.
 */
export function isRetryableWriteConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" || error.code === "P2025")
  );
}
