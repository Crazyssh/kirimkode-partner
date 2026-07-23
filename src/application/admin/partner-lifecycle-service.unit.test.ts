import { beforeEach, describe, expect, it } from "vitest";

import { PARTNER_LIFECYCLE_PERMISSION, type AuthenticatedAdmin } from "@domain/task-7-5";
import type { PartnerStatus } from "@domain/task-5-1/partner-status";

import { PartnerLifecycleService } from "./partner-lifecycle-service";
import type {
  AdminAuditWriteInput,
  PartnerLifecycleGateway,
  PartnerLifecycleTransaction,
  PartnerStatusView,
} from "./ports";

const PARTNER_ID = "00000000-0000-4000-8000-00000000000a";
const ADMIN_ID = "00000000-0000-4000-8000-0000000000f1";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

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
    return `00000000-0000-4000-8000-${this.n.toString(16).padStart(12, "0")}`;
  }
}

/** In-memory partner store + audit log shared across a fake transaction. */
class FakeLifecycleGateway implements PartnerLifecycleGateway {
  readonly partners = new Map<string, PartnerStatus>();
  readonly audits: AdminAuditWriteInput[] = [];
  /** Optional hook to simulate a concurrent status change during a command. */
  onBeforeUpdate?: () => void;

  seed(partnerId: string, status: PartnerStatus): void {
    this.partners.set(partnerId, status);
  }

  async runForPartner<T>(
    _partnerId: string,
    work: (tx: PartnerLifecycleTransaction) => Promise<T>,
  ): Promise<T> {
    // Arrow-function properties capture the gateway instance lexically, so the
    // fake transaction reads/writes the shared store without aliasing `this`.
    const tx: PartnerLifecycleTransaction = {
      loadStatus: async (partnerId: string): Promise<PartnerStatusView | null> => {
        const status = this.partners.get(partnerId);
        return status === undefined ? null : { partnerId, status };
      },
      updateStatus: async (input): Promise<boolean> => {
        this.onBeforeUpdate?.();
        const current = this.partners.get(input.partnerId);
        if (current !== input.expectedStatus) return false;
        this.partners.set(input.partnerId, input.nextStatus);
        return true;
      },
      recordAudit: async (input: AdminAuditWriteInput): Promise<void> => {
        this.audits.push(input);
      },
    };
    return work(tx);
  }
}

function admin(over: Partial<AuthenticatedAdmin> = {}): AuthenticatedAdmin {
  return {
    adminId: ADMIN_ID,
    permissions: [PARTNER_LIFECYCLE_PERMISSION],
    securityVersion: 1,
    ...over,
  };
}

describe("PartnerLifecycleService", () => {
  let gateway: FakeLifecycleGateway;
  let service: PartnerLifecycleService;

  beforeEach(() => {
    gateway = new FakeLifecycleGateway();
    service = new PartnerLifecycleService({
      gateway,
      clock: new FakeClock(),
      idGenerator: new SequentialIds(),
    });
  });

  // Requirement 3.2 / 3.5: approve moves pending → approved and audits it.
  it("approves a pending partner and writes a complete audit event", async () => {
    gateway.seed(PARTNER_ID, "pending");

    const result = await service.execute({
      admin: admin(),
      partnerId: PARTNER_ID,
      command: "approve",
      reason: "KYC ok",
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: true, status: "approved" });
    expect(gateway.partners.get(PARTNER_ID)).toBe("approved");

    expect(gateway.audits).toHaveLength(1);
    const audit = gateway.audits[0];
    expect(audit.partnerId).toBe(PARTNER_ID);
    expect(audit.descriptor.actorType).toBe("partner_admin");
    expect(audit.descriptor.actorRef).toBe(ADMIN_ID);
    expect(audit.descriptor.action).toBe("partner.status_changed");
    expect(audit.descriptor.targetId).toBe(PARTNER_ID);
    expect(audit.descriptor.safeMetadata).toMatchObject({
      previousStatus: "pending",
      nextStatus: "approved",
      reason: "KYC ok",
    });
    expect(audit.descriptor.occurredAtEpochMs).toBe(1_700_000_000_000);
  });

  // Requirement 3.1: the full state machine drives each command.
  it("supports reject, suspend, and reapprove across the state machine", async () => {
    gateway.seed(PARTNER_ID, "pending");
    expect((await service.execute({
      admin: admin(),
      partnerId: PARTNER_ID,
      command: "reject",
      reason: "fraud",
      requestId: REQUEST_ID,
    })).ok).toBe(true);
    expect(gateway.partners.get(PARTNER_ID)).toBe("rejected");

    gateway.seed(PARTNER_ID, "approved");
    expect((await service.execute({
      admin: admin(),
      partnerId: PARTNER_ID,
      command: "suspend",
      reason: "abuse review",
      requestId: REQUEST_ID,
    })).ok).toBe(true);
    expect(gateway.partners.get(PARTNER_ID)).toBe("suspended");

    expect((await service.execute({
      admin: admin(),
      partnerId: PARTNER_ID,
      command: "reapprove",
      reason: "cleared",
      requestId: REQUEST_ID,
    })).ok).toBe(true);
    expect(gateway.partners.get(PARTNER_ID)).toBe("approved");
  });

  // Requirement 16.2: lifecycle commands require the admin permission.
  it("forbids an admin without the lifecycle permission and writes nothing", async () => {
    gateway.seed(PARTNER_ID, "pending");

    const result = await service.execute({
      admin: admin({ permissions: [] }),
      partnerId: PARTNER_ID,
      command: "approve",
      reason: "KYC ok",
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(gateway.partners.get(PARTNER_ID)).toBe("pending");
    expect(gateway.audits).toHaveLength(0);
  });

  it("rejects a command illegal for the current status without side effects", async () => {
    gateway.seed(PARTNER_ID, "approved");

    const result = await service.execute({
      admin: admin(),
      partnerId: PARTNER_ID,
      command: "approve", // approve only applies to pending
      reason: "already approved",
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_command" });
    expect(gateway.partners.get(PARTNER_ID)).toBe("approved");
    expect(gateway.audits).toHaveLength(0);
  });

  it("rejects an unknown command as a validation error", async () => {
    gateway.seed(PARTNER_ID, "pending");

    const result = await service.execute({
      admin: admin(),
      partnerId: PARTNER_ID,
      command: "delete",
      reason: "x",
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: false, reason: "validation", code: "INVALID_COMMAND" });
  });

  it("requires a non-empty reason", async () => {
    gateway.seed(PARTNER_ID, "pending");

    const result = await service.execute({
      admin: admin(),
      partnerId: PARTNER_ID,
      command: "approve",
      reason: "   ",
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: false, reason: "validation", code: "INVALID_REASON" });
    expect(gateway.audits).toHaveLength(0);
  });

  it("returns not_found for an unknown partner", async () => {
    const result = await service.execute({
      admin: admin(),
      partnerId: PARTNER_ID,
      command: "approve",
      reason: "KYC ok",
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  // A concurrent status change between the read and the CAS update is a conflict.
  it("returns conflict when the status changes underneath the command", async () => {
    gateway.seed(PARTNER_ID, "pending");
    gateway.onBeforeUpdate = () => {
      // Simulate another admin approving first.
      gateway.partners.set(PARTNER_ID, "approved");
    };

    const result = await service.execute({
      admin: admin(),
      partnerId: PARTNER_ID,
      command: "approve",
      reason: "KYC ok",
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: false, reason: "conflict" });
    expect(gateway.audits).toHaveLength(0);
  });
});
