import { describe, expect, it } from "vitest";

import { RESOURCE_ADMIN_PERMISSION, type AuthenticatedAdmin } from "@domain/task-7-5";

import { AdminResourceService } from "./admin-resource-service";
import type {
  AdminDeviceRef,
  AdminNumberHistoryInput,
  AdminNumberRef,
  AdminOfferRef,
  AdminResourceAuditInput,
  AdminResourceMutationTransaction,
} from "./resource-ports";
import type { OperationalQueryService } from "@application/portal";

const PARTNER_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const NUMBER_ID = "33333333-3333-4333-8333-333333333333";
const OFFER_ID = "44444444-4444-4444-8444-444444444444";

function admin(permissions: readonly string[]): AuthenticatedAdmin {
  return { adminId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", permissions, securityVersion: 1 };
}

/**
 * In-memory {@link AdminResourceMutationTransaction} that records the calls made
 * against it so the test can assert the disable is non-destructive (a status
 * change + preserved history) and that a `partner_admin` audit event is written.
 */
class FakeTx implements AdminResourceMutationTransaction {
  device: AdminDeviceRef | null;
  number: AdminNumberRef | null;
  offer: AdminOfferRef | null;
  disabledDevice = false;
  disabledNumber = false;
  disabledOffer = false;
  history: AdminNumberHistoryInput[] = [];
  audits: AdminResourceAuditInput[] = [];

  constructor(opts: {
    device?: AdminDeviceRef | null;
    number?: AdminNumberRef | null;
    offer?: AdminOfferRef | null;
  }) {
    this.device = opts.device ?? null;
    this.number = opts.number ?? null;
    this.offer = opts.offer ?? null;
  }

  findDevice(): Promise<AdminDeviceRef | null> {
    return Promise.resolve(this.device);
  }
  disableDevice(): Promise<void> {
    this.disabledDevice = true;
    return Promise.resolve();
  }
  findNumber(): Promise<AdminNumberRef | null> {
    return Promise.resolve(this.number);
  }
  disableNumber(): Promise<void> {
    this.disabledNumber = true;
    return Promise.resolve();
  }
  appendNumberHistory(record: AdminNumberHistoryInput): Promise<void> {
    this.history.push(record);
    return Promise.resolve();
  }
  findOffer(): Promise<AdminOfferRef | null> {
    return Promise.resolve(this.offer);
  }
  disableOffer(): Promise<void> {
    this.disabledOffer = true;
    return Promise.resolve();
  }
  recordAudit(input: AdminResourceAuditInput): Promise<void> {
    this.audits.push(input);
    return Promise.resolve();
  }
}

function serviceWith(tx: FakeTx): AdminResourceService {
  let counter = 0;
  return new AdminResourceService({
    reads: {
      listPartners: () => Promise.resolve([]),
      loadPartnerHeader: () => Promise.resolve(null),
      listRedactedSms: () => Promise.resolve([]),
    },
    mutations: {
      runForPartner: (_partnerId, work) => work(tx),
    },
    // Not exercised by the disable tests.
    operational: {} as unknown as OperationalQueryService,
    clock: { nowEpochMs: () => 1_700_000_000_000 },
    idGenerator: { uuid: () => `id-${++counter}` },
  });
}

const baseInput = {
  partnerId: PARTNER_ID,
  reason: "risiko penipuan",
  requestId: "55555555-5555-4555-8555-555555555555",
};

describe("AdminResourceService disable commands", () => {
  it("forbids disabling without the resource:admin permission", async () => {
    const tx = new FakeTx({ device: { id: DEVICE_ID, effectiveStatus: "online" } });
    const service = serviceWith(tx);

    const outcome = await service.disableDevice({
      admin: admin([]),
      resourceId: DEVICE_ID,
      ...baseInput,
    });

    expect(outcome).toEqual({ ok: false, reason: "forbidden" });
    expect(tx.disabledDevice).toBe(false);
    expect(tx.audits).toHaveLength(0);
  });

  it("rejects an empty reason", async () => {
    const tx = new FakeTx({ device: { id: DEVICE_ID, effectiveStatus: "online" } });
    const service = serviceWith(tx);

    const outcome = await service.disableDevice({
      admin: admin([RESOURCE_ADMIN_PERMISSION]),
      resourceId: DEVICE_ID,
      partnerId: PARTNER_ID,
      reason: "   ",
      requestId: baseInput.requestId,
    });

    expect(outcome).toEqual({ ok: false, reason: "validation", code: "INVALID_REASON" });
  });

  it("returns not_found for a missing device", async () => {
    const tx = new FakeTx({ device: null });
    const service = serviceWith(tx);

    const outcome = await service.disableDevice({
      admin: admin([RESOURCE_ADMIN_PERMISSION]),
      resourceId: DEVICE_ID,
      ...baseInput,
    });

    expect(outcome).toEqual({ ok: false, reason: "not_found" });
  });

  it("disables a device and writes a partner_admin audit event", async () => {
    const tx = new FakeTx({ device: { id: DEVICE_ID, effectiveStatus: "online" } });
    const service = serviceWith(tx);

    const outcome = await service.disableDevice({
      admin: admin([RESOURCE_ADMIN_PERMISSION]),
      resourceId: DEVICE_ID,
      ...baseInput,
    });

    expect(outcome).toEqual({ ok: true });
    expect(tx.disabledDevice).toBe(true);
    expect(tx.audits).toHaveLength(1);
    expect(tx.audits[0]?.descriptor.actorType).toBe("partner_admin");
    expect(tx.audits[0]?.descriptor.action).toBe("device.changed");
  });

  it("guards disabling a number that is busy with an active order", async () => {
    const tx = new FakeTx({ number: { id: NUMBER_ID, status: "busy" } });
    const service = serviceWith(tx);

    const outcome = await service.disableNumber({
      admin: admin([RESOURCE_ADMIN_PERMISSION]),
      resourceId: NUMBER_ID,
      ...baseInput,
    });

    expect(outcome).toEqual({ ok: false, reason: "state_guarded", status: "busy" });
    expect(tx.disabledNumber).toBe(false);
    expect(tx.history).toHaveLength(0);
  });

  it("disables an idle number and preserves history via a state-history entry", async () => {
    const tx = new FakeTx({ number: { id: NUMBER_ID, status: "available" } });
    const service = serviceWith(tx);

    const outcome = await service.disableNumber({
      admin: admin([RESOURCE_ADMIN_PERMISSION]),
      resourceId: NUMBER_ID,
      ...baseInput,
    });

    expect(outcome).toEqual({ ok: true });
    expect(tx.disabledNumber).toBe(true);
    expect(tx.history).toHaveLength(1);
    expect(tx.history[0]?.fromStatus).toBe("available");
    expect(tx.history[0]?.toStatus).toBe("disabled");
    expect(tx.audits[0]?.descriptor.actorType).toBe("partner_admin");
  });

  it("disables an offer", async () => {
    const tx = new FakeTx({ offer: { id: OFFER_ID, status: "active" } });
    const service = serviceWith(tx);

    const outcome = await service.disableOffer({
      admin: admin([RESOURCE_ADMIN_PERMISSION]),
      resourceId: OFFER_ID,
      ...baseInput,
    });

    expect(outcome).toEqual({ ok: true });
    expect(tx.disabledOffer).toBe(true);
    expect(tx.audits[0]?.descriptor.action).toBe("offer.changed");
  });
});
