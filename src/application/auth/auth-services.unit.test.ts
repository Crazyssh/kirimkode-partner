import { beforeEach, describe, expect, it } from "vitest";

import { CryptoSessionTokenIssuer } from "@infrastructure/auth/crypto-session-token";
import { InMemoryRateLimitStore } from "@infrastructure/auth/in-memory-rate-limit-store";

import type { RegistrationTransactionPort } from "@domain/task-5-1/registration";
import type { PartnerMemberLoginStatus, SessionRecord } from "@domain/task-7-2";

import { AuthRateLimiter } from "./auth-rate-limiter";
import { EmailAlreadyRegisteredError } from "./auth-errors";
import { LoginService } from "./login-service";
import { LogoutService } from "./logout-service";
import { RegisterPartnerService } from "./register-partner-service";
import { ResolveSessionService } from "./resolve-session-service";
import { SESSION_COOKIE_NAME } from "./session-cookie";
import type {
  AuthIdentityGateway,
  MemberAuthRecord,
  SessionAuthContext,
  SessionGateway,
} from "./ports";

const TTL = { idleTtlMs: 12 * 60 * 60 * 1_000, absoluteTtlMs: 7 * 24 * 60 * 60 * 1_000 };

class FakeClock {
  constructor(public value = 1_700_000_000_000) {}
  nowEpochMs(): number {
    return this.value;
  }
  advance(ms: number): void {
    this.value += ms;
  }
}

