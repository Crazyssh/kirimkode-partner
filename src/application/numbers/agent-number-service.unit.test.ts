import { describe, expect, it } from "vitest";

import { IdempotencyEngine } from "@application/internal-api";
import type {
  IdempotencyRecordInsert,
  IdempotencyRecordLookup,
  IdempotencyRecordRow,
  IdempotencyStore,
  IdempotencyTransactionRunner,
} from "@application/internal-api";

import {
  AgentNumberService,
  type RegisterAgentNumberInput,
  type SetAgentNumberAvailabilityInput,
} from "./agent-number-service";
import { ActiveNumberConflictError, type NumberView } from "./ports";
import type {
  ActiveNumberIdentity,
  AgentDeviceRef,
  AgentNumberAvailabilityContext,
  AgentNumberGateway,
} from "./agent-ports";
import type { NumberStatus } from "@domain/task-5-2-device-inventory-pricing";

const PARTNER_ID = "00000000-0000-4000-8000-00000000000a";
const DEVICE_ID = "00000000-0000-4000-8000-0000000000d1";
const OTHER_DEVICE_ID = "00000000-0000-4000-8000-0000000000d2";
const NOW = new Date("2024-01-01T00:00:00.000Z").getTime();

type FakeTx = { readonly kind: "fake-tx" };
const FAKE_TX: FakeTx = { kind: "fake-tx" };

/** In-memory idempotency store keyed on (scope, principalId, key). */
class InMemoryIdempotencyStore implements IdempotencyStore<FakeTx> {
  private readonly rows = new Map<string, IdempotencyRecordRow>();

  private keyOf(lookup: IdempotencyRecordLookup): string {
    return `${lookup.scope}|${lookup.principalId}|${lookup.key}`;
  }

  async find(_tx: FakeTx, lookup: IdempotencyRecordLookup): Promise<IdempotencyRecordRow | null> {
    return this.rows.get(this.keyOf(lookup)) ?? null;
  }

  async insert(_tx: FakeTx, record: IdempotencyRecordInsert): Promise<{ readonly inserted: boolean }> {
    const key = this.keyOf(record);
    if (this.rows.has(key)) return { inserted: false };
    this.rows.set(key, {
      scope: record.scope,
      principalId: record.principalId,
      key: record.key,
      requestHash: record.requestHash,
      responseStatus: record.responseStatus,
      responseJson: record.responseJson,
    });
    return { inserted: true };
  }
}

class ImmediateRunner implements IdempotencyTransactionRunner<FakeTx> {
  async run<T>(work: (tx: FakeTx) => Promise<T>): Promise<T> {
    return work(FAKE_TX);
  }
}

/** A stored number row in the fake gateway. */
interface StoredNumber {
  id: string;
  deviceId: string;
  canonicalNumber: string;
  countryCode: string;
  operatorCode: string;
  status: NumberStatus;
  enabled: boolean;
  activeCanonicalNumber: string | null;
  hasActiveOrder: boolean;
}

interface FakeGatewayOptions {
  readonly knownDeviceIds?: readonly string[];
  readonly deviceLive?: boolean;
  readonly hasActiveOffer?: boolean;
}

class FakeAgentNumberGateway implements AgentNumberGateway<FakeTx> {
  readonly numbers = new Map<string, StoredNumber>();
  historyCount = 0;
  auditCount = 0;
  private nextId = 1;
  private readonly options: Required<FakeGatewayOptions>;

  constructor(options: FakeGatewayOptions = {}) {
    this.options = {
      knownDeviceIds: options.knownDeviceIds ?? [DEVICE_ID],
      deviceLive: options.deviceLive ?? true,
      hasActiveOffer: options.hasActiveOffer ?? true,
    };
  }

  seed(number: StoredNumber): void {
    this.numbers.set(number.id, number);
  }

  async findOwnedDevice(_tx: FakeTx, _partnerId: string, deviceId: string): Promise<AgentDeviceRef | null> {
    return this.options.knownDeviceIds.includes(deviceId) ? { id: deviceId } : null;
  }

  async listActiveNumbers(_tx: FakeTx, _partnerId: string): Promise<readonly ActiveNumberIdentity[]> {
    return [...this.numbers.values()]
      .filter((n) => n.status !== "disabled")
      .map((n) => ({ id: n.id, canonicalNumber: n.canonicalNumber, status: n.status }));
  }

