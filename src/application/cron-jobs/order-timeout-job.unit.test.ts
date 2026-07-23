import { describe, expect, it } from "vitest";

import { buildJobOperationKey } from "@domain/task-16-1/cron-jobs";
import type { TerminalResult, TimeoutCommandInput } from "@application/orders";

import {
  ORDER_TIMEOUT_JOB,
  OrderTimeoutJob,
  type OrderTimeoutCommand,
} from "./order-timeout-job";
import type { Clock, OrderTimeoutGateway } from "./ports";

const NOW = 20_000_000;

class FixedClock implements Clock {
  nowEpochMs(): number {
    return NOW;
  }
}

class FakeOrderTimeoutGateway implements OrderTimeoutGateway {
  constructor(private readonly ids: string[]) {}
  lastInput: { nowEpochMs: number; limit: number; afterId: string | null } | null = null;

  async listExpiredOrderIds(input: {
    nowEpochMs: number;
    limit: number;
    afterId: string | null;
  }): Promise<readonly string[]> {
    this.lastInput = input;
    const start = input.afterId === null ? 0 : this.ids.indexOf(input.afterId) + 1;
    return this.ids.slice(start, start + input.limit);
  }
}

class RecordingTimeoutCommand implements OrderTimeoutCommand {
  readonly calls: TimeoutCommandInput[] = [];
  async timeout(input: TimeoutCommandInput): Promise<TerminalResult> {
    this.calls.push(input);
    return { statusCode: 200, body: { data: {
      partnerOrderId: input.orderId,
      status: "timeout",
      terminalReason: input.reason,
      releaseDisposition: "available",
    } } };
  }
}

function makeJob(
  ids: string[],
  command: OrderTimeoutCommand,
  batchSize = 100,
): OrderTimeoutJob {
  return new OrderTimeoutJob({
    gateway: new FakeOrderTimeoutGateway(ids),
    command,
    clock: new FixedClock(),
    batchSize,
  });
}

describe("OrderTimeoutJob", () => {
  it("drives each expired order through the shared timeout command", async () => {
    const command = new RecordingTimeoutCommand();
    const result = await makeJob(["o1", "o2", "o3"], command).runBatch({
      cursor: null,
      nowEpochMs: NOW,
    });

    expect(command.calls.map((c) => c.orderId)).toEqual(["o1", "o2", "o3"]);
    expect(result.processed).toBe(3);
    expect(result.done).toBe(true);
    for (const call of command.calls) {
      expect(call.observedAtEpochMs).toBe(NOW);
      expect(call.reason).toBe("ORDER_TIMEOUT");
    }
  });

  it("uses a deterministic per-item operation key as the idempotency key", async () => {
    const command = new RecordingTimeoutCommand();
    await makeJob(["o1"], command).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(command.calls[0]?.idempotencyKey).toBe(
      buildJobOperationKey(ORDER_TIMEOUT_JOB, "o1"),
    );
  });

  it("reports a full batch as not drained and carries an id cursor", async () => {
    const command = new RecordingTimeoutCommand();
    const result = await makeJob(["o1", "o2", "o3"], command, 2).runBatch({
      cursor: null,
      nowEpochMs: NOW,
    });

    expect(command.calls.map((c) => c.orderId)).toEqual(["o1", "o2"]);
    expect(result.done).toBe(false);
    expect(result.nextCursor).toEqual({ afterId: "o2" });
  });

  it("resumes after the cursor id", async () => {
    const command = new RecordingTimeoutCommand();
    const result = await makeJob(["o1", "o2", "o3"], command, 2).runBatch({
      cursor: { afterId: "o2" },
      nowEpochMs: NOW,
    });

    expect(command.calls.map((c) => c.orderId)).toEqual(["o3"]);
    expect(result.done).toBe(true);
    expect(result.nextCursor).toBeNull();
  });

  it("does nothing when there is no expired backlog", async () => {
    const command = new RecordingTimeoutCommand();
    const result = await makeJob([], command).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(command.calls).toHaveLength(0);
    expect(result.processed).toBe(0);
    expect(result.done).toBe(true);
  });
});
