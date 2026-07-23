import { describe, expect, it } from "vitest";

import { CronBatchRunner, type BatchJob, type BatchStepResult } from "./cron-batch-runner";
import { decideLeaseTakeover } from "@domain/task-16-1/cron-jobs";
import type {
  AcquireLeaseInput,
  AcquiredLease,
  Clock,
  JobCursor,
  JobLeaseRepository,
  ReleaseLeaseInput,
  RenewLeaseInput,
} from "./ports";

/** A hand-advanced clock. */
class TestClock implements Clock {
  private now: number;
  constructor(start = 1_000) {
    this.now = start;
  }
  nowEpochMs(): number {
    return this.now;
  }
  advance(ms: number): void {
    this.now += ms;
  }
}

interface StoredLease {
  ownerId: string;
  leaseUntilEpochMs: number;
  cursor: JobCursor;
}

/**
 * In-memory `JobLeaseRepository` that mirrors the atomic conditional semantics
 * of the Prisma adapter using the pure {@link decideLeaseTakeover} decision, so
 * the runner's lease lifecycle can be exercised deterministically.
 */
class InMemoryJobLeaseRepository implements JobLeaseRepository {
  private readonly leases = new Map<string, StoredLease>();
  constructor(private readonly clock: Clock) {}

  seed(name: string, lease: StoredLease): void {
    this.leases.set(name, lease);
  }

  peek(name: string): StoredLease | undefined {
    return this.leases.get(name);
  }

  async acquire(input: AcquireLeaseInput): Promise<AcquiredLease | null> {
    const existing = this.leases.get(input.name) ?? null;
    const canTake = decideLeaseTakeover({
      existing: existing === null
        ? null
        : { ownerId: existing.ownerId, leaseUntilEpochMs: existing.leaseUntilEpochMs },
      requestingOwnerId: input.ownerId,
      nowEpochMs: input.nowEpochMs,
    });
    if (!canTake) return null;

    // Takeover preserves the prior cursor; a fresh insert starts at null.
    const cursor = existing?.cursor ?? null;
    const stored: StoredLease = {
      ownerId: input.ownerId,
      leaseUntilEpochMs: input.leaseUntilEpochMs,
      cursor,
    };
    this.leases.set(input.name, stored);
    return Object.freeze({
      name: input.name,
      ownerId: input.ownerId,
      leaseUntilEpochMs: input.leaseUntilEpochMs,
      cursor,
    });
  }

  async renew(input: RenewLeaseInput): Promise<boolean> {
    const existing = this.leases.get(input.name);
    const now = this.clock.nowEpochMs();
    if (
      existing === undefined ||
      existing.ownerId !== input.ownerId ||
      existing.leaseUntilEpochMs <= now
    ) {
      return false;
    }
    existing.leaseUntilEpochMs = input.leaseUntilEpochMs;
    if ("cursor" in input) {
      existing.cursor = input.cursor ?? null;
    }
    return true;
  }

  async release(input: ReleaseLeaseInput): Promise<void> {
    const existing = this.leases.get(input.name);
    if (existing !== undefined && existing.ownerId === input.ownerId) {
      existing.leaseUntilEpochMs = 0;
    }
  }
}

function countingJob(
  name: string,
  batches: BatchStepResult[],
  onBatch?: (index: number) => void,
): BatchJob {
  let index = 0;
  return {
    name,
    maxBatchesPerRun: batches.length,
    async runBatch(): Promise<BatchStepResult> {
      const result = batches[index] ?? { processed: 0, nextCursor: null, done: true };
      onBatch?.(index);
      index += 1;
      return result;
    },
  };
}

