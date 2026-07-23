/**
 * Application-owned ports for payout-destination management and the atomic
 * payout request (task 14.3).
 *
 * Two commands sit on top of these seams, both keeping their legality in the
 * pure domain and their side effects behind adapters:
 *
 *  - **Create payout destination.** The pure `decidePayoutDestination` (task
 *    14.3 domain) validates the Indonesian bank code, account number, and holder
 *    name; the service then encrypts the raw account number with the shared
 *    AES-256-GCM envelope (the same cipher task 12.1 uses for SMS/OTP), stores
 *    only the ciphertext + key version + `accountNumberLast4`, and audits the
 *    change (requirements 14.7, 23.3). The full account number never leaves the
 *    trust boundary in the clear.
 *  - **Request payout.** The pure `decideRequestPayout` (task 5.6) selects whole
 *    available Earnings (no partial allocation on MVP), enforces the Rp1.000
 *    minimum, and builds the `payout-lock` ledger event. The service then, in ONE
 *    transaction, compare-and-set-locks each Earning `available → requested`,
 *    creates the `PartnerPayout` + `PayoutAllocation`s with an immutable encrypted
 *    destination snapshot, appends the zero-sum ledger event, records the initial
 *    transition, and writes the audit event (requirements 14.1, 14.2, 14.3,
 *    14.6). Exactly-once Earning locking is enforced by the CAS plus the unique
 *    `PayoutAllocation.earningId`, so parallel payouts can never pay the same
 *    Earning twice.
 *
 * The request repository, ledger repository (task 14.1), and Earning projection
 * repository (task 14.1) are all parameterized by the transaction handle `Tx` so
 * every write commits atomically on the caller's unit of work. Infrastructure
 * supplies the Prisma adapters; raw Prisma never leaves that layer.
 */
import type { AuditActorType, AuditEventDescriptor } from "@domain/task-5-7";
import type { PayoutAllocation, PayoutStatus } from "@domain/task-5-6";
import type { TenantContext } from "@infrastructure/database";

export type { AuditActorType };

/**
 * An AES-256-GCM envelope plus the numeric key version used to produce it. The
 * envelope layout is an infrastructure detail; callers treat `ciphertext` as
 * opaque bytes to persist and pass back to a decryptor with `keyVersion`.
 */
export interface EncryptedField {
  readonly ciphertext: Uint8Array;
  readonly keyVersion: number;
}

/**
 * The narrow cryptography seam the payout module needs: encrypt an account
 * number / destination snapshot into a versioned authenticated envelope, and
 * decrypt a stored destination envelope so a request can build its immutable
 * snapshot. Satisfied structurally by the shared SMS/OTP cipher (task 12.1), so
 * the payout key rotation follows the same additive scheme.
 */
export interface PayoutSecretCipher {
  /** The active key version stamped onto every ciphertext this cipher produces. */
  readonly keyVersion: number;
  /** Encrypt UTF-8 plaintext into a versioned authenticated envelope. */
  encrypt(plaintext: string): EncryptedField;
  /** Decrypt an envelope; returns `null` on tampering / truncation / key mismatch. */
  decrypt(input: {
    readonly ciphertext: Uint8Array;
    readonly keyVersion: number;
  }): Promise<string | null>;
}

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Generates opaque identifiers (UUIDs) for new rows. */
export interface IdGenerator {
  uuid(): string;
}

/** An audit event to persist alongside a payout mutation (requirement 14.7). */
export interface AuditWriteInput {
  readonly id: string;
  readonly partnerId: string;
  readonly requestId: string;
  readonly descriptor: AuditEventDescriptor;
}

// ---------------------------------------------------------------------------
// Payout destination management
// ---------------------------------------------------------------------------

/** A safe, tenant-scoped view of a `PayoutDestination` (never the ciphertext). */
export interface PayoutDestinationView {
  readonly id: string;
  readonly partnerId: string;
  readonly bankCode: string;
  readonly accountNumberLast4: string;
  readonly accountHolderName: string;
  readonly status: "active" | "disabled";
}

/** The row to insert when creating a payout destination. */
export interface NewPayoutDestination {
  readonly id: string;
  readonly bankCode: string;
  /** AES-256-GCM envelope of the raw account number (never the plaintext). */
  readonly accountNumberCiphertext: Uint8Array;
  readonly keyVersion: number;
  readonly accountNumberLast4: string;
  readonly accountHolderName: string;
  readonly createdAtEpochMs: number;
}

/**
 * Operations inside a tenant-scoped payout-destination transaction. Every
 * read/write is folded with the tenant's `partnerId` (task 7.1), so a
 * cross-tenant id is indistinguishable from a missing row.
 */
export interface PayoutDestinationTransaction {
  insertDestination(record: NewPayoutDestination): Promise<PayoutDestinationView>;
  recordAudit(input: AuditWriteInput): Promise<void>;
}

/**
 * Runs payout-destination work inside a single tenant-scoped transaction bound
 * to a validated {@link TenantContext} (task 7.1 unit of work).
 */
