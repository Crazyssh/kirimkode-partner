import { describe, expect, it } from "vitest";

import {
  normalizeEmail,
  validateEmail,
  validatePassword,
} from "@domain/task-5-1/identity";
import {
  consumeOneTimeToken,
  issueOneTimeToken,
  ONE_TIME_TOKEN_TTL_MS,
} from "@domain/task-5-1/one-time-token";
import {
  getPartnerSupplyPolicy,
  transitionPartnerStatus,
} from "@domain/task-5-1/partner-status";
import {
  registerPartner,
  RegistrationTransactionPort,
  RegistrationUnitOfWorkPort,
} from "@domain/task-5-1/registration";
import {
  authorizeTenant,
  hasTenantPermission,
  TenantOperation,
} from "@domain/task-5-1/tenant-policy";

class InMemoryRegistrationUnitOfWork implements RegistrationUnitOfWorkPort {
  partners: Array<{ id: string }> = [];
  owners: Array<{ id: string }> = [];
  failOwnerCreation = false;

  async execute<T>(work: (transaction: RegistrationTransactionPort) => Promise<T>): Promise<T> {
    const pendingPartners: Array<{ id: string }> = [];
    const pendingOwners: Array<{ id: string }> = [];
    const transaction: RegistrationTransactionPort = {
      createPartner: async (input) => {
        pendingPartners.push(input);
        return input;
      },
      createOwner: async (input) => {
        if (this.failOwnerCreation) throw new Error("OWNER_INSERT_FAILED");
        pendingOwners.push(input);
        return input;
      },
    };

    try {
      const result = await work(transaction);
      this.partners.push(...pendingPartners);
      this.owners.push(...pendingOwners);
      return result;
    } catch (error) {
      throw error;
    }
  }
}

const HASH = "a".repeat(64);
const NOW = 1_800_000_000_000;

// **Validates: Requirements 2.1, 2.2, 2.4, 2.6, 3.1, 3.2, 3.3, 3.4, 4.2, 4.3, 4.4**
describe("Task 5.1 identity policy", () => {
  it("normalizes compatibility Unicode, surrounding whitespace, and case", () => {
    expect(normalizeEmail("  ＯＷＮＥＲ@Example.COM\t")).toBe("owner@example.com");
    expect(validateEmail("Owner@example.com")).toEqual({ valid: true });
    expect(validateEmail("missing-domain@")).toEqual({ valid: false, code: "EMAIL_INVALID" });
  });

  it("enforces the inclusive 12 to 128 character password boundary", () => {
    expect(validatePassword("x".repeat(11))).toEqual({
      valid: false,
      code: "PASSWORD_TOO_SHORT",
    });
    expect(validatePassword("x".repeat(12))).toEqual({ valid: true });
    expect(validatePassword("🔐".repeat(128))).toEqual({ valid: true });
    expect(validatePassword("x".repeat(129))).toEqual({
      valid: false,
      code: "PASSWORD_TOO_LONG",
    });
  });
});

