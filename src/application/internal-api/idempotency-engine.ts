/**
 * Internal API v1 idempotency engine (task 9.2).
 *
 * A reusable, transport-agnostic engine that makes every state- or money-
 * changing Internal API operation exactly-once under retry (requirements 10.3,
 * 10.4, 10.5, 20.5). The operations built in tasks 9.3/9.4 (reserve, cancel,
 * timeout, reconciliation) wrap their domain effect in {@link runIdempotent};
 * the engine owns the persistence and replay semantics so each operation only
 * writes its own effect.
 *
 * Guarantees, per design section 4:
 *
 *  - **Atomic record.** The idempotency record `(scope, principal, key,
 *    requestHash, statusCode, responseJson)` is written in the *same*
 *    transaction as the domain effect. Either both commit or neither does, so a
 *    crash between effect and record is impossible.
 *  - **Payload-bound replay.** A retry with the same key *and* the same
 *    canonical request hash returns the first stored response verbatim without
 *    re-running the effect (requirement 10.4). A reused key with a different
 *    payload is rejected as `IDEMPOTENCY_CONFLICT` (requirement 10.5).
 *  - **Key required.** Mutations without a usable key are rejected as
 *    `IDEMPOTENCY_REQUIRED` (requirement 10.3).
 *  - **Concurrent safety.** Two in-flight requests with the same key race on
 *    the unique `(scope, principalId, key)` constraint; the loser re-reads the
 *    committed record and replays it, so no double effect can occur.
 *  - **TTL retention.** Financial mutations are retained for 7 years,
 *    operational mutations for 90 days (design section 4).
 *
 * Business-level failures (e.g. out of stock, invalid transition) are returned
 * by the effect as a definitive `{ statusCode, response }` and *are* persisted,
 * so Main receives a deterministic result on retry (requirement 9.6). Only
 * thrown exceptions roll the transaction back, leaving nothing persisted so the
 * caller may safely retry a transient failure.
 */
import { decideIdempotency, type StoredIdempotencyResult } from "@domain/task-5-3/idempotency";
import { hashCanonicalRequest, type JsonValue } from "@domain/task-5-3/canonical-request-hash";

import type {
  Clock,
  IdempotencyStore,
  IdempotencyTransactionRunner,
} from "./ports";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Retention window for financial mutations: 7 years (design section 4). */
export const FINANCIAL_RETENTION_MS = 7 * 365 * DAY_MS;
/** Retention window for operational mutations: 90 days (design section 4). */
export const OPERATIONAL_RETENTION_MS = 90 * DAY_MS;

/**
 * Retention class of a mutation. `financial` covers anything that creates or
 * moves money (reserve, which commits a buyer debit downstream); `operational`
 * covers pure state changes (cancel, timeout, reconciliation).
 */
export type RetentionClass = "financial" | "operational";

/** The definitive result an effect returns to be persisted and replayed. */
export interface IdempotentEffectResult<T extends JsonValue> {
  readonly statusCode: number;
  readonly response: T;
}

export interface RunIdempotentInput<T extends JsonValue, Tx> {
  /** Operation namespace, e.g. `orders.reserve` (part of the unique key). */
  readonly scope: string;
  /** The authenticated service principal id (part of the unique key). */
  readonly principalId: string;
  /** The client-supplied idempotency key; validated before use. */
  readonly idempotencyKey: string | null | undefined;
  /** Canonical request method (bound into the request hash). */
  readonly method: string;
  /** Canonical request path (bound into the request hash). */
  readonly path: string;
  /** The request payload (bound into the request hash, payload-sensitive). */
  readonly payload: JsonValue;
  /** Which retention window the persisted record uses. */
  readonly retention: RetentionClass;
  /**
   * The domain effect, run inside the idempotency transaction. It receives the
   * transaction handle so its writes commit atomically with the record. It must
   * return a definitive `{ statusCode, response }`; throwing rolls everything
   * back and surfaces a retryable failure to the caller.
   */
  readonly effect: (tx: Tx) => Promise<IdempotentEffectResult<T>>;
}

/** The outcome of an idempotent run. `rejected` never ran the effect. */
export type IdempotentOutcome<T extends JsonValue> =
  | { readonly kind: "executed"; readonly statusCode: number; readonly response: T }
  | { readonly kind: "replayed"; readonly statusCode: number; readonly response: JsonValue }
  | { readonly kind: "rejected"; readonly code: "IDEMPOTENCY_REQUIRED" | "IDEMPOTENCY_CONFLICT" };

/**
 * Raised by an {@link IdempotencyStore} when an `insert` loses the race on the
 * `(scope, principalId, key)` unique constraint. The engine catches it and
 * replays the committed record. Infrastructure adapters translate their native
 * unique-violation error (e.g. Prisma P2002) into this type or return
 * `{ inserted: false }`; both paths are handled.
 */
export class IdempotencyInsertConflictError extends Error {
  constructor() {
    super("Idempotency record already exists for this scope/principal/key");
    this.name = "IdempotencyInsertConflictError";
  }
}

