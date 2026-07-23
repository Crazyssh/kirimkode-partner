/**
 * Application-owned ports for the Internal API v1 HMAC request authenticator
 * (task 9.1). The authenticator orchestrates the pure task 9.1 / task 5.3
 * signing + replay domain over these seams; infrastructure supplies the
 * adapters (node HMAC/SHA-256, the Prisma-backed `ServiceCredential` and
 * `ReplayNonce` gateways, a rate-limit store). Keeping the seams here lets the
 * guard be unit-tested with in-memory fakes and keeps raw Prisma and node
 * crypto out of the transport layer.
 */
import type { WindowCounter, WindowDecision, WindowRule } from "@domain/task-7-2";
import type { JsonValue } from "@domain/task-5-3/canonical-request-hash";

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Lifecycle status of a service credential (mirrors the persisted enum). */
export type ServiceCredentialStatus = "active" | "superseded" | "revoked";

/** The subset of a `ServiceCredential` row the authenticator needs. */
export interface ServiceCredentialRecord {
  readonly clientId: string;
  readonly keyId: string;
  readonly status: ServiceCredentialStatus;
}

/**
 * Read port for service credentials. The lookup is folded on `(clientId,
 * keyId)`; a revoked/superseded or missing credential must not authenticate a
 * request (requirement 10.1). These are service-to-service credentials, wholly
 * separate from human sessions and device tokens.
 */
export interface ServiceCredentialGateway {
  findCredential(
    clientId: string,
    keyId: string,
  ): Promise<ServiceCredentialRecord | null>;
}

/**
 * Anti-replay nonce registry. Registration is a single atomic insert keyed by
 * `(principalId, nonce)`; the unique constraint makes a concurrent replay lose
 * the race. Returns `true` when the nonce was freshly registered and `false`
 * when it already existed (a replay). The adapter hashes the nonce before
 * persisting so the raw value never lands in a table.
 */
export interface ReplayNonceRegistry {
  registerNonce(
    principalId: string,
    nonce: string,
    expiresAtEpochMs: number,
  ): Promise<boolean>;
}

/**
 * Keyed HMAC-SHA256 signing verifier plus body hashing. `bodySha256Hex`
 * produces the lower-case hex body digest for the canonical string;
 * `verifySignature` recomputes the HMAC over the canonical string with the
 * selected secret and compares it to the presented signature in constant time
 * (design section 4: "Signature dibandingkan constant-time").
 */
export interface HmacSignatureVerifier {
  bodySha256Hex(rawBody: string): string;
  verifySignature(
    canonicalString: string,
    secret: string,
    presentedSignatureHex: string,
  ): boolean;
}

/**
 * Best-effort keyed counter store for rate limiting, shared with the auth
 * module. Rate limiting is abuse mitigation, not financial truth, so a
 * process-local implementation is acceptable for the MVP.
 */
export interface RateLimitStore {
  get(key: string): Promise<WindowCounter | undefined>;
  set(key: string, counter: WindowCounter, expiresAtEpochMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Persisted idempotency lifecycle state (mirrors the `IdempotencyState` enum).
 * The MVP idempotency engine persists a record atomically with its effect, so
 * only definitive `completed` records are ever written.
 */
export type IdempotencyRecordState = "processing" | "completed" | "failed";

/** A persisted idempotency record row, as read back for replay/conflict checks. */
export interface IdempotencyRecordRow {
  readonly scope: string;
  readonly principalId: string;
  readonly key: string;
  readonly requestHash: string;
  readonly responseStatus: number;
  readonly responseJson: JsonValue;
}

/** The values written when an effect completes and its record is persisted. */
export interface IdempotencyRecordInsert {
  readonly scope: string;
  readonly principalId: string;
  readonly key: string;
  readonly requestHash: string;
  readonly responseStatus: number;
  readonly responseJson: JsonValue;
  readonly state: IdempotencyRecordState;
  readonly expiresAtEpochMs: number;
}

/**
 * Lookup key for an idempotency record: the `(scope, principalId, key)` unique
 * tuple that identifies one logical mutation attempt.
 */
export interface IdempotencyRecordLookup {
  readonly scope: string;
  readonly principalId: string;
  readonly key: string;
}

/**
 * Transactional store for idempotency records, parameterized by the transaction
 * handle `Tx` the effect also writes through. Both `find` and `insert` execute
 * on the *same* transaction as the domain effect so the record and the effect
 * commit together (design section 4). `insert` reports whether the row was
 * freshly written; `false` (a lost race on the `(scope, principalId, key)`
 * unique constraint) tells the engine a concurrent attempt won and it should
 * replay the committed record instead.
 */
export interface IdempotencyStore<Tx> {
  find(tx: Tx, lookup: IdempotencyRecordLookup): Promise<IdempotencyRecordRow | null>;
  insert(tx: Tx, record: IdempotencyRecordInsert): Promise<{ readonly inserted: boolean }>;
}

/**
 * Runs a unit of work inside a single database transaction, exposing the
 * transaction handle `Tx` to the work function. Unlike the tenant-scoped unit
 * of work (task 7.1), the Internal API idempotency engine is keyed on a service
 * principal rather than a partner tenant, so it uses this thinner seam.
 */
export interface IdempotencyTransactionRunner<Tx> {
  run<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}

export type { WindowCounter, WindowDecision, WindowRule };