describe("CronBatchRunner", () => {
  it("acquires, drains one batch, advances the cursor, and releases", async () => {
    const clock = new TestClock();
    const repo = new InMemoryJobLeaseRepository(clock);
    const runner = new CronBatchRunner({
      leases: repo,
      clock,
      ownerIdFactory: () => "owner-1",
      leaseDurationMs: 55_000,
    });

    const job = countingJob("offline-sweep", [
      { processed: 3, nextCursor: { at: "device-3" }, done: true },
    ]);

    const result = await runner.run(job);

    expect(result).toEqual({
      status: "completed",
      batches: 1,
      processed: 3,
      drained: true,
      leaseLost: false,
    });
    // Cursor was persisted and the lease was released (expired) at the end.
    const lease = repo.peek("offline-sweep");
    expect(lease?.cursor).toEqual({ at: "device-3" });
    expect(lease?.leaseUntilEpochMs).toBe(0);
  });

  it("skips when another live worker holds the lease", async () => {
    const clock = new TestClock();
    const repo = new InMemoryJobLeaseRepository(clock);
    repo.seed("reconcile", {
      ownerId: "other-worker",
      leaseUntilEpochMs: clock.nowEpochMs() + 30_000,
      cursor: null,
    });
    const runner = new CronBatchRunner({
      leases: repo,
      clock,
      ownerIdFactory: () => "owner-1",
    });

    let ran = false;
    const job: BatchJob = {
      name: "reconcile",
      async runBatch() {
        ran = true;
        return { processed: 0, nextCursor: null, done: true };
      },
    };

    const result = await runner.run(job);
    expect(result).toEqual({ status: "skipped_locked" });
    expect(ran).toBe(false);
  });

  it("takes over an expired lease and resumes from the persisted cursor", async () => {
    const clock = new TestClock();
    const repo = new InMemoryJobLeaseRepository(clock);
    repo.seed("earning-release", {
      ownerId: "crashed-worker",
      leaseUntilEpochMs: clock.nowEpochMs() - 1, // already expired
      cursor: { at: "earning-42" },
    });
    const runner = new CronBatchRunner({
      leases: repo,
      clock,
      ownerIdFactory: () => "owner-2",
    });

    let seenCursor: JobCursor = "unset";
    const job: BatchJob = {
      name: "earning-release",
      async runBatch(ctx) {
        seenCursor = ctx.cursor;
        return { processed: 1, nextCursor: { at: "earning-43" }, done: true };
      },
    };

    const result = await runner.run(job);
    expect(result.status).toBe("completed");
    // Resumed from the crashed worker's cursor rather than restarting.
    expect(seenCursor).toEqual({ at: "earning-42" });
  });

  it("runs multiple bounded batches until the backlog drains", async () => {
    const clock = new TestClock();
    const repo = new InMemoryJobLeaseRepository(clock);
    const runner = new CronBatchRunner({
      leases: repo,
      clock,
      ownerIdFactory: () => "owner-3",
    });

    const job = countingJob("retention-redaction", [
      { processed: 2, nextCursor: { page: 1 }, done: false },
      { processed: 2, nextCursor: { page: 2 }, done: false },
      { processed: 1, nextCursor: { page: 3 }, done: true },
    ]);

    const result = await runner.run(job);
    expect(result).toEqual({
      status: "completed",
      batches: 3,
      processed: 5,
      drained: true,
      leaseLost: false,
    });
  });

  it("stops when the lease is lost mid-run (another worker took over)", async () => {
    const clock = new TestClock();
    const repo = new InMemoryJobLeaseRepository(clock);
    const runner = new CronBatchRunner({
      leases: repo,
      clock,
      ownerIdFactory: () => "owner-4",
      leaseDurationMs: 10_000,
    });

    // After the first batch, simulate a takeover by another worker so our
    // renewal fails and the runner must stop rather than race.
    const job = countingJob(
      "order-timeout",
      [
        { processed: 2, nextCursor: { page: 1 }, done: false },
        { processed: 2, nextCursor: { page: 2 }, done: false },
      ],
      (index) => {
        if (index === 0) {
          repo.seed("order-timeout", {
            ownerId: "usurper",
            leaseUntilEpochMs: clock.nowEpochMs() + 10_000,
            cursor: { page: 1 },
          });
        }
      },
    );

    const result = await runner.run(job);
    expect(result).toMatchObject({ status: "completed", batches: 1, leaseLost: true });
  });
});