/**
 * Raised when a concurrent insert conflict occurs but the committed record
 * cannot be read back (should be vanishingly rare). Callers map it to a
 * retryable dependency error so the client simply retries.
 */
export class IdempotencyReplayUnavailableError extends Error {
  constructor() {
    super("Idempotency record could not be replayed after a write conflict");
    this.name = "IdempotencyReplayUnavailableError";
  }
}

export interface IdempotencyEngineDeps<Tx> {
  readonly store: IdempotencyStore<Tx>;
  readonly runner: IdempotencyTransactionRunner<Tx>;
  readonly clock: Clock;
  /** Overridable retention windows (defaults to the design values). */
  readonly financialRetentionMs?: number;
  readonly operationalRetentionMs?: number;
}

const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export class IdempotencyEngine<Tx> {
  private readonly deps: IdempotencyEngineDeps<Tx>;
  private readonly financialRetentionMs: number;
  private readonly operationalRetentionMs: number;

  constructor(deps: IdempotencyEngineDeps<Tx>) {
    this.deps = deps;
    this.financialRetentionMs = deps.financialRetentionMs ?? FINANCIAL_RETENTION_MS;
    this.operationalRetentionMs = deps.operationalRetentionMs ?? OPERATIONAL_RETENTION_MS;
  }

  async runIdempotent<T extends JsonValue>(
    input: RunIdempotentInput<T, Tx>,
  ): Promise<IdempotentOutcome<T>> {
    const key = input.idempotencyKey?.trim();
    if (!key || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      // Reject before any transaction: a mutation with no usable key never runs.
      return { kind: "rejected", code: "IDEMPOTENCY_REQUIRED" };
    }

    const requestHash = await hashCanonicalRequest({
      scope: input.scope,
      principalId: input.principalId,
      idempotencyKey: key,
      method: input.method,
      path: input.path,
      payload: input.payload,
    });

    const lookup = { scope: input.scope, principalId: input.principalId, key };

    try {
      return await this.deps.runner.run(async (tx) => {
        const stored = await this.deps.store.find(tx, lookup);
        const decision = decideIdempotency<JsonValue>({
          scope: input.scope,
          principalId: input.principalId,
          key,
          requestHash,
          stored: toStored(stored),
        });

        if (decision.kind === "replay") {
          return { kind: "replayed", statusCode: decision.statusCode, response: decision.response };
        }
        if (decision.kind === "reject") {
          return { kind: "rejected", code: decision.code };
        }

        // No prior record: run the effect and persist its result atomically.
        const result = await input.effect(tx);
        const { inserted } = await this.deps.store.insert(tx, {
          ...lookup,
          requestHash,
          responseStatus: result.statusCode,
          responseJson: result.response,
          state: "completed",
          expiresAtEpochMs: this.expiresAt(input.retention),
        });
        if (!inserted) {
          // A concurrent attempt committed the same key first; abandon this
          // transaction and replay the winner's record.
          throw new IdempotencyInsertConflictError();
        }
        return { kind: "executed", statusCode: result.statusCode, response: result.response };
      });
    } catch (error) {
      if (error instanceof IdempotencyInsertConflictError) {
        return this.replayAfterConflict(lookup, requestHash);
      }
      throw error;
    }
  }

  /** Absolute expiry for a freshly written record, per its retention class. */
  private expiresAt(retention: RetentionClass): number {
    const window = retention === "financial"
      ? this.financialRetentionMs
      : this.operationalRetentionMs;
    return this.deps.clock.nowEpochMs() + window;
  }

  /**
   * Re-read a committed record after a write-conflict and replay it. If the
   * payloads differ this still surfaces as `IDEMPOTENCY_CONFLICT`; if the record
   * has vanished (unexpected) it raises {@link IdempotencyReplayUnavailableError}.
   */
  private async replayAfterConflict<T extends JsonValue>(
    lookup: { scope: string; principalId: string; key: string },
    requestHash: string,
  ): Promise<IdempotentOutcome<T>> {
    const stored = await this.deps.runner.run((tx) => this.deps.store.find(tx, lookup));
    const decision = decideIdempotency<JsonValue>({
      ...lookup,
      requestHash,
      stored: toStored(stored),
    });
    if (decision.kind === "replay") {
      return { kind: "replayed", statusCode: decision.statusCode, response: decision.response };
    }
    if (decision.kind === "reject") {
      return { kind: "rejected", code: decision.code };
    }
    throw new IdempotencyReplayUnavailableError();
  }
}

/** Adapt a persisted row into the pure domain's stored-result shape. */
function toStored(
  row: {
    readonly scope: string;
    readonly principalId: string;
    readonly key: string;
    readonly requestHash: string;
    readonly responseStatus: number;
    readonly responseJson: JsonValue;
  } | null,
): StoredIdempotencyResult<JsonValue> | null {
  if (row === null) return null;
  return {
    scope: row.scope,
    principalId: row.principalId,
    key: row.key,
    requestHash: row.requestHash,
    statusCode: row.responseStatus,
    response: row.responseJson,
  };
}