export interface PayoutDestinationGateway {
  runInTenant<T>(
    tenant: TenantContext,
    work: (tx: PayoutDestinationTransaction) => Promise<T>,
  ): Promise<T>;
}

// ---------------------------------------------------------------------------
// Payout request (atomic)
// ---------------------------------------------------------------------------

/**
 * Raised by the persistence adapter when an Earning is already allocated to
 * another payout (the unique `PayoutAllocation.earningId` slot is taken).
 * Declared here so the adapter can throw a layer-neutral error the service maps
 * to a stable conflict outcome without importing Prisma error types.
 */
export class EarningAlreadyAllocatedError extends Error {
  constructor(public readonly earningId: string) {
    super("Earning is already allocated to another payout");
    this.name = "EarningAlreadyAllocatedError";
  }
}

/** The stored destination record needed to snapshot a payout at request time. */
export interface PayoutDestinationRecord {
  readonly id: string;
  readonly partnerId: string;
  readonly bankCode: string;
  readonly accountNumberCiphertext: Uint8Array;
  readonly keyVersion: number;
  readonly accountNumberLast4: string;
  readonly accountHolderName: string;
  readonly status: "active" | "disabled";
}

/** A safe view of a created payout (never the encrypted snapshot bytes). */
export interface PayoutView {
  readonly id: string;
  readonly partnerId: string;
  readonly destinationId: string;
  readonly amountIdr: number;
  readonly status: "requested";
  readonly paymentMethod: "bank_transfer_manual";
  readonly requestedAtEpochMs: number;
  readonly allocations: readonly PayoutAllocation[];
}

/** The `PartnerPayout` row to insert when a request is created. */
export interface NewPartnerPayout {
  readonly id: string;
  readonly destinationId: string;
  /** AES-256-GCM envelope of the immutable destination snapshot JSON. */
  readonly destinationSnapshotJsonEncrypted: Uint8Array;
  readonly amountIdr: number;
  readonly createdByMemberId: string;
  readonly requestedAtEpochMs: number;
}

/** The initial `PayoutTransition` row (null → requested) recorded on request. */
export interface NewPayoutTransition {
  readonly id: string;
  readonly payoutId: string;
  readonly fromStatus: "requested" | null;
  readonly toStatus: "requested";
  readonly actorType: AuditActorType;
  /** Raw actor reference (member id); the adapter stores only its hash. */
  readonly actorRef: string;
  readonly reason: string | null;
  /** Deterministic operation key (`payout-request:{payoutId}`); unique. */
  readonly operationKey: string;
  readonly occurredAtEpochMs: number;
}

/**
 * Transactional persistence for a payout request, parameterized by the
 * transaction handle `Tx` so the payout row, its allocations, the initial
 * transition, and the audit event commit atomically with the Earning locks and
 * the ledger append (which reuse the task 14.1 repositories on the same `Tx`).
 * The destination read is tenant-scoped and runs before the transaction so the
 * snapshot can be built once. Raw Prisma never leaves the adapter.
 */
export interface PayoutRequestRepository<Tx> {
  /** Read the tenant's active payout destination, or `null` when absent/disabled. */
  findActiveDestination(
    partnerId: string,
    destinationId: string,
  ): Promise<PayoutDestinationRecord | null>;

  /** Insert the `PartnerPayout` (status requested, method bank_transfer_manual). */
  createPayout(tx: Tx, partnerId: string, input: NewPartnerPayout): Promise<void>;

  /**
   * Insert one `PayoutAllocation` per whole Earning. Throws
   * {@link EarningAlreadyAllocatedError} when the unique `earningId` slot is
   * already taken by another payout (exactly-once locking backstop).
   */
  createAllocations(
    tx: Tx,
    partnerId: string,
    payoutId: string,
    allocations: readonly PayoutAllocation[],
  ): Promise<void>;

  /** Record the initial payout transition (audit trail, requirement 14.7). */
  recordTransition(tx: Tx, partnerId: string, input: NewPayoutTransition): Promise<void>;

  /** Record the audit event for the request (requirement 14.7). */
  recordAudit(tx: Tx, input: AuditWriteInput): Promise<void>;
}

/**
 * Runs payout-request work inside a single database transaction, exposing the
 * transaction handle `Tx` so the ledger append and Earning locks (task 14.1
 * repositories) commit atomically with the payout rows. Structurally identical
 * to the Internal API idempotency runner; the tenant is folded into every
 * predicate by the repositories, so no tenant binding is required here.
 */
export interface PayoutTransactionRunner<Tx> {
  run<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}

/**
 * Reads the admin-editable minimum payout (whole IDR) from the active platform
 * config (requirement 8.5). Read fresh on every request, never cached in the
 * service, because a Partner Admin can publish a new config at any time (a new
 * active version is inserted; an existing row is never mutated in place), and
 * the portal already advertises this same figure as the enforced floor
 * (`OperationalQueryService.payouts.minimumPayoutIdr`). Returns `null` when no
 * active config exists so the request falls back to the domain minimum
 * (`PAYOUT_MINIMUM_IDR`) rather than letting a payout through with no floor.
 */
