import { describe, expect, it } from "vitest";

import { OfflineSweepJob } from "./offline-sweep-job";
import type {
  Clock,
  IdGenerator,
  IdleNumberRow,
  NumberOfflineChange,
  OfflineSweepGateway,
  OfflineSweepTransaction,
  StaleDeviceRow,
} from "./ports";
import type { NumberStatus } from "@domain/order-state-machine";

const NOW = 10_000_000;
const TIMEOUT_SECONDS = 90;

class FixedClock implements Clock {
  constructor(private readonly now = NOW) {}
  nowEpochMs(): number {
    return this.now;
  }
}

class SequentialIds implements IdGenerator {
  private n = 0;
  uuid(): string {
    this.n += 1;
    return `history-${this.n}`;
  }
}

interface FakeDevice {
  id: string;
  status: "online" | "offline" | "disabled";
  lastSeenAtMs: number | null;
}

interface FakeNumber {
  id: string;
  deviceId: string;
  status: NumberStatus;
}

class FakeOfflineSweepGateway
  implements OfflineSweepGateway, OfflineSweepTransaction
{
  readonly devices: FakeDevice[];
  readonly numbers: FakeNumber[];
  readonly history: NumberOfflineChange[] = [];
  timeoutSeconds: number | null = TIMEOUT_SECONDS;

  constructor(devices: FakeDevice[], numbers: FakeNumber[]) {
    this.devices = devices;
    this.numbers = numbers;
  }

  async loadHeartbeatTimeoutSeconds(): Promise<number | null> {
    return this.timeoutSeconds;
  }

  async runInTransaction<T>(
    work: (tx: OfflineSweepTransaction) => Promise<T>,
  ): Promise<T> {
    return work(this);
  }

  async lockStaleOnlineDevices(input: {
    nowEpochMs: number;
    timeoutMs: number;
    limit: number;
    afterId: string | null;
  }): Promise<readonly StaleDeviceRow[]> {
    const staleBefore = input.nowEpochMs - input.timeoutMs;
    return this.devices
      .filter(
        (d) =>
          d.status === "online" &&
          (d.lastSeenAtMs === null || d.lastSeenAtMs <= staleBefore) &&
          (input.afterId === null || d.id > input.afterId),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, input.limit)
      .map((d) => ({ id: d.id }));
  }

  async markDeviceOffline(deviceId: string): Promise<boolean> {
    const device = this.devices.find((d) => d.id === deviceId);
    if (device === undefined || device.status !== "online") return false;
    device.status = "offline";
    return true;
  }

  async listIdleAvailableNumbers(deviceId: string): Promise<readonly IdleNumberRow[]> {
    return this.numbers
      .filter((n) => n.deviceId === deviceId && n.status === "available")
      .map((n) => ({ id: n.id, status: n.status }));
  }

  async applyNumberOffline(change: NumberOfflineChange): Promise<boolean> {
    const number = this.numbers.find((n) => n.id === change.numberId);
    if (number === undefined || number.status !== "available") return false;
    number.status = "offline";
    this.history.push(change);
    return true;
  }
}

function job(gateway: FakeOfflineSweepGateway, overrides = {}): OfflineSweepJob {
  return new OfflineSweepJob({
    gateway,
    clock: new FixedClock(),
    idGenerator: new SequentialIds(),
    batchSize: 100,
    ...overrides,
  });
}

describe("OfflineSweepJob", () => {
  it("marks a stale online device offline and takes its idle numbers offline", async () => {
    const gateway = new FakeOfflineSweepGateway(
      [{ id: "d1", status: "online", lastSeenAtMs: NOW - 200_000 }],
      [
        { id: "n1", deviceId: "d1", status: "available" },
        { id: "n2", deviceId: "d1", status: "available" },
      ],
    );

    const result = await job(gateway).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(gateway.devices[0]?.status).toBe("offline");
    expect(gateway.numbers.every((n) => n.status === "offline")).toBe(true);
    expect(result.processed).toBe(1);
    expect(result.done).toBe(true);
    expect(result.nextCursor).toBeNull();
    expect(gateway.history).toHaveLength(2);
    expect(gateway.history[0]?.reason).toBe("offline_sweep");
  });

  it("never relocates an active order: reserved/busy numbers stay untouched", async () => {
    const gateway = new FakeOfflineSweepGateway(
      [{ id: "d1", status: "online", lastSeenAtMs: NOW - 200_000 }],
      [
        { id: "n1", deviceId: "d1", status: "reserved" },
        { id: "n2", deviceId: "d1", status: "busy" },
        { id: "n3", deviceId: "d1", status: "available" },
      ],
    );

    await job(gateway).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(gateway.numbers.find((n) => n.id === "n1")?.status).toBe("reserved");
    expect(gateway.numbers.find((n) => n.id === "n2")?.status).toBe("busy");
    expect(gateway.numbers.find((n) => n.id === "n3")?.status).toBe("offline");
    expect(gateway.history).toHaveLength(1);
  });

  it("leaves a device that is still live alone", async () => {
    const gateway = new FakeOfflineSweepGateway(
      [{ id: "d1", status: "online", lastSeenAtMs: NOW - 10_000 }],
      [{ id: "n1", deviceId: "d1", status: "available" }],
    );

    const result = await job(gateway).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(gateway.devices[0]?.status).toBe("online");
    expect(gateway.numbers[0]?.status).toBe("available");
    expect(result.processed).toBe(0);
  });

  it("is idempotent: a re-run does nothing once devices are already offline", async () => {
    const gateway = new FakeOfflineSweepGateway(
      [{ id: "d1", status: "online", lastSeenAtMs: NOW - 200_000 }],
      [{ id: "n1", deviceId: "d1", status: "available" }],
    );

    await job(gateway).runBatch({ cursor: null, nowEpochMs: NOW });
    const second = await job(gateway).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(second.processed).toBe(0);
    expect(gateway.history).toHaveLength(1);
  });

  it("reports a full batch as not drained and carries an id cursor", async () => {
    const gateway = new FakeOfflineSweepGateway(
      [
        { id: "d1", status: "online", lastSeenAtMs: NOW - 200_000 },
        { id: "d2", status: "online", lastSeenAtMs: NOW - 200_000 },
      ],
      [],
    );

    const result = await job(gateway, { batchSize: 2 }).runBatch({
      cursor: null,
      nowEpochMs: NOW,
    });

    expect(result.processed).toBe(2);
    expect(result.done).toBe(false);
    expect(result.nextCursor).toEqual({ afterId: "d2" });
  });

  it("falls back to the MVP 90s window when no config is present", async () => {
    const gateway = new FakeOfflineSweepGateway(
      [{ id: "d1", status: "online", lastSeenAtMs: NOW - 91_000 }],
      [],
    );
    gateway.timeoutSeconds = null;

    const result = await job(gateway).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(result.processed).toBe(1);
  });
});
