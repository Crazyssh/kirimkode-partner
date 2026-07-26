/**
 * Cron liveness application service + port (requirement 20.3).
 *
 * Nothing on the platform notices today when the external scheduler that drives
 * `POST /api/cron/v1?job=<name>` dies, and the failures are silent: earnings
 * never become withdrawable, held numbers are never returned to sale, expired
 * orders are never refunded. This service is the read-only signal that closes
 * that gap.
 *
 * It owns no rule. The staleness decision is the pure
 * {@link evaluateCronLiveness} domain function; this service only samples the
 * clock, asks the {@link CronLastSeenReader} port for each job's last-seen
 * instant, and formats the verdict for transport. Structurally it mirrors
 * {@link import("./partner-health-service").PartnerHealthService}: an injected
 * version, an injected probe/port, and an injected clock, so it unit-tests
 * against a fake port with no database.
 *
 * A failure to read the lease store is reported as `degraded` with an empty job
 * list rather than throwing — an operator polling this endpoint should learn that
 * the signal itself is unavailable, and the route must never leak the underlying
 * driver error.
 */
import {
  evaluateCronLiveness,
  type CronJobLiveness,
  type CronLivenessReport,
} from "@domain/task-16-5";

/** A single job's last-seen observation as read from the lease store. */
export interface CronJobLastSeenRow {
  readonly job: string;
  /** Epoch-ms a runner last touched this job's lease. */
  readonly lastSeenAtEpochMs: number;
}

/** The lease-store snapshot the signal is derived from. */
export interface CronLastSeenSnapshot {
  /** One row per persisted lease. */
  readonly jobs: readonly CronJobLastSeenRow[];
  /**
   * Epoch-ms of the oldest lease row, i.e. since when cron has demonstrably
   * been dispatching. `null` on a cold store with no leases at all, in which
   * case the service falls back to its own start instant so a never-wired
   * scheduler is still eventually reported.
   */
  readonly oldestLeaseCreatedAtEpochMs: number | null;
}

/**
 * Port over the persisted job leases. The Prisma adapter reads `job_leases`;
 * raw Prisma never crosses this seam.
 */
export interface CronLastSeenReader {
  readLastSeen(): Promise<CronLastSeenSnapshot>;
}

/** Source of the current time; injected so tests can use a fake clock. */
export type Clock = () => Date;

/** The transport-facing snapshot: the domain report plus service metadata. */
export interface CronLivenessSnapshot {
  readonly status: CronLivenessReport["status"];
  readonly version: string;
  /** ISO-8601 observation instant. */
  readonly time: string;
  readonly jobs: readonly CronJobLiveness[];
  readonly staleJobs: readonly string[];
}

export interface CronLivenessServiceDeps {
  readonly version: string;
  readonly reader: CronLastSeenReader;
  readonly clock?: Clock;
  /**
   * Instant this service (hence this deployment) started, used as the first-run
   * grace anchor when the lease store is still empty. Defaults to construction
   * time, which for the composition-root singleton is process start.
   */
  readonly startedAtEpochMs?: number;
}

export class CronLivenessService {
  private readonly version: string;
  private readonly reader: CronLastSeenReader;
  private readonly clock: Clock;
  private readonly startedAtEpochMs: number;

  constructor(deps: CronLivenessServiceDeps) {
    this.version = deps.version;
    this.reader = deps.reader;
    this.clock = deps.clock ?? (() => new Date());
    this.startedAtEpochMs = deps.startedAtEpochMs ?? this.clock().getTime();
  }

  async liveness(): Promise<CronLivenessSnapshot> {
    const observedAt = this.clock();

    let snapshot: CronLastSeenSnapshot;
    try {
      snapshot = await this.reader.readLastSeen();
    } catch {
      // The signal itself is unavailable. Report degraded without detail; the
      // underlying driver error never reaches the caller (requirement 20.4).
      return Object.freeze({
        status: "degraded" as const,
        version: this.version,
        time: observedAt.toISOString(),
        jobs: Object.freeze([]),
        staleJobs: Object.freeze([]),
      });
    }

    const report = evaluateCronLiveness({
      lastSeen: snapshot.jobs.map((row) => ({
        job: row.job,
        lastSeenAtEpochMs: row.lastSeenAtEpochMs,
      })),
      nowEpochMs: observedAt.getTime(),
      // Prefer the oldest lease row: it survives redeploys, so a long-running
      // platform does not reset its never-run grace window on every deploy.
      // Only a cold store falls back to this deployment's start instant.
      cronActiveSinceEpochMs:
        snapshot.oldestLeaseCreatedAtEpochMs ?? this.startedAtEpochMs,
    });

    return Object.freeze({
      status: report.status,
      version: this.version,
      time: observedAt.toISOString(),
      jobs: report.jobs,
      staleJobs: report.staleJobs,
    });
  }
}