describe("Task 5.1 atomic registration", () => {
  const command = {
    partnerId: "partner-1",
    ownerMemberId: "member-1",
    legalName: "  PT Partner  ",
    displayName: "  Partner  ",
    ownerEmail: " OWNER@Example.COM ",
    ownerPassword: "correct horse battery staple",
    createdAtEpochMs: NOW,
  } as const;

  it("creates a pending partner and owner in one unit of work", async () => {
    const unitOfWork = new InMemoryRegistrationUnitOfWork();
    const result = await registerPartner(command, {
      passwordHash: { hash: async () => "argon2id:hash" },
      unitOfWork,
    });

    expect(result.partner).toMatchObject({ status: "pending", legalName: "PT Partner" });
    expect(result.owner).toMatchObject({
      partnerId: "partner-1",
      role: "owner",
      emailNormalized: "owner@example.com",
      passwordHash: "argon2id:hash",
    });
    expect(unitOfWork.partners).toHaveLength(1);
    expect(unitOfWork.owners).toHaveLength(1);
  });

  it("rolls back both records when owner creation fails", async () => {
    const unitOfWork = new InMemoryRegistrationUnitOfWork();
    unitOfWork.failOwnerCreation = true;

    await expect(
      registerPartner(command, {
        passwordHash: { hash: async () => "argon2id:hash" },
        unitOfWork,
      }),
    ).rejects.toThrow("OWNER_INSERT_FAILED");
    expect(unitOfWork.partners).toEqual([]);
    expect(unitOfWork.owners).toEqual([]);
  });

  it("rejects invalid credentials before opening the unit of work", async () => {
    const unitOfWork = new InMemoryRegistrationUnitOfWork();
    await expect(
      registerPartner(
        { ...command, ownerEmail: "invalid", ownerPassword: "short" },
        { passwordHash: { hash: async () => "unused" }, unitOfWork },
      ),
    ).rejects.toThrow("EMAIL_INVALID");
    expect(unitOfWork.partners).toEqual([]);
  });
});

describe("Task 5.1 one-time tokens", () => {
  it("uses the designed TTL for each token type", () => {
    const verification = issueOneTimeToken({
      id: "verify-1",
      memberId: "member-1",
      type: "email_verification",
      tokenHash: HASH,
      issuedAtEpochMs: NOW,
    });
    const reset = issueOneTimeToken({
      id: "reset-1",
      memberId: "member-1",
      type: "password_reset",
      tokenHash: HASH,
      issuedAtEpochMs: NOW,
    });

    expect(verification.expiresAtEpochMs - NOW).toBe(ONE_TIME_TOKEN_TTL_MS.email_verification);
    expect(reset.expiresAtEpochMs - NOW).toBe(ONE_TIME_TOKEN_TTL_MS.password_reset);
  });

  it("consumes a matching fresh token exactly once", () => {
    const token = issueOneTimeToken({
      id: "reset-1",
      memberId: "member-1",
      type: "password_reset",
      tokenHash: HASH,
      issuedAtEpochMs: NOW,
    });
    const first = consumeOneTimeToken({
      token,
      expectedMemberId: "member-1",
      expectedType: "password_reset",
      presentedTokenHash: HASH,
      nowEpochMs: NOW + 1,
    });
    expect(first.consumed).toBe(true);
    if (!first.consumed) throw new Error("expected token consumption");

    expect(
      consumeOneTimeToken({
        token: first.token,
        expectedMemberId: "member-1",
        expectedType: "password_reset",
        presentedTokenHash: HASH,
        nowEpochMs: NOW + 2,
      }),
    ).toEqual({ consumed: false, code: "TOKEN_ALREADY_USED" });
  });

  it("rejects a token at its expiry boundary and hides mismatch details", () => {
    const token = issueOneTimeToken({
      id: "reset-1",
      memberId: "member-1",
      type: "password_reset",
      tokenHash: HASH,
      issuedAtEpochMs: NOW,
    });
    expect(
      consumeOneTimeToken({
        token,
        expectedMemberId: "member-1",
        expectedType: "password_reset",
        presentedTokenHash: HASH,
        nowEpochMs: token.expiresAtEpochMs,
      }),
    ).toEqual({ consumed: false, code: "TOKEN_EXPIRED" });
    expect(
      consumeOneTimeToken({
        token,
        expectedMemberId: "other-member",
        expectedType: "email_verification",
        presentedTokenHash: "b".repeat(64),
        nowEpochMs: NOW + 1,
      }),
    ).toEqual({ consumed: false, code: "TOKEN_INVALID" });
  });
});

