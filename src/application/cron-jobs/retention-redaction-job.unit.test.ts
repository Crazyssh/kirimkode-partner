import { describe, expect, it } from "vitest";

import { DEFAULT_RETENTION_CONFIG } from "@domain/task-5-7";

import {
  RETENTION_REDACTION_JOB,
  RetentionRedactionJob,
} from "./retention-redaction-job";
import { RETENTION_PASS_CATEGORIES } from "./ports";
import type {
  Clock,
  RetentionBatchInput,
  RetentionBatchResult,
  RetentionConfig,
  RetentionGateway,
} from "./ports";

const NOW = 1_000_000_000;

class FixedClock implements Clock {
  nowEpochMs(): number {
    return NOW;
  }
}

interface PassCall {
  readonly category: string;
  readonly input: RetentionBatchInput;
}

/**
 * Fake retention gateway that records every pass call and returns a scripted
 * result per category. Categories with no script drain immediately.
 */
class FakeRetentionGateway implements RetentionGateway {
  readonly calls: PassCall[] = [];

  constructor(
    private readonly scripts: Partial<
      Record<string, (input: RetentionBatchInput) => RetentionBatchResult>
    > = {},
    private readonly config: RetentionConfig | null = null,
  ) {}

  async loadRetentionConfig(): Promise<RetentionConfig | null> {
    return this.config;
  }

  private run(
    category: string,
    input: RetentionBatchInput,
  ): Promise<RetentionBatchResult> {
    this.calls.push({ category, input });
    const scripted = this.scripts[category];
    return Promise.resolve(
      scripted?.(input) ?? { processed: 0, lastId: null, drained: true },
    );
  }

  redactRawSms(input: RetentionBatchInput): Promise<RetentionBatchResult> {
    return this.run("sms_raw", input);
  }
  redactOtp(input: RetentionBatchInput): Promise<RetentionBatchResult> {
    return this.run("otp", input);
  }
  pruneHeartbeatMetadata(
    input: RetentionBatchInput,
  ): Promise<RetentionBatchResult> {
    return this.run("heartbeat_metadata", input);
  }
  pruneSecurityEvents(
    input: RetentionBatchInput,
  ): Promise<RetentionBatchResult> {
    return this.run("security_log", input);
  }
}

function makeJob(gateway: RetentionGateway, batchSize = 200): RetentionRedactionJob {
  return new RetentionRedactionJob({
    gateway,
    clock: new FixedClock(),
    batchSize,
  });
}

describe("RetentionRedactionJob", () => {
  it("exposes the registry job name", () => {
    expect(RETENTION_REDACTION_JOB).toBe("retention-redaction");
    expect(makeJob(new FakeRetentionGateway()).name).toBe("retention-redaction");
  });

  it("never processes protected financial/audit categories", () => {
    // The pass list must exclude the protected evidence tables so retention can
    // never destroy required financial/audit records (requirement 19.5).
    expect([...RETENTION_PASS_CATEGORIES]).toEqual([
      "sms_raw",
      "otp",
      "heartbeat_metadata",
      "security_log",
    ]);
    for (const protectedCategory of ["audit", "ledger", "payout"]) {
      expect([...RETENTION_PASS_CATEGORIES]).not.toContain(protectedCategory);
    }
  });

  it("processes the first category from a null cursor and advances to the next", async () => {
    const gateway = new FakeRetentionGateway();
    const result = await makeJob(gateway).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(gateway.calls[0]?.category).toBe("sms_raw");
    expect(result.done).toBe(false);
    expect(result.nextCursor).toEqual({ category: "otp", afterId: null });
  });

  it("computes the window boundary from the domain config (now - window)", async () => {
    const gateway = new FakeRetentionGateway();
    await makeJob(gateway).runBatch({ cursor: null, nowEpochMs: NOW });

    // Default sms_raw retention is 7 days; boundary is now - window.
    expect(gateway.calls[0]?.input.olderThanEpochMs).toBe(
      NOW - DEFAULT_RETENTION_CONFIG.smsRawMs,
    );
    expect(gateway.calls[0]?.input.nowEpochMs).toBe(NOW);
  });

  it("stays on a category that has not drained, resuming after its last id", async () => {
    const gateway = new FakeRetentionGateway({
      sms_raw: () => ({ processed: 200, lastId: "sms-200", drained: false }),
    });
    const result = await makeJob(gateway, 200).runBatch({
      cursor: null,
      nowEpochMs: NOW,
    });

    expect(result.processed).toBe(200);
    expect(result.done).toBe(false);
    expect(result.nextCursor).toEqual({ category: "sms_raw", afterId: "sms-200" });
  });

  it("resumes mid-category from a persisted { category, afterId } cursor", async () => {
    const gateway = new FakeRetentionGateway();
    await makeJob(gateway).runBatch({
      cursor: { category: "heartbeat_metadata", afterId: "hb-9" },
      nowEpochMs: NOW,
    });

    expect(gateway.calls[0]?.category).toBe("heartbeat_metadata");
    expect(gateway.calls[0]?.input.afterId).toBe("hb-9");
  });

  it("reports done and resets the cursor once the last category drains", async () => {
    const gateway = new FakeRetentionGateway();
    const result = await makeJob(gateway).runBatch({
      cursor: { category: "security_log", afterId: null },
      nowEpochMs: NOW,
    });

    expect(gateway.calls[0]?.category).toBe("security_log");
    expect(result.done).toBe(true);
    expect(result.nextCursor).toBeNull();
  });

  it("falls back to a fresh sweep when the cursor shape is unrecognised", async () => {
    const gateway = new FakeRetentionGateway();
    await makeJob(gateway).runBatch({
      cursor: { category: "not-a-category", afterId: "x" },
      nowEpochMs: NOW,
    });

    expect(gateway.calls[0]?.category).toBe("sms_raw");
  });
});