  async insertNumber(
    _tx: FakeTx,
    _partnerId: string,
    record: {
      readonly id: string;
      readonly deviceId: string;
      readonly canonicalNumber: string;
      readonly countryCode: string;
      readonly operatorCode: string;
      readonly status: NumberStatus;
      readonly enabled: boolean;
      readonly activeCanonicalNumber: string | null;
    },
  ): Promise<NumberView> {
    // Enforce the global active-canonical unique slot.
    if (
      record.activeCanonicalNumber !== null &&
      [...this.numbers.values()].some((n) => n.activeCanonicalNumber === record.activeCanonicalNumber)
    ) {
      throw new ActiveNumberConflictError();
    }
    const stored: StoredNumber = { ...record, hasActiveOrder: false };
    this.numbers.set(record.id, stored);
    return this.toView(stored);
  }

  async loadNumberForAvailability(
    _tx: FakeTx,
    _partnerId: string,
    numberId: string,
  ): Promise<AgentNumberAvailabilityContext | null> {
    const n = this.numbers.get(numberId);
    if (n === undefined) return null;
    return {
      numberId: n.id,
      deviceId: n.deviceId,
      canonicalNumber: n.canonicalNumber,
      countryCode: n.countryCode,
      operatorCode: n.operatorCode,
      status: n.status,
      enabled: n.enabled,
      hasActiveOrder: n.hasActiveOrder,
      hasActiveOffer: this.options.hasActiveOffer,
      device: this.options.deviceLive
        ? { status: "online", lastSeenAtEpochMs: NOW }
        : { status: "offline", lastSeenAtEpochMs: NOW - 10 * 60 * 1000 },
    };
  }

  async applyNumberStatus(
    _tx: FakeTx,
    _partnerId: string,
    numberId: string,
    mutation: { readonly status: NumberStatus; readonly enabled: boolean; readonly activeCanonicalNumber: string | null },
  ): Promise<NumberView> {
    const n = this.numbers.get(numberId);
    if (n === undefined) throw new Error("number not found");
    if (
      mutation.activeCanonicalNumber !== null &&
      [...this.numbers.values()].some(
        (other) => other.id !== numberId && other.activeCanonicalNumber === mutation.activeCanonicalNumber,
      )
    ) {
      throw new ActiveNumberConflictError();
    }
    n.status = mutation.status;
    n.enabled = mutation.enabled;
    n.activeCanonicalNumber = mutation.activeCanonicalNumber;
    return this.toView(n);
  }

  async appendStateHistory(): Promise<void> {
    this.historyCount += 1;
  }

  async recordAudit(): Promise<void> {
    this.auditCount += 1;
  }

  private toView(n: StoredNumber): NumberView {
    return {
      id: n.id,
      partnerId: PARTNER_ID,
      deviceId: n.deviceId,
      canonicalNumber: n.canonicalNumber,
      countryCode: n.countryCode,
      operatorCode: n.operatorCode,
      status: n.status,
      enabled: n.enabled,
      hasActiveOrder: n.hasActiveOrder,
    };
  }

  seqId(): string {
    return `id-${this.nextId++}`;
  }
}

function makeService(gateway: FakeAgentNumberGateway): AgentNumberService<FakeTx> {
  let counter = 0;
  return new AgentNumberService<FakeTx>({
    idempotency: new IdempotencyEngine<FakeTx>({
      store: new InMemoryIdempotencyStore(),
      runner: new ImmediateRunner(),
      clock: { nowEpochMs: () => NOW },
    }),
    gateway,
    clock: { nowEpochMs: () => NOW },
    idGenerator: { uuid: () => `uuid-${counter++}` },
  });
}

function registerInput(over: Partial<RegisterAgentNumberInput> = {}): RegisterAgentNumberInput {
  return {
    partnerId: PARTNER_ID,
    deviceId: DEVICE_ID,
    idempotencyKey: "key-1",
    method: "POST",
    path: "/api/agent/v1/numbers/register",
    requestId: "00000000-0000-4000-8000-0000000000f0",
    rawNumber: "0812-3456-7890",
    ...over,
  };
}

