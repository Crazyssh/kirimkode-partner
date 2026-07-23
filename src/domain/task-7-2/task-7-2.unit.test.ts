import { describe, expect, it } from "vitest";

import {
  canMemberLogin,
  consumeEvent,
  createSessionRecord,
  emptyWindowCounter,
  evaluateLogin,
  evaluateSession,
  evaluateWindow,
  registerEvent,
  type PartnerMemberLoginStatus,
  type SessionRecord,
  type WindowRule,
} from "./index";

const HEX_64 = "a".repeat(64);
const TTL = { idleTtlMs: 12 * 60 * 60 * 1_000, absoluteTtlMs: 7 * 24 * 60 * 60 * 1_000 };

function baseSessionInput() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    memberId: "22222222-2222-4222-8222-222222222222",
    partnerId: "33333333-3333-4333-8333-333333333333",
    tokenHash: HEX_64,
    securityVersion: 1,
    createdAtEpochMs: 1_000_000,
    ttl: TTL,
  };
}

// **Validates: Requirements 2.4**
describe("session-policy: createSessionRecord", () => {
  it("computes absolute expiry from creation and caps the initial idle window", () => {
    const session = createSessionRecord(baseSessionInput());
    expect(session.expiresAtEpochMs).toBe(1_000_000 + TTL.absoluteTtlMs);
    expect(session.idleExpiresAtEpochMs).toBe(1_000_000 + TTL.idleTtlMs);
    expect(session.revokedAtEpochMs).toBeNull();
    expect(session.lastUsedAtEpochMs).toBeNull();
  });

  it("rejects an invalid TTL policy", () => {
    expect(() =>
      createSessionRecord({
        ...baseSessionInput(),
        ttl: { idleTtlMs: 10_000, absoluteTtlMs: 5_000 },
      }),
    ).toThrow("INVALID_SESSION_TTL");
  });

  it("rejects a non-SHA-256 token hash", () => {
    expect(() =>
      createSessionRecord({ ...baseSessionInput(), tokenHash: "short" }),
    ).toThrow("INVALID_SESSION_DESCRIPTOR");
  });
});

// **Validates: Requirements 2.4**
describe("session-policy: evaluateSession", () => {
  const session: SessionRecord = createSessionRecord(baseSessionInput());

  it("is active within both windows and slides the idle expiry forward (capped)", () => {
    const now = session.createdAtEpochMs + 60_000;
    const result = evaluateSession({
      session,
      nowEpochMs: now,
      currentSecurityVersion: 1,
      idleTtlMs: TTL.idleTtlMs,
    });
    expect(result).toEqual({
      active: true,
      slideIdleExpiryToEpochMs: Math.min(now + TTL.idleTtlMs, session.expiresAtEpochMs),
    });
  });

  it("caps the slid idle expiry at the absolute expiry near end of life", () => {
    // A session slid close to its absolute ceiling: still within the idle
    // window, but now + idleTtl would overshoot the absolute expiry.
    const slidSession: SessionRecord = {
      ...session,
      idleExpiresAtEpochMs: session.expiresAtEpochMs - 10,
    };
    const now = session.expiresAtEpochMs - 20;
    const result = evaluateSession({
      session: slidSession,
      nowEpochMs: now,
      currentSecurityVersion: 1,
      idleTtlMs: 1_000,
    });
    expect(result).toEqual({ active: true, slideIdleExpiryToEpochMs: session.expiresAtEpochMs });
  });

  it("rejects a revoked session first", () => {
    const revoked = { ...session, revokedAtEpochMs: session.createdAtEpochMs + 1 };
    const result = evaluateSession({
      session: revoked,
      nowEpochMs: session.createdAtEpochMs + 2,
      currentSecurityVersion: 1,
      idleTtlMs: TTL.idleTtlMs,
    });
    expect(result).toEqual({ active: false, reason: "revoked" });
  });

  it("rejects after the absolute expiry", () => {
    const result = evaluateSession({
      session,
      nowEpochMs: session.expiresAtEpochMs,
      currentSecurityVersion: 1,
      idleTtlMs: TTL.idleTtlMs,
    });
    expect(result).toEqual({ active: false, reason: "absolute_expired" });
  });

  it("rejects after the idle window lapses", () => {
    const result = evaluateSession({
      session,
      nowEpochMs: session.idleExpiresAtEpochMs,
      currentSecurityVersion: 1,
      idleTtlMs: TTL.idleTtlMs,
    });
    expect(result).toEqual({ active: false, reason: "idle_expired" });
  });

  it("rejects when the member's security version changed", () => {
    const result = evaluateSession({
      session,
      nowEpochMs: session.createdAtEpochMs + 60_000,
      currentSecurityVersion: 2,
      idleTtlMs: TTL.idleTtlMs,
    });
    expect(result).toEqual({ active: false, reason: "security_version_changed" });
  });
});

