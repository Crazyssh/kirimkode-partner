import { beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedPrincipal } from "@domain/task-7-2";

import { toSessionContext, type SessionContext } from "../authorization/session-context";
import { DeviceManagementService } from "./device-management-service";
import type {
  AuditWriteInput,
  DeviceCredentialFactory,
  DeviceManagementGateway,
  DeviceManagementTransaction,
  DeviceStatusChange,
  DeviceView,
  IssuedAgentCredential,
  NewCredentialRecord,
  NewDeviceRecord,
  PartnerGateView,
} from "./ports";

// --- deterministic test doubles ------------------------------------------

const PARTNER_A = "00000000-0000-4000-8000-00000000000a";
const PARTNER_B = "00000000-0000-4000-8000-00000000000b";
const OWNER_ID = "00000000-0000-4000-8000-0000000000a1";
const MEMBER_ID = "00000000-0000-4000-8000-0000000000a2";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

const VALID_CAPABILITIES = {
  sms: true,
  notification: false,
  resend: false,
  operator: null,
  slots: 1,
} as const;

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

class FakeCredentialFactory implements DeviceCredentialFactory {
  private n = 0;
  readonly issued: Array<{ deviceId: string; secret: string }> = [];
  issue(deviceId: string): IssuedAgentCredential {
    this.n += 1;
    const secret = `secret-${this.n}`;
    this.issued.push({ deviceId, secret });
    return { publicId: `pub-${this.n}`, secret, secretHash: this.hashSecret(deviceId, secret) };
  }
  hashSecret(deviceId: string, secret: string): string {
    return `hash(${deviceId}:${secret})`;
  }
}

interface StoredCredential {
  readonly id: string;
  readonly deviceId: string;
  readonly publicId: string;
  readonly secretHash: string;
  status: "active" | "revoked";
  revokedAtEpochMs: number | null;
}

/** In-memory device/credential store + audit log shared across a fake tx. */
class FakeGateway implements DeviceManagementGateway {
  readonly devices = new Map<string, DeviceView>();
  readonly credentials: StoredCredential[] = [];
  readonly audits: AuditWriteInput[] = [];
  partnerGate: PartnerGateView | null = { status: "approved", simulatorAllowed: false };

  seedDevice(device: DeviceView): void {
    this.devices.set(device.id, device);
  }

  async runInTenant<T>(
    tenant: { readonly partnerId: string },
    work: (tx: DeviceManagementTransaction) => Promise<T>,
  ): Promise<T> {
    const devices = this.devices;
    const credentials = this.credentials;
    const audits = this.audits;
    const gate = this.partnerGate;
    const tx: DeviceManagementTransaction = {
      async loadPartnerGate(): Promise<PartnerGateView | null> {
        // Only the caller's own partner exists in this fake tenant.
        return tenant.partnerId === PARTNER_A ? gate : null;
      },
      async findDeviceById(id: string): Promise<DeviceView | null> {
        const found = devices.get(id);
        if (!found || found.partnerId !== tenant.partnerId) return null;
        return found;
      },
      async createDevice(record: NewDeviceRecord): Promise<DeviceView> {
        const created: DeviceView = {
          id: record.id,
          partnerId: tenant.partnerId,
          type: record.type,
          label: record.label,
          effectiveStatus: "offline",
          disabledAtEpochMs: null,
          lastSeenAtEpochMs: null,
          agentVersion: null,
          capabilities: record.capabilities,
        };
        devices.set(created.id, created);
        return created;
      },
      async updateDeviceStatus(id: string, change: DeviceStatusChange): Promise<DeviceView> {
        const existing = devices.get(id);
        if (!existing || existing.partnerId !== tenant.partnerId) {
          throw new Error("not found");
        }
        const updated: DeviceView = {
          ...existing,
          effectiveStatus: change.effectiveStatus,
          disabledAtEpochMs: change.disabledAtEpochMs,
        };
        devices.set(id, updated);
        return updated;
      },
      async createCredential(record: NewCredentialRecord): Promise<void> {
        credentials.push({
          id: record.id,
          deviceId: record.deviceId,
          publicId: record.publicId,
          secretHash: record.secretHash,
          status: "active",
          revokedAtEpochMs: null,
        });
      },
      async revokeActiveCredentials(deviceId: string, revokedAtEpochMs: number): Promise<number> {
        let count = 0;
        for (const credential of credentials) {
          if (credential.deviceId === deviceId && credential.status === "active") {
            credential.status = "revoked";
            credential.revokedAtEpochMs = revokedAtEpochMs;
            count += 1;
          }
        }
        return count;
      },
      async recordAudit(input: AuditWriteInput): Promise<void> {
        audits.push(input);
      },
    };
    return work(tx);
  }
}

