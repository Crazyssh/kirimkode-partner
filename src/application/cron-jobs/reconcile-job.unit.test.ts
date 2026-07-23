import { describe, expect, it } from "vitest";

import { RECONCILE_JOB, ReconcileJob } from "./reconcile-job";
import type {
  Clock,
  PartnerReconciliationState,
  PersistedFinding,
  ReconciliationGateway,
  ReconciliationRecordResult,
} from "./ports";

const NOW = 50_000_000;
const HEARTBEAT_TIMEOUT_SECONDS = 90;

class FixedClock implements Clock {
  nowEpochMs(): number {
    return NOW;
  }
}

/**
 * A page-able fake reconciliation gateway. It orders partners by id, honours
 * `afterId`/`limit`, and gives each partner a state carrying exactly one
 * invariant violation — a stale online device — so the job's pure detector
 * produces one finding per partner. Recorded issues are deduped by
 * `(partnerId, type, referenceId)` so a re-run reports duplicates, mirroring the
 * repository's open-issue dedupe (requirement 20.2).
 */
class FakeReconciliationGateway implements ReconciliationGateway {
  readonly listCalls: { limit: number; afterId: string | null }[] = [];
  readonly loadedPartners: string[] = [];
  readonly recorded = new Set<string>();
  readonly recordCalls: {
    partnerId: string;
    findings: readonly PersistedFinding[];
  }[] = [];

  constructor(
    private readonly partnerIds: readonly string[],
    private readonly heartbeatTimeoutSeconds: number | null = HEARTBEAT_TIMEOUT_SECONDS,
  ) {}

  async loadHeartbeatTimeoutSeconds(): Promise<number | null> {
    return this.heartbeatTimeoutSeconds;
  }

  async listPartnerIds(input: {
    limit: number;
    afterId: string | null;
  }): Promise<readonly string[]> {
    this.listCalls.push(input);
    const start =
      input.afterId === null
        ? 0
        : this.partnerIds.findIndex((id) => id === input.afterId) + 1;
    return this.partnerIds.slice(start, start + input.limit);
  }

  async loadPartnerState(partnerId: string): Promise<PartnerReconciliationState> {
    this.loadedPartners.push(partnerId);
    // One stale online device (last seen well beyond the timeout) → one finding.
    return {
      devices: [
        {
          id: `device-${partnerId}`,
          effectiveStatus: "online",
          lastSeenAtEpochMs: NOW - HEARTBEAT_TIMEOUT_SECONDS * 1000 - 60_000,
        },
      ],
    };
  }

  async recordIssues(input: {
    partnerId: string;
    findings: readonly PersistedFinding[];
  }): Promise<ReconciliationRecordResult> {
    this.recordCalls.push(input);
    let recorded = 0;
    let duplicates = 0;
    for (const finding of input.findings) {
      const key = `${input.partnerId}:${finding.type}:${finding.referenceId}`;
      if (this.recorded.has(key)) {
        duplicates += 1;
      } else {
        this.recorded.add(key);
        recorded += 1;
      }
    }
    return { recorded, duplicates };
  }
}

function makeJob(gateway: ReconciliationGateway, batchSize = 25): ReconcileJob {
  return new ReconcileJob({ gateway, clock: new FixedClock(), batchSize });
}

describe("ReconcileJob", () => {
  it("exposes the registry job name", () => {
    expect(RECONCILE_JOB).toBe("reconcile");
    expect(makeJob(new FakeReconciliationGateway([])).name).toBe("reconcile");
  });

  it("reconciles every partner in a bounded page and records one finding each", async () => {
    const gateway = new FakeReconciliationGateway(["p1", "p2", "p3"]);
    const result = await makeJob(gateway).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(gateway.loadedPartners).toEqual(["p1", "p2", "p3"]);
    expect(result.processed).toBe(3);
    expect(result.done).toBe(true);
    expect(result.nextCursor).toBeNull();

    // One stale-device finding recorded per partner, correctly classified.
    expect(gateway.recordCalls).toHaveLength(3);
    expect(gateway.recordCalls[0].findings).toEqual([
      {
        type: "stale_financial_state",
        referenceId: "device-p1",
        severity: "medium",
        detailsSafeJson: expect.objectContaining({ detector: "stale_online_device" }),
      },
    ]);
    expect(gateway.recorded.size).toBe(3);
  });

  it("queries partners with the batch cursor and limit", async () => {
    const gateway = new FakeReconciliationGateway(["p1"]);
    await makeJob(gateway, 10).runBatch({ cursor: null, nowEpochMs: NOW });
    expect(gateway.listCalls).toEqual([{ limit: 10, afterId: null }]);
  });

  it("reports a full page as not drained and carries a partner-id cursor", async () => {
    const gateway = new FakeReconciliationGateway(["p1", "p2", "p3"]);
    const result = await makeJob(gateway, 2).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(gateway.loadedPartners).toEqual(["p1", "p2"]);
    expect(result.done).toBe(false);
    expect(result.nextCursor).toEqual({ afterId: "p2" });
  });

  it("resumes after the cursor partner id", async () => {
    const gateway = new FakeReconciliationGateway(["p1", "p2", "p3"]);
    const result = await makeJob(gateway, 2).runBatch({
      cursor: { afterId: "p2" },
      nowEpochMs: NOW,
    });

    expect(gateway.loadedPartners).toEqual(["p3"]);
    expect(result.done).toBe(true);
    expect(result.nextCursor).toBeNull();
  });

  it("does nothing when there are no partners", async () => {
    const gateway = new FakeReconciliationGateway([]);
    const result = await makeJob(gateway).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(gateway.loadedPartners).toEqual([]);
    expect(result.processed).toBe(0);
    expect(result.done).toBe(true);
    expect(gateway.recordCalls).toHaveLength(0);
  });

  it("is idempotent across re-runs: a second sweep records only duplicates", async () => {
    const gateway = new FakeReconciliationGateway(["p1", "p2"]);
    const first = await makeJob(gateway).runBatch({ cursor: null, nowEpochMs: NOW });
    const second = await makeJob(gateway).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(first.processed).toBe(2);
    expect(second.processed).toBe(2);
    // The dedupe set never grows beyond the two distinct findings.
    expect(gateway.recorded.size).toBe(2);
  });

  it("falls back to the default heartbeat timeout when config is unset", async () => {
    // A null config must not throw; the job uses the MVP default window.
    const gateway = new FakeReconciliationGateway(["p1"], null);
    const result = await makeJob(gateway).runBatch({ cursor: null, nowEpochMs: NOW });
    expect(result.processed).toBe(1);
    expect(gateway.recordCalls[0].findings[0].type).toBe("stale_financial_state");
  });
});
