import { describe, expect, it } from "vitest";

import {
  adminHasPermission,
  canAdminLogin,
  createAdminSessionRecord,
  evaluateAdminSession,
  isPartnerLifecycleCommand,
  PARTNER_LIFECYCLE_COMMANDS,
  PARTNER_LIFECYCLE_PERMISSION,
  resolveLifecycleCommand,
  type PartnerLifecycleCommand,
} from "./index";

const TOKEN_HASH = "a".repeat(64);
const TTL = Object.freeze({ idleTtlMs: 43_200_000, absoluteTtlMs: 604_800_000 });

describe("admin authorization policy", () => {
  it("only allows active admins to authenticate", () => {
    expect(canAdminLogin("active")).toBe(true);
    expect(canAdminLogin("disabled")).toBe(false);
  });

  it("checks explicit permissions", () => {
    expect(adminHasPermission([PARTNER_LIFECYCLE_PERMISSION], PARTNER_LIFECYCLE_PERMISSION)).toBe(
      true,
    );
    expect(adminHasPermission([], PARTNER_LIFECYCLE_PERMISSION)).toBe(false);
    expect(adminHasPermission(["other:permission"], PARTNER_LIFECYCLE_PERMISSION)).toBe(false);
  });
});

describe("admin session policy", () => {
  it("builds a session with an idle window capped by the absolute ceiling", () => {
    const session = createAdminSessionRecord({
      id: "s1",
      adminId: "admin-1",
      tokenHash: TOKEN_HASH,
      securityVersion: 1,
      createdAtEpochMs: 1_000,
      ttl: TTL,
    });
    expect(session.expiresAtEpochMs).toBe(1_000 + TTL.absoluteTtlMs);
    expect(session.idleExpiresAtEpochMs).toBe(1_000 + TTL.idleTtlMs);
    expect(session.revokedAtEpochMs).toBeNull();
  });

  it("rejects a malformed token hash", () => {
    expect(() =>
      createAdminSessionRecord({
        id: "s1",
        adminId: "admin-1",
        tokenHash: "not-a-hash",
        securityVersion: 1,
        createdAtEpochMs: 1_000,
        ttl: TTL,
      }),
    ).toThrow(/INVALID_ADMIN_SESSION_DESCRIPTOR/);
  });

  it("evaluates revoked, expired, idle, and version-bumped sessions as inactive", () => {
    const base = createAdminSessionRecord({
      id: "s1",
      adminId: "admin-1",
      tokenHash: TOKEN_HASH,
      securityVersion: 1,
      createdAtEpochMs: 0,
      ttl: TTL,
    });

    const revoked = evaluateAdminSession({
      session: { ...base, revokedAtEpochMs: 5 },
      nowEpochMs: 10,
      currentSecurityVersion: 1,
      idleTtlMs: TTL.idleTtlMs,
    });
    expect(revoked).toEqual({ active: false, reason: "revoked" });

    const absolute = evaluateAdminSession({
      session: base,
      nowEpochMs: base.expiresAtEpochMs,
      currentSecurityVersion: 1,
      idleTtlMs: TTL.idleTtlMs,
    });
    expect(absolute).toEqual({ active: false, reason: "absolute_expired" });

    const idle = evaluateAdminSession({
      session: base,
      nowEpochMs: base.idleExpiresAtEpochMs,
      currentSecurityVersion: 1,
      idleTtlMs: TTL.idleTtlMs,
    });
    expect(idle).toEqual({ active: false, reason: "idle_expired" });

    const bumped = evaluateAdminSession({
      session: base,
      nowEpochMs: 10,
      currentSecurityVersion: 2,
      idleTtlMs: TTL.idleTtlMs,
    });
    expect(bumped).toEqual({ active: false, reason: "security_version_changed" });
  });

  it("slides the idle expiry forward for an active session, capped at absolute", () => {
    const base = createAdminSessionRecord({
      id: "s1",
      adminId: "admin-1",
      tokenHash: TOKEN_HASH,
      securityVersion: 1,
      createdAtEpochMs: 0,
      ttl: TTL,
    });
    const evaluation = evaluateAdminSession({
      session: base,
      nowEpochMs: 100,
      currentSecurityVersion: 1,
      idleTtlMs: TTL.idleTtlMs,
    });
    expect(evaluation.active).toBe(true);
    if (!evaluation.active) return;
    expect(evaluation.slideIdleExpiryToEpochMs).toBe(
      Math.min(100 + TTL.idleTtlMs, base.expiresAtEpochMs),
    );
  });
});

describe("partner lifecycle command policy", () => {
  it("recognizes exactly the four lifecycle commands", () => {
    expect([...PARTNER_LIFECYCLE_COMMANDS]).toEqual([
      "approve",
      "reject",
      "suspend",
      "reapprove",
    ]);
    for (const command of PARTNER_LIFECYCLE_COMMANDS) {
      expect(isPartnerLifecycleCommand(command)).toBe(true);
    }
    expect(isPartnerLifecycleCommand("delete")).toBe(false);
    expect(isPartnerLifecycleCommand(42)).toBe(false);
  });

  it("maps each command to its target status only from valid source statuses", () => {
    expect(resolveLifecycleCommand("approve", "pending")).toEqual({
      ok: true,
      nextStatus: "approved",
    });
    expect(resolveLifecycleCommand("reject", "pending")).toEqual({
      ok: true,
      nextStatus: "rejected",
    });
    expect(resolveLifecycleCommand("reject", "suspended")).toEqual({
      ok: true,
      nextStatus: "rejected",
    });
    expect(resolveLifecycleCommand("suspend", "approved")).toEqual({
      ok: true,
      nextStatus: "suspended",
    });
    expect(resolveLifecycleCommand("reapprove", "suspended")).toEqual({
      ok: true,
      nextStatus: "approved",
    });
  });

  it("rejects commands that do not apply to the current status", () => {
    const cases: ReadonlyArray<[PartnerLifecycleCommand, "pending" | "approved" | "suspended" | "rejected"]> = [
      ["approve", "approved"],
      ["approve", "suspended"],
      ["suspend", "pending"],
      ["suspend", "suspended"],
      ["reapprove", "pending"],
      ["reapprove", "approved"],
      ["reject", "approved"],
      ["reject", "rejected"],
    ];
    for (const [command, status] of cases) {
      expect(resolveLifecycleCommand(command, status)).toEqual({
        ok: false,
        code: "INVALID_LIFECYCLE_COMMAND",
      });
    }
  });
});