function availabilityInput(over: Partial<SetAgentNumberAvailabilityInput> = {}): SetAgentNumberAvailabilityInput {
  return {
    partnerId: PARTNER_ID,
    deviceId: DEVICE_ID,
    numberId: "num-1",
    idempotencyKey: "avail-1",
    method: "POST",
    path: "/api/agent/v1/numbers/num-1/availability",
    requestId: "00000000-0000-4000-8000-0000000000f1",
    requested: "available",
    ...over,
  };
}

function seedNumber(gateway: FakeAgentNumberGateway, over: Partial<StoredNumber> = {}): void {
  gateway.seed({
    id: "num-1",
    deviceId: DEVICE_ID,
    canonicalNumber: "+6281234567890",
    countryCode: "ID",
    operatorCode: "any",
    status: "offline",
    enabled: true,
    activeCanonicalNumber: "+6281234567890",
    hasActiveOrder: false,
    ...over,
  });
}

describe("AgentNumberService.registerNumber", () => {
  // Requirement 7.1 / 7.2: register a canonical, unique, offline number owned
  // by the authenticated device, with a state-history entry and audit event.
  it("registers a normalised offline number and writes history + audit", async () => {
    const gateway = new FakeAgentNumberGateway();
    const result = await makeService(gateway).registerNumber(registerInput());

    expect(result.statusCode).toBe(201);
    expect("data" in result.body && result.body.data).toMatchObject({
      canonicalNumber: "+6281234567890",
      status: "offline",
      enabled: true,
      deviceId: DEVICE_ID,
      operatorCode: "any",
    });
    expect(gateway.numbers.size).toBe(1);
    expect(gateway.historyCount).toBe(1);
    expect(gateway.auditCount).toBe(1);
  });

  it("rejects an invalid phone number with a VALIDATION_ERROR", async () => {
    const gateway = new FakeAgentNumberGateway();
    const result = await makeService(gateway).registerNumber(
      registerInput({ rawNumber: "12345" }),
    );
    expect(result.statusCode).toBe(400);
    // A specific, stable, safe validation code is surfaced (not a raw message).
    expect("error" in result.body && result.body.error.code).toBe("INVALID_PHONE_NUMBER");
    expect(gateway.numbers.size).toBe(0);
  });

  it("maps a duplicate active canonical number to DUPLICATE_ACTIVE_NUMBER", async () => {
    const gateway = new FakeAgentNumberGateway();
    seedNumber(gateway);
    const result = await makeService(gateway).registerNumber(
      registerInput({ rawNumber: "+6281234567890" }),
    );
    expect(result.statusCode).toBe(409);
    expect("error" in result.body && result.body.error.code).toBe("DUPLICATE_ACTIVE_NUMBER");
  });

  it("rejects a mutation with no idempotency key as IDEMPOTENCY_REQUIRED", async () => {
    const gateway = new FakeAgentNumberGateway();
    const result = await makeService(gateway).registerNumber(
      registerInput({ idempotencyKey: null }),
    );
    expect(result.statusCode).toBe(400);
    expect("error" in result.body && result.body.error.code).toBe("IDEMPOTENCY_REQUIRED");
    expect(gateway.numbers.size).toBe(0);
  });

  it("replays the first response on a retry with the same key + payload", async () => {
    const gateway = new FakeAgentNumberGateway();
    const service = makeService(gateway);

    const first = await service.registerNumber(registerInput());
    const second = await service.registerNumber(registerInput());

    expect(first.statusCode).toBe(201);
    expect(second).toEqual(first);
    // The effect ran exactly once: only one number, one history, one audit.
    expect(gateway.numbers.size).toBe(1);
    expect(gateway.historyCount).toBe(1);
    expect(gateway.auditCount).toBe(1);
  });

  it("returns IDEMPOTENCY_CONFLICT on the same key with a different payload", async () => {
    const gateway = new FakeAgentNumberGateway();
    const service = makeService(gateway);

    await service.registerNumber(registerInput({ rawNumber: "+6281234567890" }));
    const conflict = await service.registerNumber(
      registerInput({ rawNumber: "+6281111111111" }),
    );

    expect(conflict.statusCode).toBe(409);
    expect("error" in conflict.body && conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(gateway.numbers.size).toBe(1);
  });
});

describe("AgentNumberService.setAvailability", () => {
  // Ownership (requirement 18.5): a number owned by another device is
  // indistinguishable from a missing one.
  it("returns RESOURCE_NOT_FOUND when the number belongs to another device", async () => {
    const gateway = new FakeAgentNumberGateway({ knownDeviceIds: [DEVICE_ID, OTHER_DEVICE_ID] });
    seedNumber(gateway, { deviceId: OTHER_DEVICE_ID });
    const result = await makeService(gateway).setAvailability(availabilityInput());
    expect(result.statusCode).toBe(404);
    expect("error" in result.body && result.body.error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("returns RESOURCE_NOT_FOUND for an unknown number", async () => {
    const gateway = new FakeAgentNumberGateway();
    const result = await makeService(gateway).setAvailability(availabilityInput());
    expect(result.statusCode).toBe(404);
  });

  // Requirement 7.4: a reserved/busy number cannot have its availability changed.
  it("guards a reserved number with STATE_CONFLICT", async () => {
    const gateway = new FakeAgentNumberGateway();
    seedNumber(gateway, { status: "reserved" });
    const result = await makeService(gateway).setAvailability(availabilityInput());
    expect(result.statusCode).toBe(409);
    expect("error" in result.body && result.body.error.code).toBe("STATE_CONFLICT");
  });

  it("disables an idle number when requested (enabled=false, slot cleared)", async () => {
    const gateway = new FakeAgentNumberGateway();
    seedNumber(gateway, { status: "offline" });
    const result = await makeService(gateway).setAvailability(
      availabilityInput({ requested: "disabled" }),
    );
    expect(result.statusCode).toBe(200);
    expect("data" in result.body && result.body.data.status).toBe("disabled");
    const stored = gateway.numbers.get("num-1");
    expect(stored?.enabled).toBe(false);
    expect(stored?.activeCanonicalNumber).toBeNull();
  });

  // Effective-state enforcement (requirement 7.3): "available" only becomes
  // available when the domain agrees (device live + active offer + no order).
  it("promotes to available when the device is live with an active offer", async () => {
    const gateway = new FakeAgentNumberGateway({ deviceLive: true, hasActiveOffer: true });
    seedNumber(gateway, { status: "offline" });
    const result = await makeService(gateway).setAvailability(
      availabilityInput({ requested: "available" }),
    );
    expect("data" in result.body && result.body.data.status).toBe("available");
  });

  it("keeps a requested-available number offline when the device is not live", async () => {
    const gateway = new FakeAgentNumberGateway({ deviceLive: false, hasActiveOffer: true });
    seedNumber(gateway, { status: "offline" });
    const result = await makeService(gateway).setAvailability(
      availabilityInput({ requested: "available" }),
    );
    // The domain resolves the effective state; the request cannot force it.
    expect("data" in result.body && result.body.data.status).toBe("offline");
  });

  it("keeps a requested-available number offline without an active offer", async () => {
    const gateway = new FakeAgentNumberGateway({ deviceLive: true, hasActiveOffer: false });
    seedNumber(gateway, { status: "offline" });
    const result = await makeService(gateway).setAvailability(
      availabilityInput({ requested: "available" }),
    );
    expect("data" in result.body && result.body.data.status).toBe("offline");
  });

  it("parks an available number offline when requested offline", async () => {
    const gateway = new FakeAgentNumberGateway();
    seedNumber(gateway, { status: "available" });
    const result = await makeService(gateway).setAvailability(
      availabilityInput({ requested: "offline" }),
    );
    expect("data" in result.body && result.body.data.status).toBe("offline");
    expect(gateway.historyCount).toBe(1);
  });

  it("re-enables a disabled number back to offline when requested available", async () => {
    const gateway = new FakeAgentNumberGateway({ deviceLive: false });
    seedNumber(gateway, { status: "disabled", enabled: false, activeCanonicalNumber: null });
    const result = await makeService(gateway).setAvailability(
      availabilityInput({ requested: "available" }),
    );
    expect(result.statusCode).toBe(200);
    const stored = gateway.numbers.get("num-1");
    expect(stored?.enabled).toBe(true);
    // Device not live, so the effective state is offline, not available.
    expect(stored?.status).toBe("offline");
    expect(stored?.activeCanonicalNumber).toBe("+6281234567890");
  });
});