export interface PayoutMinimumReader {
  readMinimumPayoutIdr(): Promise<number | null>;
}

// ---------------------------------------------------------------------------
// Payout admin review + settlement (task 14.4)
// ---------------------------------------------------------------------------

/**
 * The payout view a Partner Admin loads before a review/settlement transition
 * (task 14.4). It carries only what the pure `decidePayoutTransition` (task 5.6)
 * needs — the current status, the locked amount, the current payment reference,
 * and the whole-Earning allocations whose projection must move with the payout.
 * The encrypted destination snapshot is never read here: settlement moves money
 * inside the ledger and does not need the raw bank details (requirement 16.7).
 */
export interface PayoutAdminRecord {
  readonly id: string;
  readonly partnerId: string;
  readonly status: PayoutStatus;
  readonly amountIdr: number;
  readonly paymentReference: string | null;
  readonly allocations: readonly PayoutAllocation[];
}

/**
 * A compare-and-set advance of a payout's status for an admin transition. The
 * write only succeeds when the row still holds `expectedStatus`, so a concurrent
 * or retried transition is detected rather than double-applied. `paymentReference`,
 * `paidAtEpochMs`, and `processedByAdminId` are stamped on the `paid` target
 * (requirement 14.4); `failureReason` is stamped on the `rejected`/`failed`
 * targets (requirement 14.5).
 */
export interface UpdatePayoutStatusInput {
  readonly payoutId: string;
  readonly partnerId: string;
  readonly expectedStatus: PayoutStatus;
  readonly nextStatus: PayoutStatus;
  readonly paymentReference?: string;
  readonly paidAtEpochMs?: number;
  readonly processedByAdminId?: string;
  readonly failureReason?: string;
}

/**
 * The result of a payout status CAS. `updated` when exactly one row moved;
 * `no_op` on a lost race (the status changed underneath us); `duplicate_reference`
 * when the unique `paymentReference` slot is already taken by another payout
 * (requirement 14.6), surfaced without leaking the conflicting payout.
 */
export type UpdatePayoutStatusResult =
  | { readonly outcome: "updated" }
  | { readonly outcome: "no_op" }
  | { readonly outcome: "duplicate_reference" };

/**
 * A `PayoutTransition` row recorded for every admin transition (audit trail,
 * requirement 14.7). Unlike the request transition, both `fromStatus` and
 * `toStatus` are arbitrary payout statuses. The deterministic, unique
 * `operationKey` (`payout-{command}:{payoutId}`) is a persistence backstop
 * against a duplicate transition row for the same command.
 */
export interface RecordPayoutTransitionInput {
  readonly id: string;
  readonly payoutId: string;
  readonly fromStatus: PayoutStatus;
  readonly toStatus: PayoutStatus;
  readonly actorType: AuditActorType;
  /** Raw actor reference (admin id); the adapter stores only its hash. */
  readonly actorRef: string;
  readonly reason: string | null;
  readonly operationKey: string;
  readonly occurredAtEpochMs: number;
}

/**
 * Transactional persistence for a payout admin review/settlement transition,
 * parameterized by the transaction handle `Tx` so the payout status CAS, the
 * `PayoutTransition`, and the audit event commit atomically with the Earning
 * projection moves and the ledger append (which reuse the task 14.1
 * repositories on the same `Tx`). The payout read is by id (the admin realm is
 * global, not tenant-scoped); every write folds in the payout's own trusted
 * `partnerId`. Raw Prisma never leaves the adapter.
 */
export interface PayoutAdminRepository<Tx> {
  /** Read the payout to review by id, or `null` when it does not exist. */
  findPayoutForReview(payoutId: string): Promise<PayoutAdminRecord | null>;

  /** Compare-and-set the payout status (and settlement fields). */
  updatePayoutStatus(
    tx: Tx,
    input: UpdatePayoutStatusInput,
  ): Promise<UpdatePayoutStatusResult>;

  /**
   * Release the payout's still-active allocations by stamping `releasedAt` on
   * them (idempotent: only rows still `releasedAt IS NULL` are touched). Called
   * on a `rejected`/`failed` transition AFTER the status CAS, so the guard
   * trigger permits the one-way release. Keeping the rows preserves the audit
   * trail while freeing each returned-to-available Earning from the partial
   * unique `earningId` index, so it can be requested in a fresh payout instead
   * of being permanently stranded.
   */
  releaseAllocations(
    tx: Tx,
    partnerId: string,
    payoutId: string,
    releasedAtEpochMs: number,
  ): Promise<void>;

  /** Record the payout transition (audit trail, requirement 14.7). */
  recordTransition(
    tx: Tx,
    partnerId: string,
    input: RecordPayoutTransitionInput,
  ): Promise<void>;

  /** Record the audit event for the transition (requirement 14.7). */
  recordAudit(tx: Tx, input: AuditWriteInput): Promise<void>;
}