describe("Task 5.1 tenant policy", () => {
  const sensitiveOperations: TenantOperation[] = [
    "manage_members",
    "manage_api_keys",
    "manage_payout_destination",
    "request_payout",
  ];

  it("allows members operational access but reserves sensitive operations for owners", () => {
    expect(hasTenantPermission("member", "view_operational")).toBe(true);
    expect(hasTenantPermission("member", "manage_inventory")).toBe(true);
    for (const operation of sensitiveOperations) {
      expect(hasTenantPermission("member", operation)).toBe(false);
      expect(hasTenantPermission("owner", operation)).toBe(true);
    }
  });

  it("binds access to the session tenant and returns a generic cross-tenant denial", () => {
    const principal = { memberId: "member-1", partnerId: "partner-1", role: "owner" } as const;
    expect(authorizeTenant(principal, { partnerId: "partner-1" }, "manage_members")).toEqual({
      allowed: true,
      tenant: principal,
    });
    expect(authorizeTenant(principal, { partnerId: "partner-secret" }, "view_operational")).toEqual({
      allowed: false,
      code: "RESOURCE_NOT_FOUND",
    });
    expect(authorizeTenant(principal, null, "view_operational")).toEqual({
      allowed: false,
      code: "RESOURCE_NOT_FOUND",
    });
  });

  it("returns forbidden only for a same-tenant role denial", () => {
    const member = { memberId: "member-1", partnerId: "partner-1", role: "member" } as const;
    expect(authorizeTenant(member, { partnerId: "partner-1" }, "request_payout")).toEqual({
      allowed: false,
      code: "FORBIDDEN",
    });
  });
});

describe("Task 5.1 Partner status", () => {
  it("supports only the designed state transitions", () => {
    const approved = transitionPartnerStatus({
      partnerId: "partner-1",
      currentStatus: "pending",
      nextStatus: "approved",
      actorRef: "admin-ref-hash",
      reason: "  reviewed   and approved  ",
      occurredAtEpochMs: NOW,
    });
    expect(approved).toMatchObject({ changed: true, status: "approved" });
    if (!approved.changed) throw new Error("expected status transition");
    expect(approved.audit.safeMetadata).toEqual({
      previousStatus: "pending",
      nextStatus: "approved",
      reason: "reviewed and approved",
    });
    expect(Object.keys(approved.audit.safeMetadata)).toEqual([
      "previousStatus",
      "nextStatus",
      "reason",
    ]);

    expect(
      transitionPartnerStatus({
        partnerId: "partner-1",
        currentStatus: "rejected",
        nextStatus: "approved",
        actorRef: "admin-ref-hash",
        reason: "not allowed",
        occurredAtEpochMs: NOW,
      }),
    ).toEqual({ changed: false, code: "INVALID_PARTNER_TRANSITION" });
  });

  it("requires a safe reason and complete fixed audit descriptor", () => {
    expect(
      transitionPartnerStatus({
        partnerId: "partner-1",
        currentStatus: "approved",
        nextStatus: "suspended",
        actorRef: "admin-ref-hash",
        reason: " ",
        occurredAtEpochMs: NOW,
      }),
    ).toEqual({ changed: false, code: "INVALID_PARTNER_TRANSITION" });

    const suspended = transitionPartnerStatus({
      partnerId: "partner-1",
      currentStatus: "approved",
      nextStatus: "suspended",
      actorRef: "admin-ref-hash",
      reason: "risk review",
      occurredAtEpochMs: NOW,
    });
    expect(suspended).toMatchObject({
      changed: true,
      audit: {
        actorType: "partner_admin",
        actorRef: "admin-ref-hash",
        action: "partner.status_changed",
        targetType: "partner",
        targetId: "partner-1",
        result: "success",
        occurredAtEpochMs: NOW,
      },
    });
  });

  it("permits activation and new reservations only while approved", () => {
    expect(getPartnerSupplyPolicy("approved")).toEqual({
      canActivateInventory: true,
      canReserveNewOrder: true,
      preserveExistingOrderResults: true,
    });
    for (const status of ["pending", "suspended", "rejected"] as const) {
      expect(getPartnerSupplyPolicy(status)).toEqual({
        canActivateInventory: false,
        canReserveNewOrder: false,
        preserveExistingOrderResults: true,
      });
    }
  });
});
