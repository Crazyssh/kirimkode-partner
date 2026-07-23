import { beforeEach, describe, expect, it } from "vitest";

import { PARTNER_LIFECYCLE_PERMISSION } from "@domain/task-7-5";
import type { AdminSessionRecord, PartnerAdminLoginStatus } from "@domain/task-7-5";

import { AuthRateLimiter } from "@application/auth/auth-rate-limiter";
import { InMemoryRateLimitStore } from "@infrastructure/auth/in-memory-rate-limit-store";
import { CryptoSessionTokenIssuer } from "@infrastructure/auth/crypto-session-token";

import { AdminLoginService } from "./admin-login-service";
import { AdminLogoutService } from "./admin-logout-service";
import { AdminAuthorizationService } from "./admin-authorization-service";
import { ResolveAdminSessionService } from "./resolve-admin-session-service";
import { ADMIN_SESSION_COOKIE_NAME } from "./admin-session-cookie";
import type {
  AdminAuthRecord,
  AdminIdentityGateway,
  AdminSessionAuthContext,
  AdminSessionGateway,
} from "./ports";

const ADMIN_ID = "00000000-0000-4000-8000-0000000000f1";
const TTL = Object.freeze({ idleTtlMs: 43_200_000, absoluteTtlMs: 604_800_000 });

class MutableClock {
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

/** verify(encodedHash, password) matches when the hash encodes that password. */
class FakePasswordHasher {
  readonly decoyHash = "decoy-hash";
  async verify(encodedHash: string, password: string): Promise<boolean> {
    return encodedHash === `hash:${password}`;
  }
}

class FakeAdminIdentity implements AdminIdentityGateway {
  private readonly admins = new Map<string, AdminAuthRecord>();
  seed(email: string, record: AdminAuthRecord): void {
    this.admins.set(email, record);
  }
  async findAdminByEmail(emailNormalized: string): Promise<AdminAuthRecord | null> {
    return this.admins.get(emailNormalized) ?? null;
  }
  async findAdminById(adminId: string): Promise<AdminAuthRecord | null> {
    for (const record of this.admins.values()) {
      if (record.adminId === adminId) return record;
    }
    return null;
  }
}

/** In-memory admin session store that joins a per-admin security/status view. */
class FakeAdminSessions implements AdminSessionGateway {
  private readonly rows = new Map<string, AdminSessionRecord>();
  private readonly adminView = new Map<
    string,
    { securityVersion: number; permissions: readonly string[]; status: PartnerAdminLoginStatus }
  >();

  setAdminView(
    adminId: string,
    view: { securityVersion: number; permissions: readonly string[]; status: PartnerAdminLoginStatus },
  ): void {
    this.adminView.set(adminId, view);
  }

  async create(session: AdminSessionRecord): Promise<void> {
    this.rows.set(session.tokenHash, session);
  }

  async findByTokenHash(tokenHash: string): Promise<AdminSessionAuthContext | null> {
    const session = this.rows.get(tokenHash);
    if (!session) return null;
    const view = this.adminView.get(session.adminId) ?? {
      securityVersion: session.securityVersion,
      permissions: [],
      status: "active" as const,
    };
    return {
      session,
      currentSecurityVersion: view.securityVersion,
      permissions: view.permissions,
      status: view.status,
    };
  }

  async slideIdleExpiry(tokenHash: string, idle: number, lastUsed: number): Promise<void> {
    const row = this.rows.get(tokenHash);
    if (row && row.revokedAtEpochMs === null) {
      this.rows.set(tokenHash, {
        ...row,
        idleExpiresAtEpochMs: idle,
        lastUsedAtEpochMs: lastUsed,
      });
    }
  }

