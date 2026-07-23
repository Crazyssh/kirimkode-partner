import { describe, expect, it } from "vitest";

import { ReservationRecoveryJob } from "./reservation-recovery-job";
import type {
  Clock,
  PromoteReservationInput,
  ReleaseReservationInput,
  ReservationRecoveryGateway,
  ReservationRecoveryTransaction,
  StuckReservationContext,
} from "./ports";

const NOW = 30_000_000;
const RECOVERY_SECONDS = 30;
const HEARTBEAT_TIMEOUT_SECONDS = 90;

class FixedClock implements Clock {
  nowEpochMs(): number {
    return NOW;
  }
}

class FakeReservationRecoveryGateway
  implements ReservationRecoveryGateway, ReservationRecoveryTransaction
{
  readonly promoted: PromoteReservationInput[] = [];
  readonly released: ReleaseReservationInput[] = [];
  lastLockInput: {
    staleBeforeEpochMs: number;
    limit: number;
    afterId: string | null;
  } | null = null;

  constructor(private readonly stuck: StuckReservationContext[]) {}

  async loadReservationRecoverySeconds(): Promise<number | null> {
    return RECOVERY_SECONDS;
  }
  async loadHeartbeatTimeoutSeconds(): Promise<number | null> {
    return HEARTBEAT_TIMEOUT_SECONDS;
  }

  async runInTransaction<T>(
    work: (tx: ReservationRecoveryTransaction) => Promise<T>,
  ): Promise<T> {
    return work(this);
  }

  async lockStuckReservations(input: {
    staleBeforeEpochMs: number;
    limit: number;
    afterId: string | null;
  }): Promise<readonly StuckReservationContext[]> {
    this.lastLockInput = input;
    return this.stuck
      .filter((s) => input.afterId === null || s.orderId > input.afterId)
      .slice(0, input.limit);
  }

  async promote(input: PromoteReservationInput): Promise<void> {
    this.promoted.push(input);
  }

  async release(input: ReleaseReservationInput): Promise<void> {
    this.released.push(input);
  }
}

function validReservation(
  overrides: Partial<StuckReservationContext> = {},
): StuckReservationContext {
  return {
    orderId: "o1",
    partnerId: "p1",
    numberId: "n1",
    version: 3,
    numberStatus: "reserved",
    numberBound: true,
    numberEnabled: true,
    hasActiveOffer: true,
    deviceStatus: "online",
    deviceLastSeenAtEpochMs: NOW - 10_000,
    ...overrides,
  };
}

function makeJob(gateway: FakeReservationRecoveryGateway, batchSize = 100) {
  return new ReservationRecoveryJob({ gateway, clock: new FixedClock(), batchSize });
}

describe("ReservationRecoveryJob", () => {
  it("promotes a still-valid stuck reservation to waiting_sms", async () => {
    const gateway = new FakeReservationRecoveryGateway([validReservation()]);
    const result = await makeJob(gateway).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(gateway.promoted).toHaveLength(1);
    expect(gateway.released).toHaveLength(0);
    expect(gateway.promoted[0]?.orderId).toBe("o1");
    expect(gateway.promoted[0]?.expectedVersion).toBe(3);
    expect(result.processed).toBe(1);
    expect(result.done).toBe(true);
  });

  it("scans reservations older than the 30s recovery window", async () => {
    const gateway = new FakeReservationRecoveryGateway([]);
    await makeJob(gateway).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(gateway.lastLockInput?.staleBeforeEpochMs).toBe(NOW - RECOVERY_SECONDS * 1000);
  });

  it("releases a reservation whose device is no longer live", async () => {
    const gateway = new FakeReservationRecoveryGateway([
      validReservation({ deviceStatus: "offline" }),
    ]);
    await makeJob(gateway).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(gateway.promoted).toHaveLength(0);
    expect(gateway.released).toHaveLength(1);
    // The paired number release frees the number (offline device -> offline).
    expect(gateway.released[0]?.numberChanged).toBe(true);
    expect(gateway.released[0]?.toNumberStatus).toBe("offline");
  });

  it("releases a reservation whose number is no longer bound", async () => {
    const gateway = new FakeReservationRecoveryGateway([
      validReservation({ numberBound: false }),
    ]);
    await makeJob(gateway).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(gateway.promoted).toHaveLength(0);
    expect(gateway.released).toHaveLength(1);
  });

  it("releases a reservation for a disabled number", async () => {
    const gateway = new FakeReservationRecoveryGateway([
      validReservation({ numberEnabled: false }),
    ]);
    await makeJob(gateway).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(gateway.released).toHaveLength(1);
  });

  it("frees the number back to available when the device is still live on release", async () => {
    // Number lost its binding but the device is live: release still frees it,
    // and a live+enabled device sends the number back to available.
    const gateway = new FakeReservationRecoveryGateway([
      validReservation({ numberBound: false }),
    ]);
    await makeJob(gateway).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(gateway.released[0]?.toNumberStatus).toBe("available");
  });

  it("reports a full batch as not drained and carries an id cursor", async () => {
    const gateway = new FakeReservationRecoveryGateway([
      validReservation({ orderId: "o1" }),
      validReservation({ orderId: "o2" }),
    ]);
    const result = await makeJob(gateway, 2).runBatch({ cursor: null, nowEpochMs: NOW });

    expect(result.done).toBe(false);
    expect(result.nextCursor).toEqual({ afterId: "o2" });
  });
});
