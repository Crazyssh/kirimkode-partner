import { beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedPrincipal } from "@domain/task-7-2";
import { ConcurrencyConflictError } from "@infrastructure/database";

import { toSessionContext, type SessionContext } from "../authorization/session-context";
import { NumberManagementService } from "./number-management-service";
import {
  ActiveNumberConflictError,
  type AuditWriteInput,
  type DeviceRef,
  type NewNumberRecord,
  type NumberManagementGateway,
  type NumberManagementTransaction,
  type NumberStateHistoryRecord,
  type NumberStatus,
  type NumberStatusMutation,
  type NumberView,
} from "./ports";

// --- deterministic test doubles ------------------------------------------

const PARTNER_A = "00000000-0000-4000-8000-00000000000a";
const PARTNER_B = "00000000-0000-4000-8000-00000000000b";
const OWNER_ID = "00000000-0000-4000-8000-0000000000a1";
const MEMBER_ID = "00000000-0000-4000-8000-0000000000a2";
const DEVICE_A = "00000000-0000-4000-8000-0000000000d1";
const DEVICE_A2 = "00000000-0000-4000-8000-0000000000d2";
const DEVICE_B = "00000000-0000-4000-8000-0000000000db";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

const CANONICAL = "+6281234567890";

class FakeClock {
  constructor(public value = 1_700_000_000_000) {}
  nowEpochMs(): number {
    return this.value;
  }
}