// **Validates: Requirements 2.5**
describe("login-policy: evaluateLogin", () => {
  const candidate = {
    memberId: "m1",
    partnerId: "p1",
    role: "owner" as const,
    securityVersion: 1,
    status: "active" as PartnerMemberLoginStatus,
  };

  it("authenticates a found, verified, loginable member", () => {
    const result = evaluateLogin({ memberFound: true, passwordMatches: true, candidate });
    expect(result).toEqual({
      authenticated: true,
      principal: { memberId: "m1", partnerId: "p1", role: "owner", securityVersion: 1 },
    });
  });

  it("returns the identical generic failure when the email is unknown", () => {
    expect(evaluateLogin({ memberFound: false, passwordMatches: false })).toEqual({
      authenticated: false,
    });
  });

  it("returns the identical generic failure on a wrong password", () => {
    expect(evaluateLogin({ memberFound: true, passwordMatches: false, candidate })).toEqual({
      authenticated: false,
    });
  });

  it("returns the identical generic failure for a non-loginable status", () => {
    for (const status of ["suspended", "disabled"] as PartnerMemberLoginStatus[]) {
      expect(
        evaluateLogin({
          memberFound: true,
          passwordMatches: true,
          candidate: { ...candidate, status },
        }),
      ).toEqual({ authenticated: false });
    }
  });

  it("permits pending_verification and active members to log in", () => {
    expect(canMemberLogin("pending_verification")).toBe(true);
    expect(canMemberLogin("active")).toBe(true);
    expect(canMemberLogin("suspended")).toBe(false);
    expect(canMemberLogin("disabled")).toBe(false);
  });
});

// **Validates: Requirements 2.7**
describe("rate-limit-policy", () => {
  const rule: WindowRule = { limit: 3, windowMs: 1_000, cooldownMs: 5_000 };

  it("allows events up to the limit then denies within the window", () => {
    let counter = emptyWindowCounter();
    const now = 10_000;
    for (let i = 0; i < rule.limit; i += 1) {
      expect(evaluateWindow(counter, rule, now).allowed).toBe(true);
      counter = registerEvent(counter, rule, now);
    }
    const denied = evaluateWindow(counter, rule, now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it("applies a cooldown once the limit is reached", () => {
    let counter = emptyWindowCounter();
    const now = 10_000;
    for (let i = 0; i < rule.limit; i += 1) {
      counter = registerEvent(counter, rule, now);
    }
    expect(counter.blockedUntilEpochMs).toBe(now + rule.cooldownMs!);
    // Still blocked even after the plain window would have elapsed.
    expect(evaluateWindow(counter, rule, now + rule.windowMs + 1).allowed).toBe(false);
    // Allowed again once the cooldown passes.
    expect(evaluateWindow(counter, rule, now + rule.cooldownMs! + 1).allowed).toBe(true);
  });

  it("resets a fixed window without cooldown after it elapses", () => {
    const requestRule: WindowRule = { limit: 2, windowMs: 1_000 };
    let counter = emptyWindowCounter();
    const start = 10_000;
    counter = registerEvent(counter, requestRule, start);
    counter = registerEvent(counter, requestRule, start + 100);
    expect(evaluateWindow(counter, requestRule, start + 200).allowed).toBe(false);
    expect(evaluateWindow(counter, requestRule, start + 1_000).allowed).toBe(true);
  });

  it("consumeEvent counts only when allowed", () => {
    const requestRule: WindowRule = { limit: 1, windowMs: 1_000 };
    const now = 10_000;
    const first = consumeEvent(emptyWindowCounter(), requestRule, now);
    expect(first.decision.allowed).toBe(true);
    expect(first.counter.count).toBe(1);

    const second = consumeEvent(first.counter, requestRule, now);
    expect(second.decision.allowed).toBe(false);
    // Denied consume does not increment beyond the limit.
    expect(second.counter.count).toBe(1);
  });

  it("does not double-count when registering during a cooldown", () => {
    let counter = emptyWindowCounter();
    const now = 10_000;
    for (let i = 0; i < rule.limit; i += 1) {
      counter = registerEvent(counter, rule, now);
    }
    const blockedCount = counter.count;
    const afterExtra = registerEvent(counter, rule, now + 10);
    expect(afterExtra.count).toBe(blockedCount);
  });
});