function principal(over: Partial<AuthenticatedPrincipal>): AuthenticatedPrincipal {
  return { memberId: OWNER_ID, partnerId: PARTNER_A, role: "owner", securityVersion: 1, ...over };
}

function context(over: Partial<AuthenticatedPrincipal> = {}): SessionContext {
  return toSessionContext(principal(over));
}

describe("DeviceManagementService", () => {
  let gateway: FakeGateway;
  let credentialFactory: FakeCredentialFactory;
  let service: DeviceManagementService;

  function makeService(environment = "test"): DeviceManagementService {
    return new DeviceManagementService({
      gateway,
      credentialFactory,
      clock: new FakeClock(),
      idGenerator: new SequentialIds(),
      environment,
    });
  }

  beforeEach(() => {
    gateway = new FakeGateway();
    credentialFactory = new FakeCredentialFactory();
    service = makeService();
  });

  // Requirement 5.1 / 5.2: approved partner creates a simulator; the 256-bit
  // secret is returned once and only its hash is stored.
  it("creates a device and issues a one-time agent credential", async () => {
    const result = await service.createDevice({
      caller: context(),
      type: "simulator",
      label: "Sim 1",
      capabilities: VALID_CAPABILITIES,
      requestId: REQUEST_ID,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.device.type).toBe("simulator");
    expect(result.device.effectiveStatus).toBe("offline");
    expect(result.credential).toBeDefined();
    // Token is `<publicId>.<secret>`; the raw secret is present exactly here.
    expect(result.credential?.agentToken).toBe("pub-1.secret-1");

    // Storage holds only the hash, never the raw secret.
    expect(gateway.credentials).toHaveLength(1);
    expect(gateway.credentials[0].status).toBe("active");
    expect(gateway.credentials[0].secretHash).toBe("hash(00000000-0000-4000-8000-000000000001:secret-1)");

    // Device + credential changes both audited.
    const actions = gateway.audits.map((a) => a.descriptor.action);
    expect(actions).toContain("device.changed");
    expect(actions).toContain("credential.changed");
    // The one-time secret never leaks into the audit metadata.
    expect(JSON.stringify(gateway.audits)).not.toContain("secret-1");
  });

  // Requirement 5.3: the full contract enum is accepted.
  it("accepts every contract device type", async () => {
    gateway.partnerGate = { status: "approved", simulatorAllowed: true };
    for (const type of ["android", "modem", "goip", "api"] as const) {
      const result = await service.createDevice({
        caller: context(),
        type,
        label: `dev-${type}`,
        capabilities: VALID_CAPABILITIES,
        requestId: REQUEST_ID,
      });
      expect(result.ok).toBe(true);
    }
  });

  it("rejects an unknown device type as validation", async () => {
    const result = await service.createDevice({
      caller: context(),
      type: "toaster",
      label: "bad",
      capabilities: VALID_CAPABILITIES,
      requestId: REQUEST_ID,
    });
    expect(result).toEqual({ ok: false, reason: "validation", code: "INVALID_DEVICE_TYPE" });
    expect(gateway.devices.size).toBe(0);
  });

  it("rejects invalid capabilities as validation", async () => {
    const result = await service.createDevice({
      caller: context(),
      type: "simulator",
      label: "sim",
      capabilities: { sms: true, notification: false, resend: false, slots: 0 },
      requestId: REQUEST_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "validation") throw new Error("expected validation failure");
    expect(result.code).toBe("INVALID_CAPABILITY");
  });

  // Requirement 5.1: only approved partners may register devices.
  it("forbids device creation when the partner is not approved", async () => {
    gateway.partnerGate = { status: "pending", simulatorAllowed: false };
    const result = await service.createDevice({
      caller: context(),
      type: "simulator",
      label: "sim",
      capabilities: VALID_CAPABILITIES,
      requestId: REQUEST_ID,
    });
    expect(result).toEqual({ ok: false, reason: "partner_not_approved" });
    expect(gateway.devices.size).toBe(0);
    expect(gateway.audits).toHaveLength(0);
  });

  // Requirement 17.1: simulator creation is gated in production unless allowed.
  it("blocks simulator creation in production without the allowlist flag", async () => {
    service = makeService("production");
    gateway.partnerGate = { status: "approved", simulatorAllowed: false };
    const result = await service.createDevice({
      caller: context(),
      type: "simulator",
      label: "sim",
      capabilities: VALID_CAPABILITIES,
      requestId: REQUEST_ID,
    });
    expect(result).toEqual({ ok: false, reason: "simulator_not_allowed" });
  });

  it("allows simulator creation in production when the partner is allowlisted", async () => {
    service = makeService("production");
    gateway.partnerGate = { status: "approved", simulatorAllowed: true };
    const result = await service.createDevice({
      caller: context(),
      type: "simulator",
      label: "sim",
      capabilities: VALID_CAPABILITIES,
      requestId: REQUEST_ID,
    });
    expect(result.ok).toBe(true);
  });

  it("forbids a non-owner without manage_inventory? members may manage inventory", async () => {
    // A `member` role IS permitted to manage inventory (task 5.1 matrix).
    const result = await service.createDevice({
      caller: context({ role: "member", memberId: MEMBER_ID }),
      type: "simulator",
      label: "sim",
      capabilities: VALID_CAPABILITIES,
      requestId: REQUEST_ID,
    });
    expect(result.ok).toBe(true);
  });

  // Requirement 5.6: disable is fail-closed and audited.
  it("disables a device and audits the change", async () => {
    gateway.seedDevice(deviceView({ effectiveStatus: "online" }));
    const result = await service.disableDevice({
      caller: context(),
      deviceId: DEVICE_ID,
      reason: "compromised",
      requestId: REQUEST_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.device.effectiveStatus).toBe("disabled");
    expect(result.device.disabledAtEpochMs).not.toBeNull();
    const audit = gateway.audits.at(-1);
    expect(audit?.descriptor.action).toBe("device.changed");
    expect(audit?.descriptor.safeMetadata).toMatchObject({ change: "disabled", reason: "compromised" });
  });

  it("re-enables a disabled device back to offline", async () => {
    gateway.seedDevice(deviceView({ effectiveStatus: "disabled", disabledAtEpochMs: 1 }));
    const result = await service.reEnableDevice({
      caller: context(),
      deviceId: DEVICE_ID,
      requestId: REQUEST_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.device.effectiveStatus).toBe("offline");
    expect(result.device.disabledAtEpochMs).toBeNull();
  });

  // Requirement 5.5: rotation revokes the old credential immediately and issues
  // a new one (grace period zero).
  it("rotates a credential, revoking the previous one immediately", async () => {
    gateway.seedDevice(deviceView({}));
    gateway.credentials.push({
      id: "cred-old",
      deviceId: DEVICE_ID,
      publicId: "pub-old",
      secretHash: "hash-old",
      status: "active",
      revokedAtEpochMs: null,
    });

    const result = await service.rotateCredential({
      caller: context(),
      deviceId: DEVICE_ID,
      requestId: REQUEST_ID,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential?.agentToken).toBe("pub-1.secret-1");
    // Old credential revoked, exactly one active remains.
    const old = gateway.credentials.find((c) => c.id === "cred-old");
    expect(old?.status).toBe("revoked");
    expect(old?.revokedAtEpochMs).not.toBeNull();
    expect(gateway.credentials.filter((c) => c.status === "active")).toHaveLength(1);
    expect(gateway.audits.at(-1)?.descriptor.action).toBe("credential.changed");
  });

  // Requirement 5.5: revoke invalidates active credentials without a replacement.
  it("revokes credentials without issuing a new secret", async () => {
    gateway.seedDevice(deviceView({}));
    gateway.credentials.push({
      id: "cred-1",
      deviceId: DEVICE_ID,
      publicId: "pub",
      secretHash: "hash",
      status: "active",
      revokedAtEpochMs: null,
    });

    const result = await service.revokeCredential({
      caller: context(),
      deviceId: DEVICE_ID,
      requestId: REQUEST_ID,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential).toBeUndefined();
    expect(gateway.credentials.every((c) => c.status === "revoked")).toBe(true);
  });

  it("treats a cross-tenant device as not found", async () => {
    gateway.seedDevice(deviceView({ partnerId: PARTNER_B }));
    const result = await service.disableDevice({
      caller: context(),
      deviceId: DEVICE_ID,
      requestId: REQUEST_ID,
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

const DEVICE_ID = "00000000-0000-4000-8000-0000000000d1";

function deviceView(over: Partial<DeviceView>): DeviceView {
  return {
    id: DEVICE_ID,
    partnerId: PARTNER_A,
    type: "simulator",
    label: "Sim",
    effectiveStatus: "offline",
    disabledAtEpochMs: null,
    lastSeenAtEpochMs: null,
    agentVersion: null,
    capabilities: { ...VALID_CAPABILITIES },
    ...over,
  };
}