class SequentialIds {
  private n = 0;
  private readonly hex = "0123456789abcdef";
  uuid(): string {
    this.n += 1;
    const h = this.n.toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${h}`;
  }
}

/** Deterministic hasher: `hashed:<pw>`; decoy never matches a real password. */
class FakePasswordHasher {
  readonly decoyHash = "decoy-hash";
  async hash(password: string): Promise<string> {
    return `hashed:${password}`;
  }
  async verify(encodedHash: string, password: string): Promise<boolean> {
    return encodedHash === `hashed:${password}`;
  }
}

class FakeIdentityGateway implements AuthIdentityGateway {
  readonly members = new Map<string, MemberAuthRecord>();

  async findMemberByEmail(emailNormalized: string): Promise<MemberAuthRecord | null> {
    return this.members.get(emailNormalized) ?? null;
  }

  async execute<T>(
    work: (transaction: RegistrationTransactionPort) => Promise<T>,
  ): Promise<T> {
    const members = this.members;
    const draft: {
      value:
        | { id: string; partnerId: string; emailNormalized: string; passwordHash: string }
        | null;
    } = { value: null };

    const tx: RegistrationTransactionPort = {
      async createPartner(input) {
        return input;
      },
      async createOwner(input) {
        if (members.has(input.emailNormalized)) {
          throw new EmailAlreadyRegisteredError();
        }
        draft.value = {
          id: input.id,
          partnerId: input.partnerId,
          emailNormalized: input.emailNormalized,
          passwordHash: input.passwordHash,
        };
        return input;
      },
    };

    const result = await work(tx);
    // Commit only after the whole unit of work succeeds (atomicity).
    const committed = draft.value;
    if (committed !== null) {
      members.set(committed.emailNormalized, {
        memberId: committed.id,
        partnerId: committed.partnerId,
        role: "owner",
        passwordHash: committed.passwordHash,
        securityVersion: 1,
        status: "pending_verification",
      });
    }
    return result;
  }
}

function seedMember(
  gateway: FakeIdentityGateway,
  email: string,
  overrides: Partial<MemberAuthRecord> = {},
): MemberAuthRecord {
  const record: MemberAuthRecord = {
    memberId: overrides.memberId ?? "member-1",
    partnerId: overrides.partnerId ?? "partner-1",
    role: overrides.role ?? "owner",
    passwordHash: overrides.passwordHash ?? "hashed:correcthorsestaple",
    securityVersion: overrides.securityVersion ?? 1,
    status: overrides.status ?? "active",
  };
  gateway.members.set(email, record);
  return record;
}

class FakeSessionGateway implements SessionGateway {
  readonly sessions = new Map<string, SessionAuthContext>();
  currentSecurityVersion = 1;
  status: PartnerMemberLoginStatus = "active";
  role: "owner" | "member" = "owner";

  async create(session: SessionRecord): Promise<void> {
    this.sessions.set(session.tokenHash, {
      session,
      currentSecurityVersion: this.currentSecurityVersion,
      role: this.role,
      status: this.status,
    });
  }

  async findByTokenHash(tokenHash: string): Promise<SessionAuthContext | null> {
    const stored = this.sessions.get(tokenHash);
    if (!stored) return null;
    // Reflect the "current" member view, which may have changed since creation.
    return {
      session: stored.session,
      currentSecurityVersion: this.currentSecurityVersion,
      role: this.role,
      status: this.status,
    };
  }

  async slideIdleExpiry(
    tokenHash: string,
    idleExpiresAtEpochMs: number,
    lastUsedAtEpochMs: number,
  ): Promise<void> {
    const stored = this.sessions.get(tokenHash);
    if (!stored || stored.session.revokedAtEpochMs !== null) return;
    this.sessions.set(tokenHash, {
      ...stored,
      session: { ...stored.session, idleExpiresAtEpochMs, lastUsedAtEpochMs },
    });
  }

  async revokeByTokenHash(tokenHash: string, revokedAtEpochMs: number): Promise<void> {
    const stored = this.sessions.get(tokenHash);
    if (!stored || stored.session.revokedAtEpochMs !== null) return;
    this.sessions.set(tokenHash, {
      ...stored,
      session: { ...stored.session, revokedAtEpochMs },
    });
  }
}

function buildFixture() {
  const clock = new FakeClock();
  const ids = new SequentialIds();
  const passwordHasher = new FakePasswordHasher();
  const tokenIssuer = new CryptoSessionTokenIssuer();
  const identity = new FakeIdentityGateway();
  const sessions = new FakeSessionGateway();
  const rateLimiter = new AuthRateLimiter(
    new InMemoryRateLimitStore(() => clock.nowEpochMs()),
    clock,
  );

  const register = new RegisterPartnerService({
    identity,
    passwordHasher,
    rateLimiter,
    clock,
    idGenerator: ids,
  });
  const login = new LoginService({
    identity,
    passwordHasher,
    sessions,
    tokenIssuer,
    rateLimiter,
    clock,
    idGenerator: ids,
    ttl: TTL,
  });
  const resolveSession = new ResolveSessionService({ sessions, tokenIssuer, clock, ttl: TTL });
  const logout = new LogoutService({ sessions, tokenIssuer, clock });

  return { clock, identity, sessions, register, login, resolveSession, logout, passwordHasher };
}

const VALID_PASSWORD = "correcthorsestaple";

// **Validates: Requirements 2.1, 2.2, 2.3**
describe("RegisterPartnerService", () => {
  let fx: ReturnType<typeof buildFixture>;
  beforeEach(() => {
    fx = buildFixture();
  });

  it("creates a pending partner + owner and stores only a password hash", async () => {
    const result = await fx.register.register({
      legalName: "Acme LLC",
      displayName: "Acme",
      email: "Owner@Example.com",
      password: VALID_PASSWORD,
      ip: "203.0.113.5",
    });

    expect(result).toEqual({
      ok: true,
      partnerId: expect.any(String),
      ownerMemberId: expect.any(String),
    });
    const stored = await fx.identity.findMemberByEmail("owner@example.com");
    expect(stored).not.toBeNull();
    expect(stored?.passwordHash).toBe(`hashed:${VALID_PASSWORD}`);
    expect(stored?.passwordHash).not.toContain(VALID_PASSWORD.slice(0, 4) + "!");
  });

  it("rejects a weak password as a validation failure without persisting", async () => {
    const result = await fx.register.register({
      legalName: "Acme",
      displayName: "Acme",
      email: "owner2@example.com",
      password: "short",
      ip: "203.0.113.5",
    });
    expect(result).toEqual({ ok: false, reason: "validation", code: "PASSWORD_TOO_SHORT" });
    expect(await fx.identity.findMemberByEmail("owner2@example.com")).toBeNull();
  });

  it("reports a duplicate email as a conflict and stays atomic", async () => {
    const input = {
      legalName: "Acme",
      displayName: "Acme",
      email: "dup@example.com",
      password: VALID_PASSWORD,
      ip: "203.0.113.5",
    };
    await fx.register.register(input);
    const before = fx.identity.members.size;
    const second = await fx.register.register(input);
    expect(second).toEqual({ ok: false, reason: "email_taken" });
    expect(fx.identity.members.size).toBe(before);
  });

  it("rate-limits the 6th attempt per email within the hour", async () => {
    const input = {
      legalName: "Acme",
      displayName: "Acme",
      email: "rl@example.com",
      password: VALID_PASSWORD,
      ip: "203.0.113.5",
    };
    for (let i = 0; i < 5; i += 1) {
      await fx.register.register(input);
    }
    const sixth = await fx.register.register(input);
    expect(sixth.ok).toBe(false);
    expect(sixth).toMatchObject({ reason: "rate_limited" });
  });
});

// **Validates: Requirements 2.3, 2.4, 2.5, 2.7**
describe("LoginService", () => {
  let fx: ReturnType<typeof buildFixture>;
  beforeEach(() => {
    fx = buildFixture();
    seedMember(fx.identity, "owner@example.com");
  });

  it("issues a session and a __Host- cookie on valid credentials", async () => {
    const result = await fx.login.login({
      email: "Owner@Example.com",
      password: VALID_PASSWORD,
      ip: "203.0.113.5",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toEqual({
      memberId: "member-1",
      partnerId: "partner-1",
      role: "owner",
      securityVersion: 1,
    });
    expect(result.setCookieHeader).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(result.setCookieHeader).toContain("HttpOnly");
    expect(result.setCookieHeader).toContain("Secure");
    expect(result.setCookieHeader).toContain("SameSite=Lax");
    expect(result.setCookieHeader).toContain("Path=/");
    // A session row keyed by the token *hash* exists; the raw token is not it.
    expect(fx.sessions.sessions.size).toBe(1);
    expect(fx.sessions.sessions.has(result.token)).toBe(false);
  });

  it("returns a generic failure for a wrong password", async () => {
    const result = await fx.login.login({
      email: "owner@example.com",
      password: "wrong-password-here",
      ip: "203.0.113.5",
    });
    expect(result).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("returns the identical generic failure for an unknown email", async () => {
    const result = await fx.login.login({
      email: "nobody@example.com",
      password: VALID_PASSWORD,
      ip: "203.0.113.5",
    });
    expect(result).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("denies login for a suspended member without revealing why", async () => {
    seedMember(fx.identity, "susp@example.com", { status: "suspended" });
    const result = await fx.login.login({
      email: "susp@example.com",
      password: VALID_PASSWORD,
      ip: "203.0.113.5",
    });
    expect(result).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("blocks after 5 failures per email+IP, even with a correct password", async () => {
    for (let i = 0; i < 5; i += 1) {
      await fx.login.login({ email: "owner@example.com", password: "bad", ip: "198.51.100.9" });
    }
    const blocked = await fx.login.login({
      email: "owner@example.com",
      password: VALID_PASSWORD,
      ip: "198.51.100.9",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked).toMatchObject({ reason: "rate_limited" });
  });

  it("clears the failure counter on a successful login", async () => {
    for (let i = 0; i < 4; i += 1) {
      await fx.login.login({ email: "owner@example.com", password: "bad", ip: "198.51.100.9" });
    }
    const ok = await fx.login.login({
      email: "owner@example.com",
      password: VALID_PASSWORD,
      ip: "198.51.100.9",
    });
    expect(ok.ok).toBe(true);
    // Counter reset: four more failures must not immediately trip the limit.
    for (let i = 0; i < 4; i += 1) {
      const r = await fx.login.login({ email: "owner@example.com", password: "bad", ip: "198.51.100.9" });
      expect(r).toEqual({ ok: false, reason: "invalid_credentials" });
    }
  });
});

// **Validates: Requirements 2.4**
describe("ResolveSessionService", () => {
  let fx: ReturnType<typeof buildFixture>;
  let token: string;
  beforeEach(async () => {
    fx = buildFixture();
    seedMember(fx.identity, "owner@example.com");
    const login = await fx.login.login({
      email: "owner@example.com",
      password: VALID_PASSWORD,
      ip: "203.0.113.5",
    });
    if (!login.ok) throw new Error("login setup failed");
    token = login.token;
  });

  it("resolves a valid token to the session's principal", async () => {
    const result = await fx.resolveSession.resolve(token);
    expect(result).toEqual({
      authenticated: true,
      principal: {
        memberId: "member-1",
        partnerId: "partner-1",
        role: "owner",
        securityVersion: 1,
      },
    });
  });

  it("rejects an unknown or empty token", async () => {
    expect(await fx.resolveSession.resolve(undefined)).toEqual({ authenticated: false });
    expect(await fx.resolveSession.resolve("not-a-real-token")).toEqual({ authenticated: false });
  });

  it("rejects a token after the absolute TTL elapses", async () => {
    fx.clock.advance(TTL.absoluteTtlMs + 1);
    expect(await fx.resolveSession.resolve(token)).toEqual({ authenticated: false });
  });

  it("rejects a token after the idle TTL lapses with no use", async () => {
    fx.clock.advance(TTL.idleTtlMs + 1);
    expect(await fx.resolveSession.resolve(token)).toEqual({ authenticated: false });
  });

  it("rejects when the member's security version was bumped", async () => {
    fx.sessions.currentSecurityVersion = 2;
    expect(await fx.resolveSession.resolve(token)).toEqual({ authenticated: false });
  });

  it("rejects when the member became disabled", async () => {
    fx.sessions.status = "disabled";
    expect(await fx.resolveSession.resolve(token)).toEqual({ authenticated: false });
  });
});

// **Validates: Requirements 2.4**
describe("LogoutService", () => {
  let fx: ReturnType<typeof buildFixture>;
  let token: string;
  beforeEach(async () => {
    fx = buildFixture();
    seedMember(fx.identity, "owner@example.com");
    const login = await fx.login.login({
      email: "owner@example.com",
      password: VALID_PASSWORD,
      ip: "203.0.113.5",
    });
    if (!login.ok) throw new Error("login setup failed");
    token = login.token;
  });

  it("revokes the session and returns a cleared cookie", async () => {
    const result = await fx.logout.logout(token);
    expect(result.setCookieHeader).toContain("Max-Age=0");
    expect(await fx.resolveSession.resolve(token)).toEqual({ authenticated: false });
  });

  it("is idempotent and safe without a token", async () => {
    const first = await fx.logout.logout(token);
    const second = await fx.logout.logout(token);
    const none = await fx.logout.logout(undefined);
    expect(first.setCookieHeader).toContain("Max-Age=0");
    expect(second.setCookieHeader).toContain("Max-Age=0");
    expect(none.setCookieHeader).toContain("Max-Age=0");
  });
});
