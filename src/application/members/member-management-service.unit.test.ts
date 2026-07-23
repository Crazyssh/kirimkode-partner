import { beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedPrincipal } from "@domain/task-7-2";

import { toSessionContext, type SessionContext } from "../authorization/session-context";
import { MemberManagementService } from "./member-management-service";
import type {
  AuditWriteInput,
  MemberChanges,
  MemberManagementGateway,
  MemberManagementTransaction,
  MemberView,
  NewMemberRecord,
} from "./ports";

// --- deterministic test doubles ------------------------------------------

const PARTNER_A = "00000000-0000-4000-8000-00000000000a";
const PARTNER_B = "00000000-0000-4000-8000-00000000000b";
const OWNER_ID = "00000000-0000-4000-8000-0000000000a1";
const MEMBER_ID = "00000000-0000-4000-8000-0000000000a2";

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

class FakePasswordHasher {
  hashed: string[] = [];
  async hash(password: string): Promise<string> {
    this.hashed.push(password);
    return `hashed:${password}`;
  }
}

class FakeSecretGenerator {
  private n = 0;
  generate(): string {
    this.n += 1;
    return `secret-${this.n}`;
  }
}

type StoredMember = MemberView;

/** In-memory member store + audit log shared across a fake transaction. */
class FakeGateway implements MemberManagementGateway {
  readonly members = new Map<string, StoredMember>();
  readonly audits: AuditWriteInput[] = [];

  seed(member: StoredMember): void {
    this.members.set(member.id, member);
  }

  async runInTenant<T>(
    tenant: { readonly partnerId: string },
    work: (tx: MemberManagementTransaction) => Promise<T>,
  ): Promise<T> {
    const store = this.members;
    const audits = this.audits;
    const tx: MemberManagementTransaction = {
      async findById(id: string): Promise<MemberView | null> {
        const found = store.get(id);
        // Tenant isolation: another tenant's row is indistinguishable from missing.
        if (!found || found.partnerId !== tenant.partnerId) return null;
        return found;
      },
      async emailExistsGlobally(emailNormalized: string): Promise<boolean> {
        for (const m of store.values()) {
          if (m.emailNormalized === emailNormalized) return true;
        }
        return false;
      },
      async createMember(record: NewMemberRecord): Promise<MemberView> {
        const created: StoredMember = {
          id: record.id,
          partnerId: tenant.partnerId,
          emailNormalized: record.emailNormalized,
          role: record.role,
          status: record.status,
        };
        store.set(created.id, created);
        return created;
      },
      async updateMember(id: string, changes: MemberChanges): Promise<MemberView> {
        const existing = store.get(id);
        if (!existing || existing.partnerId !== tenant.partnerId) {
          throw new Error("not found");
        }
        const updated: StoredMember = {
          ...existing,
          role: changes.role ?? existing.role,
          status: changes.status ?? existing.status,
        };
        store.set(id, updated);
        return updated;
      },
      async recordAudit(input: AuditWriteInput): Promise<void> {
        audits.push(input);
      },
    };
    return work(tx);
  }
}

function principal(over: Partial<AuthenticatedPrincipal>): AuthenticatedPrincipal {
  return {
    memberId: OWNER_ID,
    partnerId: PARTNER_A,
    role: "owner",
    securityVersion: 1,
    ...over,
  };
}

function context(over: Partial<AuthenticatedPrincipal> = {}): SessionContext {
  return toSessionContext(principal(over));
}

