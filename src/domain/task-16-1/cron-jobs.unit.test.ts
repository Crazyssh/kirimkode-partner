import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  buildJobOperationKey,
  decideLeaseTakeover,
  nextLeaseUntilEpochMs,
  type JobLeaseSnapshot,
} from "./cron-jobs";

describe("decideLeaseTakeover", () => {
  it("acquires when no lease exists", () => {
    expect(
      decideLeaseTakeover({ existing: null, requestingOwnerId: "worker-a", nowEpochMs: 1_000 }),
    ).toBe(true);
  });

  it("re-acquires a lease already owned by the requester", () => {
    const existing: JobLeaseSnapshot = { ownerId: "worker-a", leaseUntilEpochMs: 10_000 };
    expect(
      decideLeaseTakeover({ existing, requestingOwnerId: "worker-a", nowEpochMs: 1_000 }),
    ).toBe(true);
  });

  it("blocks a live lease held by another owner", () => {
    const existing: JobLeaseSnapshot = { ownerId: "worker-a", leaseUntilEpochMs: 10_000 };
    expect(
      decideLeaseTakeover({ existing, requestingOwnerId: "worker-b", nowEpochMs: 9_999 }),
    ).toBe(false);
  });

  it("takes over another owner's lease at and after expiry", () => {
    const existing: JobLeaseSnapshot = { ownerId: "worker-a", leaseUntilEpochMs: 10_000 };
    expect(
      decideLeaseTakeover({ existing, requestingOwnerId: "worker-b", nowEpochMs: 10_000 }),
    ).toBe(true);
    expect(
      decideLeaseTakeover({ existing, requestingOwnerId: "worker-b", nowEpochMs: 10_001 }),
    ).toBe(true);
  });

  it("never lets two distinct owners both hold a live lease", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.integer(),
        fc.integer({ min: 1 }),
        (ownerA, ownerB, now, remaining) => {
          fc.pre(ownerA !== ownerB);
          const existing: JobLeaseSnapshot = {
            ownerId: ownerA,
            leaseUntilEpochMs: now + remaining, // strictly in the future
          };
          // The holder can always renew; a different owner is always blocked.
          expect(
            decideLeaseTakeover({ existing, requestingOwnerId: ownerA, nowEpochMs: now }),
          ).toBe(true);
          expect(
            decideLeaseTakeover({ existing, requestingOwnerId: ownerB, nowEpochMs: now }),
          ).toBe(false);
        },
      ),
    );
  });
});

describe("nextLeaseUntilEpochMs", () => {
  it("adds the duration to now", () => {
    expect(nextLeaseUntilEpochMs(1_000, 55_000)).toBe(56_000);
  });

  it("rejects a non-positive or non-finite duration", () => {
    expect(() => nextLeaseUntilEpochMs(1_000, 0)).toThrow(RangeError);
    expect(() => nextLeaseUntilEpochMs(1_000, -1)).toThrow(RangeError);
    expect(() => nextLeaseUntilEpochMs(1_000, Number.NaN)).toThrow(RangeError);
  });
});

describe("buildJobOperationKey", () => {
  it("is deterministic for the same inputs", () => {
    expect(buildJobOperationKey("offline-sweep", "device-1")).toBe(
      buildJobOperationKey("offline-sweep", "device-1"),
    );
  });

  it("rejects empty inputs", () => {
    expect(() => buildJobOperationKey("", "x")).toThrow(RangeError);
    expect(() => buildJobOperationKey("job", "")).toThrow(RangeError);
  });

  it("never collides across distinct (jobName, itemKey) pairs", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (jobA, itemA, jobB, itemB) => {
          fc.pre(jobA !== jobB || itemA !== itemB);
          expect(buildJobOperationKey(jobA, itemA)).not.toBe(
            buildJobOperationKey(jobB, itemB),
          );
        },
      ),
    );
  });
});