  async revokeByTokenHash(tokenHash: string, revokedAt: number): Promise<void> {
    const row = this.rows.get(tokenHash);
    if (row && row.revokedAtEpochMs === null) {
      this.rows.set(tokenHash, { ...row, revokedAtEpochMs: revokedAt });
    }
  }
}

function activeAdminRecord(over: Partial<AdminAuthRecord> = {}): AdminAuthRecord {
  return {
    adminId: ADMIN_ID,
    passwordHash: "hash:correct",
    permissions: [PARTNER_LIFECYCLE_PERMISSION],
    securityVersion: 1,
    status: "active",
    ...over,
  };
}

describe("Admin realm session services", () => {
  let clock: MutableClock;
  let identity: FakeAdminIdentity;
  let sessions: FakeAdminSessions;
  let tokenIssuer: CryptoSessionTokenIssuer;
  let login: AdminLoginService;
  let resolveSession: ResolveAdminSessionService;
  let authorization: AdminAuthorizationService;
  let logout: AdminLogoutService;

  beforeEach(() => {
    clock = new MutableClock();
    identity = new FakeAdminIdentity();
    sessions = new FakeAdminSessions();
    tokenIssuer = new CryptoSessionTokenIssuer();
    const rateLimiter = new AuthRateLimiter(
      new InMemoryRateLimitStore(() => clock.nowEpochMs()),
      clock,
    );
    login = new AdminLoginService({
      identity,
      passwordHasher: new FakePasswordHasher(),
      sessions,
      tokenIssuer,
      rateLimiter,
      clock,
      idGenerator: new SequentialIds(),
      ttl: TTL,
    });
    resolveSession = new ResolveAdminSessionService({ sessions, tokenIssuer, clock, ttl: TTL });
    authorization = new AdminAuthorizationService({ sessionResolver: resolveSession });
    logout = new AdminLogoutService({ sessions, tokenIssuer, clock });
  });

  it("authenticates an active admin and issues the dedicated admin cookie", async () => {
    identity.seed("admin@example.com", activeAdminRecord());
    sessions.setAdminView(ADMIN_ID, {
      securityVersion: 1,
      permissions: [PARTNER_LIFECYCLE_PERMISSION],
      status: "active",
    });

    const result = await login.login({
      email: "Admin@Example.com",
      password: "correct",
      ip: "203.0.113.5",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.admin.adminId).toBe(ADMIN_ID);
    expect(result.setCookieHeader).toContain(`${ADMIN_SESSION_COOKIE_NAME}=`);
    expect(result.setCookieHeader).toContain("HttpOnly");
    expect(result.setCookieHeader).toContain("Secure");

    // The freshly issued session resolves to the admin with its permissions.
    const resolved = await resolveSession.resolve(result.token);
    expect(resolved.authenticated).toBe(true);
    if (!resolved.authenticated) return;
    expect(resolved.admin.permissions).toContain(PARTNER_LIFECYCLE_PERMISSION);
  });

  it("rejects wrong credentials generically", async () => {
    identity.seed("admin@example.com", activeAdminRecord());
    const result = await login.login({
      email: "admin@example.com",
      password: "wrong",
      ip: "203.0.113.5",
    });
    expect(result).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("rejects a disabled admin even with the right password", async () => {
    identity.seed("admin@example.com", activeAdminRecord({ status: "disabled" }));
    const result = await login.login({
      email: "admin@example.com",
      password: "correct",
      ip: "203.0.113.5",
    });
    expect(result).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("rate-limits repeated failures per email+IP", async () => {
    identity.seed("admin@example.com", activeAdminRecord());
    for (let i = 0; i < 5; i += 1) {
      await login.login({ email: "admin@example.com", password: "wrong", ip: "203.0.113.5" });
    }
    const result = await login.login({
      email: "admin@example.com",
      password: "correct",
      ip: "203.0.113.5",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("rate_limited");
  });

  it("logout revokes the session so it no longer resolves", async () => {
    identity.seed("admin@example.com", activeAdminRecord());
    sessions.setAdminView(ADMIN_ID, {
      securityVersion: 1,
      permissions: [PARTNER_LIFECYCLE_PERMISSION],
      status: "active",
    });
    const loggedIn = await login.login({
      email: "admin@example.com",
      password: "correct",
      ip: "203.0.113.5",
    });
    expect(loggedIn.ok).toBe(true);
    if (!loggedIn.ok) return;

    const out = await logout.logout(loggedIn.token);
    expect(out.setCookieHeader).toContain("Max-Age=0");

    const resolved = await resolveSession.resolve(loggedIn.token);
    expect(resolved).toEqual({ authenticated: false });
  });

  it("authorizes a permission only for admins that hold it", async () => {
    identity.seed("admin@example.com", activeAdminRecord({ permissions: [] }));
    sessions.setAdminView(ADMIN_ID, { securityVersion: 1, permissions: [], status: "active" });
    const loggedIn = await login.login({
      email: "admin@example.com",
      password: "correct",
      ip: "203.0.113.5",
    });
    expect(loggedIn.ok).toBe(true);
    if (!loggedIn.ok) return;

    const forbidden = await authorization.authorizePermission(
      loggedIn.token,
      PARTNER_LIFECYCLE_PERMISSION,
    );
    expect(forbidden).toEqual({ ok: false, reason: "forbidden" });

    const unauth = await authorization.authorizePermission(null, PARTNER_LIFECYCLE_PERMISSION);
    expect(unauth).toEqual({ ok: false, reason: "unauthenticated" });
  });
});
