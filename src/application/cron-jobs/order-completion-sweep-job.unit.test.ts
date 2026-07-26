import { describe, expect, it } from "vitest";

import { buildJobOperationKey } from "@domain/task-16-1/cron-jobs";
import type { CompleteCommandInput, CompleteResult } from "@application/orders";

import {
  ORDER_COMPLETION_SWEEP_JOB,
  OrderCompletionSweepJob,
  type OrderCompletionSweepCommand,
  type OrderCompletionSweepGateway,
} from "./order-completion-sweep-job";
import type { Clock } from "./ports";

const NOW = 20_000_000;

class FixedClock implements Clock {
  nowEpochMs(): number {
    return NOW;
  }
}

class FakeOrderCompletionSweepGateway implements OrderCompletionSweepGateway {
  constructor(private readonly ids: string[]) {}
  lastInput: { nowEpochMs: number; limit: number; afterId: string | null } | null = null;

  async listExpiredListeningOrderIds(input: {
    nowEpochMs: number;
    limit: number;
    afterId: string | null;
  }): Promise<readonly string[]> {
    this.lastInput = input;
    const start = input.afterId === null ? 0 : this.ids.indexOf(input.afterId) + 1;
    return this.ids.slice(start, start + input.limit);
  }
}

class RecordingCompleteCommand implements OrderCompletionSweepCommand {
  readonly calls: CompleteCommandInput[] = [];
  async complete(input: CompleteCommandInput): Promise<CompleteResult> {
    this.calls.push(input);
    return { statusCode: 200, body: { data: {
      partnerOrderId: input.orderId,
      status: "success",
      completedAt: new Date(input.observedAtEpochMs ?? NOW).toISOString(),
      releaseDisposition: "available",
    } } };
  }
}

function makeJob(
  ids: string[],
  command: OrderCompletionSweepCommand,
  batchSize = 100,
): OrderCompletionSweepJob {
  return new OrderCompletionSweepJob({
    gateway: new FakeOrderCompletionSweepGateway(ids),
    command,
    clock: new FixedClock(),
    batchSize,
  });
}

describe("OrderCompletionSweepJob", () => {
  it("releases each expired listening hold through the shared complete command", async () => {
    const command = new RecordingCompleteCommand();
    const result = await makeJob(["o1", "o2", "o3"], command).runBatch({
      cursor: null,
      nowEpochMs: NOW,
    });

    expect(command.calls.map((c) => c.orderId)).toEqual(["o1", "o2", "o3"]);
    expect(result.processed).toBe(3);
    expect(result.done).toBe(true);
    for (const call of command.calls) {
      // The batch instant, not a re-read clock: every order in a page is judged
      // at the same moment so the expiry check and release agree.
      expect(call.observedAtEpochMs).toBe(NOW);
      expect(call.trigger).toBe("expiry_sweep");
    }
  });

  it("uses a deterministic per-item operation key as the idempotency key", async () => {
    const command = new RecordingCompleteCommand();
    await makeJob(["o1"], command).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(command.calls[0]?.idempotencyKey).toBe(
      buildJobOperationKey(ORDER_COMPLETION_SWEEP_JOB, "o1"),
    );
  });

  it("mints the same key for an order across re-runs at different instants", async () => {
    // The command's idempotency payload excludes the observed instant, so a
    // constant key per order is what makes a crash re-run replay rather than
    // release a number twice.
    const command = new RecordingCompleteCommand();
    await makeJob(["o1"], command).runBatch({ cursor: null, nowEpochMs: NOW });
    await makeJob(["o1"], command).runBatch({ cursor: null, nowEpochMs: NOW + 60_000 });

    expect(command.calls).toHaveLength(2);
    expect(command.calls[0]?.idempotencyKey).toBe(command.calls[1]?.idempotencyKey);
    expect(command.calls[1]?.observedAtEpochMs).toBe(NOW + 60_000);
  });

  it("scans with the batch instant and no cursor on a fresh run", async () => {
    const command = new RecordingCompleteCommand();
    const gateway = new FakeOrderCompletionSweepGateway(["o1"]);
    await new OrderCompletionSweepJob({
      gateway,
      command,
      clock: new FixedClock(),
      batchSize: 50,
    }).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(gateway.lastInput).toEqual({ nowEpochMs: NOW, limit: 50, afterId: null });
  });

  it("reports a full batch as not drained and carries an id cursor", async () => {
    const command = new RecordingCompleteCommand();
    const result = await makeJob(["o1", "o2", "o3"], command, 2).runBatch({
      cursor: null,
      nowEpochMs: NOW,
    });

    expect(command.calls.map((c) => c.orderId)).toEqual(["o1", "o2"]);
    expect(result.done).toBe(false);
    expect(result.nextCursor).toEqual({ afterId: "o2" });
  });

  it("resumes after the cursor id", async () => {
    const command = new RecordingCompleteCommand();
    const result = await makeJob(["o1", "o2", "o3"], command, 2).runBatch({
      cursor: { afterId: "o2" },
      nowEpochMs: NOW,
    });

    expect(command.calls.map((c) => c.orderId)).toEqual(["o3"]);
    expect(result.done).toBe(true);
    expect(result.nextCursor).toBeNull();
  });

  it("does nothing when no listening window has expired", async () => {
    const command = new RecordingCompleteCommand();
    const result = await makeJob([], command).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(command.calls).toHaveLength(0);
    expect(result.processed).toBe(0);
    expect(result.done).toBe(true);
    expect(result.nextCursor).toBeNull();
  });
});