describe("MemberManagementService", () => {
  let gateway: FakeGateway;
  let hasher: FakePasswordHasher;
  let service: MemberManagementService;

  beforeEach(() => {
    gateway = new FakeGateway();
    hasher = new FakePasswordHasher();
    service = new MemberManagementService({
      gateway,
      passwordHasher: hasher,
      secretGenerator: new FakeSecretGenerator(),
      clock: new FakeClock(),
      idGenerator: new SequentialIds(),
    });
  });

  // Requirement 4.4 / 4.5: owner may invite; a complete audit event is written.
  it("lets an owner invite a pending member and audits it", async () => {
    const result = await service.invite({
      caller: context(),
      email: "New.Member@Example.com",
      role: "member",
      requestId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.member.emailNormalized).toBe("new.member@example.com");
    expect(result.member.role).toBe("member");
    expect(result.member.status).toBe("pending_verification");
    // Placeholder password was hashed (invitee never receives a usable secret).
    expect(hasher.hashed).toHaveLength(1);

    expect(gateway.audits).toHaveLength(1);
    const audit = gateway.audits[0];
    expect(audit.partnerId).toBe(PARTNER_A);
    expect(audit.descriptor.action).toBe("member.invited");
    expect(audit.descriptor.targetId).toBe(result.member.id);
    expect(audit.descriptor.actorRef).toBe(OWNER_ID);
  });

  // Requirement 4.4: member role cannot manage members.
  it("forbids a non-owner from inviting and writes no changes", async () => {
    const result = await service.invite({
      caller: context({ role: "member", memberId: MEMBER_ID }),
      email: "x@example.com",
      role: "member",
      requestId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(gateway.members.size).toBe(0);
    expect(gateway.audits).toHaveLength(0);
  });

  it("rejects a duplicate email", async () => {
    gateway.seed({
      id: MEMBER_ID,
      partnerId: PARTNER_A,
      emailNormalized: "taken@example.com",
      role: "member",
      status: "active",
    });

    const result = await service.invite({
      caller: context(),
      email: "taken@example.com",
      role: "member",
      requestId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result).toEqual({ ok: false, reason: "email_taken" });
    expect(gateway.audits).toHaveLength(0);
  });

  it("rejects an invalid email as validation failure", async () => {
    const result = await service.invite({
      caller: context(),
      email: "not-an-email",
      role: "member",
      requestId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("validation");
  });

  // Requirement 4.5: role change is audited.
  it("updates a member role and audits the change", async () => {
    gateway.seed({
      id: MEMBER_ID,
      partnerId: PARTNER_A,
      emailNormalized: "m@example.com",
      role: "member",
      status: "active",
    });

    const result = await service.update({
      caller: context(),
      memberId: MEMBER_ID,
      role: "owner",
      requestId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.member.role).toBe("owner");

    const audit = gateway.audits.at(-1);
    expect(audit?.descriptor.action).toBe("member.role_changed");
    expect(audit?.descriptor.safeMetadata).toMatchObject({
      previousRole: "member",
      nextRole: "owner",
    });
  });

  it("prevents a caller from modifying their own membership", async () => {
    const result = await service.update({
      caller: context(),
      memberId: OWNER_ID,
      role: "member",
      requestId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result).toEqual({ ok: false, reason: "self_forbidden" });
    expect(gateway.audits).toHaveLength(0);
  });

  it("treats a cross-tenant target as not found", async () => {
    gateway.seed({
      id: MEMBER_ID,
      partnerId: PARTNER_B,
      emailNormalized: "other@example.com",
      role: "member",
      status: "active",
    });

    const result = await service.update({
      caller: context(),
      memberId: MEMBER_ID,
      status: "suspended",
      requestId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("requires at least one change on update", async () => {
    const result = await service.update({
      caller: context(),
      memberId: MEMBER_ID,
      requestId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("validation");
  });

  // Requirement 4.5: revoke disables the member and is audited.
  it("revokes a member by disabling and audits it", async () => {
    gateway.seed({
      id: MEMBER_ID,
      partnerId: PARTNER_A,
      emailNormalized: "m@example.com",
      role: "member",
      status: "active",
    });

    const result = await service.revoke({
      caller: context(),
      memberId: MEMBER_ID,
      requestId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.member.status).toBe("disabled");

    const audit = gateway.audits.at(-1);
    expect(audit?.descriptor.action).toBe("member.revoked");
    expect(audit?.descriptor.safeMetadata).toMatchObject({ nextStatus: "disabled" });
  });

  it("prevents self-revocation", async () => {
    const result = await service.revoke({
      caller: context(),
      memberId: OWNER_ID,
      requestId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result).toEqual({ ok: false, reason: "self_forbidden" });
  });
});
