import { beforeEach, describe, expect, it } from "vitest";

import type { TenantContext } from "@infrastructure/database";
import type { DeviceCapabilities } from "@domain/task-5-2-device-inventory-pricing";

import { RecordHeartbeatService } from "./record-heartbeat-service";
import type {
  ActiveOfferDimension,
  HeartbeatDeviceRow,
  HeartbeatDeviceUpdate,
  HeartbeatDeviceView,
  HeartbeatGateway,
  HeartbeatSampleRecord,
  IdleNumberRow,
  NumberStatusChange,
  RecordHeartbeatTransaction,
} from "./ports";

const PARTNER_A = "00000000-0000-4000-8000-00000000000a";
const PARTNER_B = "00000000-0000-4000-8000-00000000000b";
const DEVICE_ID = "00000000-0000-4000-8000-0000000000d1";

const TENANT: TenantContext = { partnerId: PARTNER_A };

const CAPS: DeviceCapabilities = Object.freeze({
  sms: true,
  notification: false,
  resend: false,
  operator: false,
  slots: 1,
});

// A fixed server time and a couple of relative marks.
const NOW = 1_700_000_000_000;
const ONE_MINUTE = 60_000;

class SequentialIds {
  private n = 0;
  uuid(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${this.n.toString(16).padStart(12, "0")}`;
  }
}

class FixedClock {
  constructor(public value = NOW) {}
  nowEpochMs(): number {
    return this.value;
  }
}

interface StoredNumber {
  id: string;
  status: IdleNumberRow["status"];
  enabled: boolean;
  countryCode: string;
  operatorCode: string;
  hasActiveOrder: boolean;
}

/** In-memory heartbeat store shared across a fake transaction. */
class FakeGateway implements HeartbeatGateway {
  device: HeartbeatDeviceRow | null;
  readonly numbers = new Map<string, StoredNumber>();
  offerDimensions: ActiveOfferDimension[] = [];
  readonly samples: HeartbeatSampleRecord[] = [];
  readonly deviceUpdates: HeartbeatDeviceUpdate[] = [];
  readonly numberChanges: NumberStatusChange[] = [];

  constructor(device: HeartbeatDeviceRow | null) {
    this.device = device;
  }

  seedNumber(number: StoredNumber): void {
    this.numbers.set(number.id, number);
  }

  async runInTenant<T>(
    tenant: TenantContext,
    work: (tx: RecordHeartbeatTransaction) => Promise<T>,
  ): Promise<T> {
    const device = this.device;
    const numbers = this.numbers;
    const offerDimensions = this.offerDimensions;
    const samples = this.samples;
    const deviceUpdates = this.deviceUpdates;
    const numberChanges = this.numberChanges;
    const belongsToTenant = tenant.partnerId === PARTNER_A;
    const tx: RecordHeartbeatTransaction = {
      async findDeviceForHeartbeat(deviceId: string): Promise<HeartbeatDeviceRow | null> {
        if (!belongsToTenant) return null;
        return device && device.id === deviceId ? device : null;
      },
      async insertHeartbeatSample(sample: HeartbeatSampleRecord): Promise<void> {
        samples.push(sample);
      },
      async applyHeartbeatToDevice(
        deviceId: string,
        update: HeartbeatDeviceUpdate,
      ): Promise<HeartbeatDeviceView> {
        deviceUpdates.push(update);
        if (device === null) throw new Error("device missing");
        return {
          id: deviceId,
          partnerId: device.partnerId,
          type: device.type,
          status: update.status,
          lastSeenAtEpochMs: update.lastSeenAtEpochMs,
          agentVersion: update.agentVersion,
          capabilities: update.capabilities ?? device.capabilities,
        };
      },
      async listIdleNumbers(deviceId: string): Promise<readonly IdleNumberRow[]> {
        return [...numbers.values()]
          .filter((n) => (n.status === "offline" || n.status === "available") && deviceId === DEVICE_ID)
          .map((n) => ({
            id: n.id,
            status: n.status,
            enabled: n.enabled,
            countryCode: n.countryCode,
            operatorCode: n.operatorCode,
            hasActiveOrder: n.hasActiveOrder,
          }));
      },
      async listActiveOfferDimensions(): Promise<readonly ActiveOfferDimension[]> {
        return offerDimensions;
      },
      async applyNumberStatus(change: NumberStatusChange): Promise<void> {
        numberChanges.push(change);
        const number = numbers.get(change.numberId);
        if (number) number.status = change.toStatus;
      },
    };
    return work(tx);
  }
}

function deviceRow(over: Partial<HeartbeatDeviceRow> = {}): HeartbeatDeviceRow {
  return {
    id: DEVICE_ID,
    partnerId: PARTNER_A,
    type: "simulator",
    status: "offline",
    lastSeenAtEpochMs: null,
    capabilities: CAPS,
    agentVersion: null,
    ...over,
  };
}

function makeService(gateway: FakeGateway): RecordHeartbeatService {
  return new RecordHeartbeatService({
    gateway,
    clock: new FixedClock(),
    idGenerator: new SequentialIds(),
  });
}

describe("RecordHeartbeatService", () => {
  let gateway: FakeGateway;
  let service: RecordHeartbeatService;

  beforeEach(() => {
    gateway = new FakeGateway(deviceRow());
    service = makeService(gateway);
  });

  // Requirement 6.1: a valid heartbeat moves offline -> online, stamps
  // lastSeenAt with the server time, and persists a heartbeat sample.
  it("moves an offline device online and records the sample (req 6.1)", async () => {
    const result = await service.recordHeartbeat({
      tenant: TENANT,
      deviceId: DEVICE_ID,
      receivedAtServer: new Date(NOW),
      metadata: { agentVersion: "1.2.3", signal: -70, operator: "TELKOMSEL", health: { battery: 88 } },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.device.status).toBe("online");
    expect(result.device.lastSeenAtEpochMs).toBe(NOW);

    expect(gateway.samples).toHaveLength(1);
    expect(gateway.samples[0]).toMatchObject({
      deviceId: DEVICE_ID,
      receivedAtEpochMs: NOW,
      signal: -70,
      operator: "TELKOMSEL",
      agentVersion: "1.2.3",
    });
    expect(gateway.deviceUpdates[0]).toMatchObject({
      status: "online",
      lastSeenAtEpochMs: NOW,
      agentVersion: "1.2.3",
      metadataJson: { agentVersion: "1.2.3", signal: -70, operator: "TELKOMSEL", health: { battery: 88 } },
    });
  });

  // Requirement 6.1 / design section 7: lastSeenAt is monotonic — an older
  // server time never rewinds a newer existing lastSeenAt.
  it("keeps lastSeenAt monotonic when the heartbeat is older than existing", async () => {
    gateway.device = deviceRow({ status: "online", lastSeenAtEpochMs: NOW });
    const result = await service.recordHeartbeat({
      tenant: TENANT,
      deviceId: DEVICE_ID,
      receivedAtServer: new Date(NOW - ONE_MINUTE),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.device.lastSeenAtEpochMs).toBe(NOW);
    expect(gateway.deviceUpdates[0].lastSeenAtEpochMs).toBe(NOW);
  });

  // Requirement 6.4: metadata is stored but never trusted for authorization —
  // an unknown/spoofed field is rejected as validation, no state changes.
  it("rejects invalid heartbeat metadata as validation", async () => {
    const result = await service.recordHeartbeat({
      tenant: TENANT,
      deviceId: DEVICE_ID,
      receivedAtServer: new Date(NOW),
      metadata: { agentVersion: 123 },
    });
    expect(result).toEqual({ ok: false, reason: "validation", code: "INVALID_HEARTBEAT" });
    expect(gateway.samples).toHaveLength(0);
    expect(gateway.deviceUpdates).toHaveLength(0);
  });

  // Requirement 5.6: a disabled device is fail-closed — no sample, no mutation.
  it("rejects a disabled device without mutating state (req 5.6)", async () => {
    gateway.device = deviceRow({ status: "disabled" });
    const result = await service.recordHeartbeat({
      tenant: TENANT,
      deviceId: DEVICE_ID,
      receivedAtServer: new Date(NOW),
    });
    expect(result).toEqual({ ok: false, reason: "device_disabled" });
    expect(gateway.samples).toHaveLength(0);
    expect(gateway.deviceUpdates).toHaveLength(0);
  });

  it("treats a cross-tenant device as not found", async () => {
    const result = await service.recordHeartbeat({
      tenant: { partnerId: PARTNER_B },
      deviceId: DEVICE_ID,
      receivedAtServer: new Date(NOW),
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found for an unknown device id", async () => {
    gateway.device = null;
    const result = await service.recordHeartbeat({
      tenant: TENANT,
      deviceId: DEVICE_ID,
      receivedAtServer: new Date(NOW),
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  // Requirement 6.3 / design section 7: on recovery, an idle offline number
  // returns to available only when enabled + active offer + no active order.
  it("recovers an eligible offline number to available (req 6.3)", async () => {
    gateway.offerDimensions = [{ countryCode: "ID", operatorCode: "any" }];
    gateway.seedNumber({
      id: "num-1",
      status: "offline",
      enabled: true,
      countryCode: "ID",
      operatorCode: "any",
      hasActiveOrder: false,
    });

    const result = await service.recordHeartbeat({
      tenant: TENANT,
      deviceId: DEVICE_ID,
      receivedAtServer: new Date(NOW),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recoveredNumberIds).toEqual(["num-1"]);
    expect(gateway.numberChanges).toHaveLength(1);
    expect(gateway.numberChanges[0]).toMatchObject({
      numberId: "num-1",
      fromStatus: "offline",
      toStatus: "available",
      reason: "heartbeat_recovery",
      actorRef: DEVICE_ID,
    });
  });

  it("does not recover an offline number without an active offer", async () => {
    gateway.offerDimensions = [];
    gateway.seedNumber({
      id: "num-1",
      status: "offline",
      enabled: true,
      countryCode: "ID",
      operatorCode: "any",
      hasActiveOrder: false,
    });

    const result = await service.recordHeartbeat({
      tenant: TENANT,
      deviceId: DEVICE_ID,
      receivedAtServer: new Date(NOW),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recoveredNumberIds).toEqual([]);
    expect(gateway.numberChanges).toHaveLength(0);
  });

  it("does not recover an offline number that still has an active order", async () => {
    gateway.offerDimensions = [{ countryCode: "ID", operatorCode: "any" }];
    gateway.seedNumber({
      id: "num-1",
      status: "offline",
      enabled: true,
      countryCode: "ID",
      operatorCode: "any",
      hasActiveOrder: true,
    });

    const result = await service.recordHeartbeat({
      tenant: TENANT,
      deviceId: DEVICE_ID,
      receivedAtServer: new Date(NOW),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recoveredNumberIds).toEqual([]);
    expect(gateway.numberChanges).toHaveLength(0);
  });

  // An already-available number needs no change (idempotent recovery).
  it("leaves an already-available eligible number unchanged", async () => {
    gateway.offerDimensions = [{ countryCode: "ID", operatorCode: "any" }];
    gateway.seedNumber({
      id: "num-1",
      status: "available",
      enabled: true,
      countryCode: "ID",
      operatorCode: "any",
      hasActiveOrder: false,
    });

    const result = await service.recordHeartbeat({
      tenant: TENANT,
      deviceId: DEVICE_ID,
      receivedAtServer: new Date(NOW),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recoveredNumberIds).toEqual([]);
    expect(gateway.numberChanges).toHaveLength(0);
  });

  // A disabled number is not recovered — it is excluded from the idle set and
  // the domain keeps it disabled.
  it("does not recover a disabled number", async () => {
    gateway.offerDimensions = [{ countryCode: "ID", operatorCode: "any" }];
    gateway.seedNumber({
      id: "num-1",
      status: "available",
      enabled: false,
      countryCode: "ID",
      operatorCode: "any",
      hasActiveOrder: false,
    });

    const result = await service.recordHeartbeat({
      tenant: TENANT,
      deviceId: DEVICE_ID,
      receivedAtServer: new Date(NOW),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // enabled=false -> reconcile returns "disabled", which differs from
    // "available", so it is transitioned to disabled (but never recovered).
    expect(result.recoveredNumberIds).toEqual([]);
    expect(gateway.numberChanges).toEqual([
      expect.objectContaining({ numberId: "num-1", toStatus: "disabled" }),
    ]);
  });
});