class SequentialIds {
  private n = 0;
  uuid(): string {
    this.n += 1;
    const h = this.n.toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${h}`;
  }
}

interface StoredNumber {
  id: string;
  partnerId: string;
  deviceId: string;
  canonicalNumber: string;
  activeCanonicalNumber: string | null;
  countryCode: string;
  operatorCode: string;
  status: NumberStatus;
  enabled: boolean;
  currentOrderId: string | null;
}

/** In-memory number/device store + history/audit log shared across a fake tx. */
class FakeGateway implements NumberManagementGateway {
  readonly numbers = new Map<string, StoredNumber>();
  /** deviceId -> owning partnerId (models the global device table). */
  readonly devices = new Map<string, string>([
    [DEVICE_A, PARTNER_A],
    [DEVICE_A2, PARTNER_A],
    [DEVICE_B, PARTNER_B],
  ]);
  readonly history: NumberStateHistoryRecord[] = [];
  readonly audits: AuditWriteInput[] = [];
  /**
   * Optional hook fired inside a status/device mutation, right before its
   * compare-and-set check, to simulate a concurrent writer (e.g. a reservation)
   * landing between the service's read and its write.
   */
  raceBefore: ((number: StoredNumber | undefined) => void) | undefined;

  seedNumber(number: StoredNumber): void {
    this.numbers.set(number.id, { ...number });
  }

  async runInTenant<T>(
    tenant: { readonly partnerId: string },
    work: (tx: NumberManagementTransaction) => Promise<T>,
  ): Promise<T> {
    const partnerId = tenant.partnerId;
    const numbers = this.numbers;
    const devices = this.devices;
    const history = this.history;
    const audits = this.audits;
    const raceBefore = this.raceBefore;

    /** Enforce the MVP-global unique active-canonical slot across all tenants. */
    const assertGlobalUnique = (activeCanonical: string | null, selfId: string): void => {
      if (activeCanonical === null) return;
      for (const number of numbers.values()) {
        if (number.id !== selfId && number.activeCanonicalNumber === activeCanonical) {
          throw new ActiveNumberConflictError();
        }
      }
    };

    const tx: NumberManagementTransaction = {
      async findDeviceRef(deviceId: string): Promise<DeviceRef | null> {
        return devices.get(deviceId) === partnerId ? { id: deviceId } : null;
      },
      async findNumberById(id: string): Promise<NumberView | null> {
        const found = numbers.get(id);
        if (!found || found.partnerId !== partnerId) return null;
        return toView(found);
      },
      async listTenantActiveNumbers() {
        return [...numbers.values()]
          .filter((n) => n.partnerId === partnerId && n.status !== "disabled")
          .map((n) => ({ id: n.id, canonicalNumber: n.canonicalNumber, status: n.status }));
      },
      async insertNumber(record: NewNumberRecord): Promise<NumberView> {
        assertGlobalUnique(record.activeCanonicalNumber, record.id);
        const stored: StoredNumber = {
          id: record.id,
          partnerId,
          deviceId: record.deviceId,
          canonicalNumber: record.canonicalNumber,
          activeCanonicalNumber: record.activeCanonicalNumber,
          countryCode: record.countryCode,
          operatorCode: record.operatorCode,
          status: record.status,
          enabled: record.enabled,
          currentOrderId: null,
        };
        numbers.set(stored.id, stored);
        return toView(stored);
      },
      async updateNumberStatus(id: string, mutation: NumberStatusMutation): Promise<NumberView> {
        // Simulate a concurrent writer landing between the read and this write,
        // then evaluate the compare-and-set against the resulting current state
        // (matching the real adapter's `updateMany` predicate).
        raceBefore?.(numbers.get(id));
        const existing = numbers.get(id);
        // Compare-and-set: a row that moved off the expected status (or vanished)
        // matches nothing, which the real adapter surfaces as a concurrency
        // conflict rather than clobbering the newer state.
        if (
          !existing ||
          existing.partnerId !== partnerId ||
          existing.status !== mutation.expectedStatus
        ) {
          throw new ConcurrencyConflictError();
        }
        assertGlobalUnique(mutation.activeCanonicalNumber, id);
        existing.status = mutation.status;
        existing.enabled = mutation.enabled;
        existing.activeCanonicalNumber = mutation.activeCanonicalNumber;
        return toView(existing);
      },
      async moveNumberDevice(
        id: string,
        deviceId: string,
        expectedStatus: NumberStatus,
      ): Promise<NumberView> {
        raceBefore?.(numbers.get(id));
        const existing = numbers.get(id);
        if (!existing || existing.partnerId !== partnerId || existing.status !== expectedStatus) {
          throw new ConcurrencyConflictError();
        }
        existing.deviceId = deviceId;
        return toView(existing);
      },
      async deleteNumberById(id: string): Promise<void> {
        const existing = numbers.get(id);
        if (!existing || existing.partnerId !== partnerId) throw new Error("not found");
        numbers.delete(id);
      },
      async appendStateHistory(record: NumberStateHistoryRecord): Promise<void> {
        history.push(record);
      },
      async recordAudit(input: AuditWriteInput): Promise<void> {
        audits.push(input);
      },
    };
    return work(tx);
  }
}

function toView(n: StoredNumber): NumberView {
  return {
    id: n.id,
    partnerId: n.partnerId,
    deviceId: n.deviceId,
    canonicalNumber: n.canonicalNumber,
    countryCode: n.countryCode,
    operatorCode: n.operatorCode,
    status: n.status,
    enabled: n.enabled,
    hasActiveOrder: n.currentOrderId !== null,
  };
}

function principal(over: Partial<AuthenticatedPrincipal>): AuthenticatedPrincipal {
  return { memberId: OWNER_ID, partnerId: PARTNER_A, role: "owner", securityVersion: 1, ...over };
}

function context(over: Partial<AuthenticatedPrincipal> = {}): SessionContext {
  return toSessionContext(principal(over));
}

function storedNumber(over: Partial<StoredNumber>): StoredNumber {
  return {
    id: "00000000-0000-4000-8000-0000000000f1",
    partnerId: PARTNER_A,
    deviceId: DEVICE_A,
    canonicalNumber: CANONICAL,
    activeCanonicalNumber: CANONICAL,
    countryCode: "ID",
    operatorCode: "any",
    status: "offline",
    enabled: true,
    currentOrderId: null,
    ...over,
  };
}

describe("NumberManagementService", () => {
  let gateway: FakeGateway;
  let service: NumberManagementService;

  beforeEach(() => {
    gateway = new FakeGateway();
    service = new NumberManagementService({
      gateway,
      clock: new FakeClock(),
      idGenerator: new SequentialIds(),
    });
  });

  // Requirement 7.1 / 7.6: register a number on the tenant's device; it starts
  // offline and enabled, claims the active slot, and records state history.
  it("registers a number on the caller's device with state history and audit", async () => {
    const result = await service.registerNumber({
      caller: context(),
      deviceId: DEVICE_A,
      rawNumber: "0812-3456-7890",
      requestId: REQUEST_ID,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.number.canonicalNumber).toBe(CANONICAL);
    expect(result.number.status).toBe("offline");
    expect(result.number.enabled).toBe(true);
    expect(result.number.deviceId).toBe(DEVICE_A);

    // State history: null -> offline (requirement 7.6).
    expect(gateway.history).toHaveLength(1);
    expect(gateway.history[0]).toMatchObject({ fromStatus: null, toStatus: "offline", reason: "registered" });
    expect(gateway.audits.at(-1)?.descriptor.action).toBe("number.changed");
  });

  // Requirement 7.2: equivalent representations normalise to the same canonical
  // and a same-tenant active duplicate is rejected.
  it("rejects a same-tenant active duplicate across equivalent formats", async () => {
    const first = await service.registerNumber({
      caller: context(),
      deviceId: DEVICE_A,
      rawNumber: "+62 812 3456 7890",
      requestId: REQUEST_ID,
    });
    expect(first.ok).toBe(true);

    const second = await service.registerNumber({
      caller: context(),
      deviceId: DEVICE_A2,
      rawNumber: "0812-3456-7890",
      requestId: REQUEST_ID,
    });
    expect(second).toEqual({ ok: false, reason: "duplicate_active_number" });
  });

  // Requirement 7.2: uniqueness of the active canonical number is global on the
  // MVP — a different tenant cannot claim the same active number.
  it("rejects a cross-tenant active duplicate (global uniqueness)", async () => {
    gateway.seedNumber(storedNumber({ id: "00000000-0000-4000-8000-0000000000fb", partnerId: PARTNER_B, deviceId: DEVICE_B }));

    const result = await service.registerNumber({
      caller: context(),
      deviceId: DEVICE_A,
      rawNumber: CANONICAL,
      requestId: REQUEST_ID,
    });
    expect(result).toEqual({ ok: false, reason: "duplicate_active_number" });
  });

  it("rejects an invalid phone number as validation", async () => {
    const result = await service.registerNumber({
      caller: context(),
      deviceId: DEVICE_A,
      rawNumber: "12345",
      requestId: REQUEST_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "validation") throw new Error("expected validation");
    expect(result.code).toBe("INVALID_PHONE_NUMBER");
  });

  it("treats a cross-tenant / missing device as device_not_found", async () => {
    const result = await service.registerNumber({
      caller: context(),
      deviceId: DEVICE_B,
      rawNumber: CANONICAL,
      requestId: REQUEST_ID,
    });
    expect(result).toEqual({ ok: false, reason: "device_not_found" });
    expect(gateway.numbers.size).toBe(0);
  });

  it("allows a member (not only owner) to manage inventory", async () => {
    const result = await service.registerNumber({
      caller: context({ role: "member", memberId: MEMBER_ID }),
      deviceId: DEVICE_A,
      rawNumber: CANONICAL,
      requestId: REQUEST_ID,
    });
    expect(result.ok).toBe(true);
  });

  // Requirement 7.5: disabling an idle number frees the active slot and records
  // history; requirement 7.4: reserved/busy numbers are guarded.
  it("disables an idle number, freeing the active-canonical slot", async () => {
    gateway.seedNumber(storedNumber({ status: "available" }));
    const result = await service.disableNumber({
      caller: context(),
      numberId: "00000000-0000-4000-8000-0000000000f1",
      reason: "maintenance",
      requestId: REQUEST_ID,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.number.status).toBe("disabled");
    expect(result.number.enabled).toBe(false);
    expect(gateway.numbers.get("00000000-0000-4000-8000-0000000000f1")?.activeCanonicalNumber).toBeNull();
    expect(gateway.history.at(-1)).toMatchObject({ fromStatus: "available", toStatus: "disabled" });
  });

  it.each(["reserved", "busy"] as const)(
    "guards disable while the number is %s (requirement 7.4)",
    async (status) => {
      gateway.seedNumber(storedNumber({ status }));
      const result = await service.disableNumber({
        caller: context(),
        numberId: "00000000-0000-4000-8000-0000000000f1",
        requestId: REQUEST_ID,
      });
      expect(result).toEqual({ ok: false, reason: "state_guarded", status });
      // No history/audit written on a guarded no-op.
      expect(gateway.history).toHaveLength(0);
    },
  );

  it("re-enables a disabled number back to offline and reclaims the slot", async () => {
    gateway.seedNumber(storedNumber({ status: "disabled", enabled: false, activeCanonicalNumber: null }));
    const result = await service.reEnableNumber({
      caller: context(),
      numberId: "00000000-0000-4000-8000-0000000000f1",
      requestId: REQUEST_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.number.status).toBe("offline");
    expect(result.number.enabled).toBe(true);
    expect(gateway.numbers.get("00000000-0000-4000-8000-0000000000f1")?.activeCanonicalNumber).toBe(CANONICAL);
  });

  it("rejects re-enabling a non-disabled number", async () => {
    gateway.seedNumber(storedNumber({ status: "offline" }));
    const result = await service.reEnableNumber({
      caller: context(),
      numberId: "00000000-0000-4000-8000-0000000000f1",
      requestId: REQUEST_ID,
    });
    expect(result).toEqual({ ok: false, reason: "validation", code: "NUMBER_NOT_DISABLED" });
  });

  it("rejects re-enable when the canonical number is now taken by another active number", async () => {
    gateway.seedNumber(storedNumber({ status: "disabled", enabled: false, activeCanonicalNumber: null }));
    // Another tenant re-claimed the slot while this one was disabled.
    gateway.seedNumber(
      storedNumber({ id: "00000000-0000-4000-8000-0000000000fb", partnerId: PARTNER_B, deviceId: DEVICE_B, status: "offline" }),
    );
    const result = await service.reEnableNumber({
      caller: context(),
      numberId: "00000000-0000-4000-8000-0000000000f1",
      requestId: REQUEST_ID,
    });
    expect(result).toEqual({ ok: false, reason: "duplicate_active_number" });
  });

  // Requirement 7.4: moving a device is guarded while reserved/busy.
  it("moves an idle number to another device of the same tenant", async () => {
    gateway.seedNumber(storedNumber({ status: "offline" }));
    const result = await service.moveNumberToDevice({
      caller: context(),
      numberId: "00000000-0000-4000-8000-0000000000f1",
      targetDeviceId: DEVICE_A2,
      requestId: REQUEST_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.number.deviceId).toBe(DEVICE_A2);
    // No status change -> no state-history entry, only an audit.
    expect(gateway.history).toHaveLength(0);
    expect(gateway.audits.at(-1)?.descriptor.safeMetadata).toMatchObject({ change: "moved" });
  });

  it.each(["reserved", "busy"] as const)(
    "guards move while the number is %s (requirement 7.4)",
    async (status) => {
      gateway.seedNumber(storedNumber({ status }));
      const result = await service.moveNumberToDevice({
        caller: context(),
        numberId: "00000000-0000-4000-8000-0000000000f1",
        targetDeviceId: DEVICE_A2,
        requestId: REQUEST_ID,
      });
      expect(result).toEqual({ ok: false, reason: "state_guarded", status });
    },
  );

  it("rejects moving to a cross-tenant device", async () => {
    gateway.seedNumber(storedNumber({ status: "offline" }));
    const result = await service.moveNumberToDevice({
      caller: context(),
      numberId: "00000000-0000-4000-8000-0000000000f1",
      targetDeviceId: DEVICE_B,
      requestId: REQUEST_ID,
    });
    expect(result).toEqual({ ok: false, reason: "device_not_found" });
  });

  it("deletes an idle number", async () => {
    gateway.seedNumber(storedNumber({ status: "offline" }));
    const result = await service.deleteNumber({
      caller: context(),
      numberId: "00000000-0000-4000-8000-0000000000f1",
      requestId: REQUEST_ID,
    });
    expect(result.ok).toBe(true);
    expect(gateway.numbers.size).toBe(0);
    expect(gateway.audits.at(-1)?.descriptor.safeMetadata).toMatchObject({ change: "deleted" });
  });

  it.each(["reserved", "busy"] as const)(
    "guards delete while the number is %s (requirement 7.4)",
    async (status) => {
      gateway.seedNumber(storedNumber({ status }));
      const result = await service.deleteNumber({
        caller: context(),
        numberId: "00000000-0000-4000-8000-0000000000f1",
        requestId: REQUEST_ID,
      });
      expect(result).toEqual({ ok: false, reason: "state_guarded", status });
      expect(gateway.numbers.size).toBe(1);
    },
  );

  it("treats a cross-tenant number as not_found", async () => {
    gateway.seedNumber(storedNumber({ partnerId: PARTNER_B, deviceId: DEVICE_B }));
    const result = await service.disableNumber({
      caller: context(),
      numberId: "00000000-0000-4000-8000-0000000000f1",
      requestId: REQUEST_ID,
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  // Requirement 7.4 (concurrency): a reservation that flips the number
  // `available -> reserved` between the service's read and its write must win —
  // the disable's compare-and-set matches no row, so the reservation is never
  // overwritten and the caller is told the number is now guarded.
  describe("compare-and-set under a racing reservation (Bug 1)", () => {
    const NUMBER_ID = "00000000-0000-4000-8000-0000000000f1";

    it("does not overwrite a number reserved between the disable read and write", async () => {
      gateway.seedNumber(storedNumber({ status: "available" }));
      gateway.raceBefore = (n) => {
        if (n) n.status = "reserved";
      };

      const result = await service.disableNumber({
        caller: context(),
        numberId: NUMBER_ID,
        requestId: REQUEST_ID,
      });

      expect(result).toEqual({ ok: false, reason: "state_guarded", status: "reserved" });
      const stored = gateway.numbers.get(NUMBER_ID);
      // The reservation stands: status is not clobbered to disabled and the
      // enabled flag / active slot are untouched.
      expect(stored?.status).toBe("reserved");
      expect(stored?.enabled).toBe(true);
      expect(stored?.activeCanonicalNumber).toBe(CANONICAL);
      // No history/audit was written for the write that never landed.
      expect(gateway.history).toHaveLength(0);
    });

    it("does not re-home a number reserved between the move read and write", async () => {
      gateway.seedNumber(storedNumber({ status: "offline" }));
      gateway.raceBefore = (n) => {
        if (n) n.status = "reserved";
      };

      const result = await service.moveNumberToDevice({
        caller: context(),
        numberId: NUMBER_ID,
        targetDeviceId: DEVICE_A2,
        requestId: REQUEST_ID,
      });

      expect(result).toEqual({ ok: false, reason: "state_guarded", status: "reserved" });
      const stored = gateway.numbers.get(NUMBER_ID);
      // The number was not re-homed and the reservation stands.
      expect(stored?.deviceId).toBe(DEVICE_A);
      expect(stored?.status).toBe("reserved");
    });

    it("reports a re-enable race as NUMBER_NOT_DISABLED without overwriting", async () => {
      gateway.seedNumber(
        storedNumber({ status: "disabled", enabled: false, activeCanonicalNumber: null }),
      );
      // The number is concurrently re-enabled (disabled -> offline) before our write.
      gateway.raceBefore = (n) => {
        if (n) {
          n.status = "offline";
          n.enabled = true;
        }
      };

      const result = await service.reEnableNumber({
        caller: context(),
        numberId: NUMBER_ID,
        requestId: REQUEST_ID,
      });

      expect(result).toEqual({ ok: false, reason: "validation", code: "NUMBER_NOT_DISABLED" });
      // The concurrent re-enable stands; we did not re-run the transition on top.
      expect(gateway.numbers.get(NUMBER_ID)?.status).toBe("offline");
    });

    it("maps a concurrent delete during disable to not_found", async () => {
      gateway.seedNumber(storedNumber({ status: "available" }));
      // The number is deleted out from under the disable between read and write.
      gateway.raceBefore = () => {
        gateway.numbers.delete(NUMBER_ID);
      };

      const result = await service.disableNumber({
        caller: context(),
        numberId: NUMBER_ID,
        requestId: REQUEST_ID,
      });

      expect(result).toEqual({ ok: false, reason: "not_found" });
    });
  });
});
