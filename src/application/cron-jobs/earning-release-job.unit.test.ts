import { describe, expect, it } from "vitest";

import type { ReleaseHoldInput, ReleaseHoldResult } from "@application/ledger";

import {
  EARNING_RELEASE_JOB,
  EarningReleaseJob,
  type EarningReleaseCommand,
} from "./earning-release-job";
import type { Clock, EarningReleaseGateway, ReleasableEarningRow } from "./ports";

const NOW = 30_000_000;

class FixedClock implements Clock {
  nowEpochMs(): number {
    return NOW;
  }
}

/** A page-able fake gateway ordered by earningId, honouring `afterId`/`limit`. */
class FakeEarningReleaseGateway implements EarningReleaseGateway {
  lastInput: { nowEpochMs: number; limit: number; afterId: string | null } | null =
    null;

  constructor(private readonly rows: readonly ReleasableEarningRow[]) {}

  async listReleasableEarnings(input: {
    nowEpochMs: number;
    limit: number;
    afterId: string | null;
  }): Promise<readonly ReleasableEarningRow[]> {
    this.lastInput = input;
    const start =
      input.afterId === null
        ? 0
        : this.rows.findIndex((r) => r.earningId === input.afterId) + 1;
    return this.rows.slice(start, start + input.limit);
  }
}

/** Records every hold-release call; returns a configurable outcome. */
class RecordingReleaseCommand implements EarningReleaseCommand {
  readonly calls: ReleaseHoldInput[] = [];

  constructor(
    private readonly outcome: (input: ReleaseHoldInput) => ReleaseHoldResult = (
      input,
    ) => ({ kind: "released", earningId: input.earningId }),
  ) {}

  async releaseHold(input: ReleaseHoldInput): Promise<ReleaseHoldResult> {
    this.calls.push(input);
    return this.outcome(input);
  }
}

function rows(...ids: string[]): ReleasableEarningRow[] {
  return ids.map((id) => ({ earningId: id, partnerId: `p-${id}` }));
}

function makeJob(
  gatewayRows: readonly ReleasableEarningRow[],
  command: EarningReleaseCommand,
  batchSize = 100,
): EarningReleaseJob {
  return new EarningReleaseJob({
    gateway: new FakeEarningReleaseGateway(gatewayRows),
    command,
    clock: new FixedClock(),
    batchSize,
  });
}

describe("EarningReleaseJob", () => {
  it("exposes the registry job name", () => {
    expect(EARNING_RELEASE_JOB).toBe("earning-release");
    expect(makeJob(rows(), new RecordingReleaseCommand()).name).toBe(
      "earning-release",
    );
  });

  it("drives each releasable earning through the shared hold-release command", async () => {
    const command = new RecordingReleaseCommand();
    const result = await makeJob(rows("e1", "e2", "e3"), command).runBatch({
      cursor: null,
      nowEpochMs: NOW,
    });

    expect(command.calls).toEqual([
      { partnerId: "p-e1", earningId: "e1" },
      { partnerId: "p-e2", earningId: "e2" },
      { partnerId: "p-e3", earningId: "e3" },
    ]);
    expect(result.processed).toBe(3);
    expect(result.done).toBe(true);
    expect(result.nextCursor).toBeNull();
  });

  it("queries the gateway with the batch clock and cursor", async () => {
    const gateway = new FakeEarningReleaseGateway(rows("e1"));
    const job = new EarningReleaseJob({
      gateway,
      command: new RecordingReleaseCommand(),
      clock: new FixedClock(),
      batchSize: 50,
    });

    await job.runBatch({ cursor: null, nowEpochMs: NOW });

    expect(gateway.lastInput).toEqual({ nowEpochMs: NOW, limit: 50, afterId: null });
  });

  it("reports a full batch as not drained and carries an id cursor", async () => {
    const command = new RecordingReleaseCommand();
    const result = await makeJob(rows("e1", "e2", "e3"), command, 2).runBatch({
      cursor: null,
      nowEpochMs: NOW,
    });

    expect(command.calls.map((c) => c.earningId)).toEqual(["e1", "e2"]);
    expect(result.done).toBe(false);
    expect(result.nextCursor).toEqual({ afterId: "e2" });
  });

  it("resumes after the cursor id", async () => {
    const command = new RecordingReleaseCommand();
    const result = await makeJob(rows("e1", "e2", "e3"), command, 2).runBatch({
      cursor: { afterId: "e2" },
      nowEpochMs: NOW,
    });

    expect(command.calls.map((c) => c.earningId)).toEqual(["e3"]);
    expect(result.done).toBe(true);
    expect(result.nextCursor).toBeNull();
  });

  it("does nothing when there is no releasable backlog", async () => {
    const command = new RecordingReleaseCommand();
    const result = await makeJob(rows(), command).runBatch({
      cursor: null,
      nowEpochMs: NOW,
    });

    expect(command.calls).toHaveLength(0);
    expect(result.processed).toBe(0);
    expect(result.done).toBe(true);
  });

  it("treats an idempotent no-op outcome as processed (crash-safe re-run)", async () => {
    // A re-run after a crash finds an earning already `available`; the command
    // reports it and the job still advances the cursor past it.
    const command = new RecordingReleaseCommand((input) => ({
      kind: "already_available",
      earningId: input.earningId,
    }));
    const result = await makeJob(rows("e1", "e2"), command).runBatch({
      cursor: null,
      nowEpochMs: NOW,
    });

    expect(command.calls).toHaveLength(2);
    expect(result.processed).toBe(2);
    expect(result.done).toBe(true);
  });
});
