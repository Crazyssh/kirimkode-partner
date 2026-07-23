/**
 * Application-owned ports for the cron/job foundation (task 16.1).
 *
 * The cron endpoint authenticator, the {@link JobLeaseRepository}, and the
 * batch runner orchestrate the pure task 16.1 lease/operation-key domain over
 * these seams. Infrastructure supplies the adapters: a node constant-time
 * secret comparer, the Prisma-backed `JobLease` gateway (atomic acquire via
 * conditional update), and the system clock. Keeping the seams here lets the
 * runner and authenticator be unit-tested with in-memory fakes and keeps raw
 * Prisma and node crypto out of the transport layer.
 */
import type { JsonValue } from "@domain/task-5-3/canonical-request-hash";

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/**
 * Constant-time secret comparison. The adapter compares the presented cron
 * bearer secret against the configured secret without leaking timing that
 * could distinguish a wrong-length secret from a wrong-byte one. Returns `true`
 * only on an exact match.
 */
export interface SecretComparer {
  equals(presented: string, expected: string): boolean;
}

/** A cursor value persisted between batches. `null` means "start from the top". */
export type JobCursor = JsonValue | null;

/** A lease successfully acquired by a worker. */
export interface AcquiredLease {
  /** The job name (the lease's unique key). */
  readonly name: string;
  /** The owner id now recorded on the lease. */
  readonly ownerId: string;
  /** Epoch-ms instant the acquired lease expires. */
  readonly leaseUntilEpochMs: number;
  /** The resumable cursor carried over from a prior run, or `null`. */
  readonly cursor: JobCursor;
}

/** Inputs to an atomic lease acquire/takeover. */
export interface AcquireLeaseInput {
  readonly name: string;
  readonly ownerId: string;
  /** Fresh expiry stamp for the acquired lease (epoch-ms). */
  readonly leaseUntilEpochMs: number;
  /** Current server time (epoch-ms); an existing lease at/after this is expired. */
  readonly nowEpochMs: number;
}

/** Inputs to a lease renewal (heartbeat) that optionally advances the cursor. */
export interface RenewLeaseInput {
  readonly name: string;
  readonly ownerId: string;
  /** New expiry stamp (epoch-ms). */
  readonly leaseUntilEpochMs: number;
  /**
   * When present, the cursor is written durably in the same statement so a
   * crash after this point resumes from the advanced position. Omit the field
   * to renew the expiry without touching the cursor.
   */
  readonly cursor?: JobCursor;
}

/** Inputs to a lease release. */
export interface ReleaseLeaseInput {
  readonly name: string;
  readonly ownerId: string;
}

/**
 * Durable, single-holder job lease with a resumable cursor.
 *
 * Every method is a single atomic, conditional statement so concurrent workers
 * and crash/restart cycles stay safe (requirements 20.1, 20.2, 20.5):
 *
 *  - `acquire` inserts the lease or takes it over only when it is absent,
 *    already owned by the requester, or expired — otherwise it returns `null`.
 *    A takeover preserves the existing cursor so work resumes where it stopped.
 *  - `renew` extends the expiry (and optionally advances the cursor) *only*
 *    while the caller still owns an unexpired lease; it returns `false` when the
 *    lease was lost (expired and taken over), telling the runner to stop.
 *  - `release` expires the lease immediately, but only if the caller still owns
 *    it, so a worker never releases a lease another worker has taken over.
 *
 * The lease is a platform-global row (not tenant-scoped), so the adapter binds
 * to the raw executor rather than a `TenantContext`; raw Prisma never leaves it.
 */
export interface JobLeaseRepository {
  acquire(input: AcquireLeaseInput): Promise<AcquiredLease | null>;
  renew(input: RenewLeaseInput): Promise<boolean>;
  release(input: ReleaseLeaseInput): Promise<void>;
}
