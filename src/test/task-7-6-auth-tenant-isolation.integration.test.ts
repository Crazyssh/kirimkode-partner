import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RegisterPartnerService } from "@application/auth/register-partner-service";
import { LoginService } from "@application/auth/login-service";
import { LogoutService } from "@application/auth/logout-service";
import { ResolveSessionService } from "@application/auth/resolve-session-service";
import { VerifyEmailService } from "@application/auth/verify-email-service";
import { ResetPasswordService } from "@application/auth/reset-password-service";
import { RequestEmailVerificationService } from "@application/auth/request-email-verification-service";
import { RequestPasswordResetService } from "@application/auth/request-password-reset-service";
import { AuthRateLimiter } from "@application/auth/auth-rate-limiter";
import {
  LOGIN_RATE_LIMIT,
  REGISTER_EMAIL_RATE_LIMIT,
  sessionTtlFromSeconds,
} from "@application/auth/auth-config";
import { SESSION_COOKIE_NAME } from "@application/auth/session-cookie";
import type { EmailMessage, EmailSender } from "@application/auth/ports";

import { MemberManagementService } from "@application/members/member-management-service";
import { toSessionContext, type SessionContext } from "@application/authorization/session-context";

import { AdminLoginService } from "@application/admin/admin-login-service";
import { PartnerLifecycleService } from "@application/admin/partner-lifecycle-service";
import { ResolveAdminSessionService } from "@application/admin/resolve-admin-session-service";
import { adminSessionTtlFromSeconds } from "@application/admin/admin-config";
import { ADMIN_SESSION_COOKIE_NAME } from "@application/admin/admin-session-cookie";

import {
  createPartnerDatabaseClient,
  createTenantContext,
  PartnerMemberRepository,
  PrismaAdminIdentityGateway,
  PrismaAdminSessionGateway,
  PrismaAuthIdentityGateway,
  PrismaMemberManagementGateway,
  PrismaOneTimeTokenGateway,
  PrismaPartnerLifecycleGateway,
  PrismaSessionGateway,
  PrismaUnitOfWork,
  ResourceNotFoundError,
  type PartnerDatabaseClient,
} from "@infrastructure/database";
import { Argon2idPasswordHasher, DECOY_PASSWORD_HASH } from "@infrastructure/auth/argon2-password-hasher";
import { CryptoOneTimeTokenIssuer } from "@infrastructure/auth/crypto-one-time-token";
import { CryptoSessionTokenIssuer } from "@infrastructure/auth/crypto-session-token";
import { InMemoryRateLimitStore } from "@infrastructure/auth/in-memory-rate-limit-store";
import { CryptoIdGenerator } from "@infrastructure/auth/system-clock";

import { PARTNER_LIFECYCLE_PERMISSION } from "@domain/task-7-5";
import { ONE_TIME_TOKEN_TTL_MS } from "@domain/task-5-1/one-time-token";

import {
  createDisposableTestDatabase,
  type DisposableTestDatabase,
} from "./disposable-database";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const adminUrl = process.env.PARTNER_TEST_DATABASE_ADMIN_URL ?? "";
const hasPostgres = adminUrl.length > 0;

const VALID_PASSWORD = "CorrectHorseBatteryStaple1";
const IDLE_TTL_SECONDS = 3_600; // 1 hour
const ABSOLUTE_TTL_SECONDS = 7_200; // 2 hours
const BASE_EPOCH_MS = Date.UTC(2026, 5, 1, 0, 0, 0); // deterministic anchor

/** A test-controllable clock satisfying the application `Clock` port. */
class MutableClock {
  private current: number;

  constructor(startEpochMs: number) {
    this.current = startEpochMs;
  }

  nowEpochMs(): number {
    return this.current;
  }

  set(epochMs: number): void {
    this.current = epochMs;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/** Captures outbound auth emails so tests can extract the one-time token link. */
class CapturingEmailSender implements EmailSender {
  readonly messages: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
  }

  /** Extract the raw `token` query parameter from the most recent message. */
  lastToken(): string {
    const message = this.messages.at(-1);
    if (!message) throw new Error("no email captured");
    const match = message.text.match(/token=([A-Za-z0-9_-]+)/u);
    if (!match) throw new Error("no token in captured email");
    return match[1];
  }
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@example.test`;
}

/**
 * A freshly wired set of auth/tenant/admin services bound to the shared
 * disposable database. Each harness owns its own in-memory rate-limit store and
 * clock so tests are independent (rate-limit counters and time never leak
 * across tests).
 */
function createHarness(client: PartnerDatabaseClient) {
  const clock = new MutableClock(BASE_EPOCH_MS);
  const idGenerator = new CryptoIdGenerator();
  const passwordHasher = new Argon2idPasswordHasher();
  const tokenIssuer = new CryptoSessionTokenIssuer();
  const oneTimeTokenIssuer = new CryptoOneTimeTokenIssuer();
  const emailSender = new CapturingEmailSender();
  const rateLimiter = new AuthRateLimiter(
    new InMemoryRateLimitStore(() => clock.nowEpochMs()),
    clock,
  );
  const ttl = sessionTtlFromSeconds(IDLE_TTL_SECONDS, ABSOLUTE_TTL_SECONDS);

  const identity = new PrismaAuthIdentityGateway(client);
  const sessions = new PrismaSessionGateway(client);
  const tokens = new PrismaOneTimeTokenGateway(client);

  const register = new RegisterPartnerService({
    identity,
    passwordHasher,
    rateLimiter,
    clock,
    idGenerator,
  });
  const login = new LoginService({
    identity,
    passwordHasher,
    sessions,
    tokenIssuer,
    rateLimiter,
    clock,
    idGenerator,
    ttl,
  });
  const resolveSession = new ResolveSessionService({ sessions, tokenIssuer, clock, ttl });
  const logout = new LogoutService({ sessions, tokenIssuer, clock });
  const verifyEmail = new VerifyEmailService({ tokens, tokenIssuer: oneTimeTokenIssuer, clock });
  const resetPassword = new ResetPasswordService({
    tokens,
    tokenIssuer: oneTimeTokenIssuer,
    passwordHasher,
    clock,
  });
  const requestEmailVerification = new RequestEmailVerificationService({
    identity,
    tokens,
    tokenIssuer: oneTimeTokenIssuer,
    emailSender,
    rateLimiter,
    clock,
    idGenerator,
    portalOrigin: "https://partner.kirimkode.test",
  });
  const requestPasswordReset = new RequestPasswordResetService({
    identity,
    tokens,
    tokenIssuer: oneTimeTokenIssuer,
    emailSender,
    rateLimiter,
    clock,
    idGenerator,
    portalOrigin: "https://partner.kirimkode.test",
  });

  const memberGateway = new PrismaMemberManagementGateway(new PrismaUnitOfWork(client));
  const members = new MemberManagementService({
    gateway: memberGateway,
    passwordHasher,
    secretGenerator: { generate: () => randomBytes(32).toString("base64url") },
    clock,
    idGenerator,
  });

  const adminIdentity = new PrismaAdminIdentityGateway(client);
  const adminSessions = new PrismaAdminSessionGateway(client);
  const adminTtl = adminSessionTtlFromSeconds(IDLE_TTL_SECONDS, ABSOLUTE_TTL_SECONDS);
  const adminLogin = new AdminLoginService({
    identity: adminIdentity,
    passwordHasher,
    sessions: adminSessions,
    tokenIssuer,
    rateLimiter,
    clock,
    idGenerator,
    ttl: adminTtl,
  });
  const resolveAdminSession = new ResolveAdminSessionService({
    sessions: adminSessions,
    tokenIssuer,
    clock,
    ttl: adminTtl,
  });
  const partnerLifecycle = new PartnerLifecycleService({
    gateway: new PrismaPartnerLifecycleGateway(new PrismaUnitOfWork(client)),
    clock,
    idGenerator,
  });

  return {
    clock,
    passwordHasher,
    emailSender,
    register,
    login,
    resolveSession,
    logout,
    verifyEmail,
    resetPassword,
    requestEmailVerification,
    requestPasswordReset,
    members,
    adminLogin,
    resolveAdminSession,
    partnerLifecycle,
  };
}

type Harness = ReturnType<typeof createHarness>;

/** Register a Partner + owner and return the ids and the owner credentials. */
async function registerOwner(
  harness: Harness,
  overrides: { email?: string; password?: string } = {},
): Promise<{ partnerId: string; ownerMemberId: string; email: string; password: string }> {
  const email = overrides.email ?? uniqueEmail("owner");
  const password = overrides.password ?? VALID_PASSWORD;
  const outcome = await harness.register.register({
    legalName: "Test Legal Name",
    displayName: "Test Partner",
    email,
    password,
    ip: "203.0.113.10",
  });
  if (!outcome.ok) {
    throw new Error(`registration failed: ${JSON.stringify(outcome)}`);
  }
  return {
    partnerId: outcome.partnerId,
    ownerMemberId: outcome.ownerMemberId,
    email,
    password,
  };
}

async function deployFromEmpty(connectionString: string): Promise<void> {
  await execFileAsync(process.execPath, ["scripts/migrate-from-empty.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, PARTNER_MIGRATION_DATABASE_URL: connectionString },
    maxBuffer: 10 * 1024 * 1024,
  });
}

// **Validates: Requirements 2.1, 2.3, 2.4, 2.5, 2.6, 2.7, 4.1, 4.2, 4.3, 4.4**
describe.runIf(hasPostgres)("Partner auth and tenant isolation integration", () => {
  let database: DisposableTestDatabase;
  let client: PartnerDatabaseClient;

  beforeAll(async () => {
    database = await createDisposableTestDatabase(adminUrl);
    await deployFromEmpty(database.connectionString);
    client = createPartnerDatabaseClient({ databaseUrl: database.connectionString });
    await client.$connect();
  }, 120_000);

  afterAll(async () => {
    await client?.$disconnect();
    await database?.dispose();
  }, 30_000);

  // Requirement 2.3: credentials are stored as Argon2id hashes, never plaintext.
  describe("Argon2id password hash/verify", () => {
    it("hashes to a non-plaintext Argon2id string and verifies correctly", async () => {
      const harness = createHarness(client);
      const hash = await harness.passwordHasher.hash(VALID_PASSWORD);

      expect(hash).not.toContain(VALID_PASSWORD);
      expect(hash.startsWith("$argon2id$")).toBe(true);
      await expect(harness.passwordHasher.verify(hash, VALID_PASSWORD)).resolves.toBe(true);
      await expect(harness.passwordHasher.verify(hash, "wrong-password")).resolves.toBe(false);
    });

    it("never throws on a malformed stored hash (safe anti-enumeration path)", async () => {
      const harness = createHarness(client);
      await expect(harness.passwordHasher.verify("not-a-real-hash", VALID_PASSWORD))
        .resolves.toBe(false);
    });

    it("persists an Argon2id hash for a registered owner, not the plaintext", async () => {
      const harness = createHarness(client);
      const { email } = await registerOwner(harness);
      const member = await client.partnerMember.findUnique({
        where: { emailNormalized: email },
        select: { passwordHash: true },
      });
      expect(member?.passwordHash).toBeDefined();
      expect(member?.passwordHash).not.toContain(VALID_PASSWORD);
      expect(member?.passwordHash.startsWith("$argon2id$")).toBe(true);
    });
  });

  // Requirement 2.1: registering a Partner and its owner is a single atomic unit.
  describe("Atomic registration rollback", () => {
    it("rolls back the Partner insert when the owner email already exists", async () => {
      const harness = createHarness(client);
      const { email } = await registerOwner(harness);

      const partnersBefore = await client.partner.count();

      const second = await harness.register.register({
        legalName: "Second Legal Name",
        displayName: "Second Partner",
        email, // duplicate → owner insert violates the unique email
        password: VALID_PASSWORD,
        ip: "203.0.113.11",
      });

      expect(second).toEqual({ ok: false, reason: "email_taken" });
      // No orphan Partner row: the failed owner insert rolled the whole tx back.
      const partnersAfter = await client.partner.count();
      expect(partnersAfter).toBe(partnersBefore);
    });
  });

  // Requirement 2.5: auth responses are generic and never reveal account existence.
  describe("Generic auth errors (no user enumeration)", () => {
    it("returns the same invalid_credentials for unknown email and wrong password", async () => {
      const harness = createHarness(client);
      const { email } = await registerOwner(harness);

      const unknown = await harness.login.login({
        email: uniqueEmail("ghost"),
        password: VALID_PASSWORD,
        ip: "203.0.113.20",
      });
      const wrongPassword = await harness.login.login({
        email,
        password: "totally-wrong-password",
        ip: "203.0.113.21",
      });

      expect(unknown).toEqual({ ok: false, reason: "invalid_credentials" });
      expect(wrongPassword).toEqual({ ok: false, reason: "invalid_credentials" });
    });

    it("returns a generic ok for verification/reset requests on unknown emails", async () => {
      const harness = createHarness(client);
      await expect(
        harness.requestEmailVerification.request({ email: uniqueEmail("nobody"), ip: "203.0.113.22" }),
      ).resolves.toEqual({ ok: true });
      await expect(
        harness.requestPasswordReset.request({ email: uniqueEmail("nobody"), ip: "203.0.113.23" }),
      ).resolves.toEqual({ ok: true });
    });

    it("uses a decoy hash so an unknown email still runs a verification", async () => {
      // The decoy hash is a valid Argon2id string; verifying against it fails
      // closed but never throws, so timing does not distinguish a missing email.
      const harness = createHarness(client);
      await expect(harness.passwordHasher.verify(DECOY_PASSWORD_HASH, VALID_PASSWORD))
        .resolves.toBe(false);
    });
  });

  // Requirements 2.4/2.5: session idle and absolute expiry are enforced server-side.
  describe("Session idle and absolute expiry", () => {
    it("authenticates a fresh session and rejects it after the idle window lapses", async () => {
      const harness = createHarness(client);
      const { email, password, partnerId } = await registerOwner(harness);

      const loginOutcome = await harness.login.login({ email, password, ip: "203.0.113.30" });
      expect(loginOutcome.ok).toBe(true);
      if (!loginOutcome.ok) return;
      expect(loginOutcome.setCookieHeader).toContain(SESSION_COOKIE_NAME);

      const active = await harness.resolveSession.resolve(loginOutcome.token);
      expect(active.authenticated).toBe(true);
      if (active.authenticated) {
        expect(active.principal.partnerId).toBe(partnerId);
      }

      // Advance past the idle TTL without activity → session no longer resolves.
      harness.clock.advance(IDLE_TTL_SECONDS * 1_000 + 1_000);
      const idleExpired = await harness.resolveSession.resolve(loginOutcome.token);
      expect(idleExpired.authenticated).toBe(false);
    });

    it("enforces the absolute ceiling even when kept active by repeated use", async () => {
      const harness = createHarness(client);
      const { email, password } = await registerOwner(harness);
      const loginOutcome = await harness.login.login({ email, password, ip: "203.0.113.31" });
      expect(loginOutcome.ok).toBe(true);
      if (!loginOutcome.ok) return;

      // Slide the idle window forward repeatedly so idle expiry never triggers.
      harness.clock.set(BASE_EPOCH_MS + 3_000_000); // ~50 min
      expect((await harness.resolveSession.resolve(loginOutcome.token)).authenticated).toBe(true);
      harness.clock.set(BASE_EPOCH_MS + 6_000_000); // 100 min
      expect((await harness.resolveSession.resolve(loginOutcome.token)).authenticated).toBe(true);
      harness.clock.set(BASE_EPOCH_MS + 7_000_000); // ~116 min
      expect((await harness.resolveSession.resolve(loginOutcome.token)).authenticated).toBe(true);

      // Past the 2-hour absolute ceiling → rejected despite recent activity.
      harness.clock.set(BASE_EPOCH_MS + ABSOLUTE_TTL_SECONDS * 1_000 + 1_000);
      expect((await harness.resolveSession.resolve(loginOutcome.token)).authenticated).toBe(false);
    });

    it("revokes a session on logout (idempotently)", async () => {
      const harness = createHarness(client);
      const { email, password } = await registerOwner(harness);
      const loginOutcome = await harness.login.login({ email, password, ip: "203.0.113.32" });
      expect(loginOutcome.ok).toBe(true);
      if (!loginOutcome.ok) return;

      expect((await harness.resolveSession.resolve(loginOutcome.token)).authenticated).toBe(true);
      await harness.logout.logout(loginOutcome.token);
      expect((await harness.resolveSession.resolve(loginOutcome.token)).authenticated).toBe(false);
      // A repeat logout is a harmless no-op.
      await expect(harness.logout.logout(loginOutcome.token)).resolves.toMatchObject({
        setCookieHeader: expect.stringContaining(SESSION_COOKIE_NAME),
      });
    });
  });

  // Requirement 2.6: one-time verification/reset tokens expire and are single-use.
  describe("One-time token TTL expiry and single use", () => {
    it("verifies email within the 24h TTL, then rejects reuse and expiry", async () => {
      const harness = createHarness(client);
      const { email } = await registerOwner(harness);

      await expect(
        harness.requestEmailVerification.request({ email, ip: "203.0.113.40" }),
      ).resolves.toEqual({ ok: true });
      const token = harness.emailSender.lastToken();

      // Within TTL: consumes and activates the member.
      await expect(harness.verifyEmail.verify(token)).resolves.toEqual({ ok: true });
      const member = await client.partnerMember.findUnique({
        where: { emailNormalized: email },
        select: { status: true, emailVerifiedAt: true },
      });
      expect(member?.status).toBe("ACTIVE");
      expect(member?.emailVerifiedAt).not.toBeNull();

      // Single use: a second consumption is rejected generically.
      await expect(harness.verifyEmail.verify(token)).resolves.toEqual({
        ok: false,
        reason: "invalid_or_expired",
      });
    });

    it("rejects an email-verification token after the 24h TTL lapses", async () => {
      const harness = createHarness(client);
      const { email } = await registerOwner(harness);
      await harness.requestEmailVerification.request({ email, ip: "203.0.113.41" });
      const token = harness.emailSender.lastToken();

      harness.clock.advance(ONE_TIME_TOKEN_TTL_MS.email_verification + 1_000);
      await expect(harness.verifyEmail.verify(token)).resolves.toEqual({
        ok: false,
        reason: "invalid_or_expired",
      });
    });

    it("resets password within the 60m TTL and rejects it after expiry", async () => {
      const harness = createHarness(client);
      const { email, password } = await registerOwner(harness);

      // Within TTL: reset succeeds and the old password no longer authenticates.
      await harness.requestPasswordReset.request({ email, ip: "203.0.113.42" });
      const freshToken = harness.emailSender.lastToken();
      const newPassword = "BrandNewPassword2026!";
      await expect(
        harness.resetPassword.reset({ token: freshToken, newPassword }),
      ).resolves.toEqual({ ok: true });

      const withOld = await harness.login.login({ email, password, ip: "203.0.113.43" });
      expect(withOld).toEqual({ ok: false, reason: "invalid_credentials" });
      const withNew = await harness.login.login({ email, password: newPassword, ip: "203.0.113.44" });
      expect(withNew.ok).toBe(true);

      // A new token issued now must be rejected once the 60m TTL lapses.
      await harness.requestPasswordReset.request({ email, ip: "203.0.113.45" });
      const staleToken = harness.emailSender.lastToken();
      harness.clock.advance(ONE_TIME_TOKEN_TTL_MS.password_reset + 1_000);
      await expect(
        harness.resetPassword.reset({ token: staleToken, newPassword: "AnotherPassword2026!" }),
      ).resolves.toEqual({ ok: false, reason: "invalid_or_expired" });
    });
  });

  // Requirements 2.5/2.7: login, register, verify, and reset are rate limited.
  describe("Auth rate limits", () => {
    it("blocks login after the failure limit for a given email+IP", async () => {
      const harness = createHarness(client);
      const { email } = await registerOwner(harness);
      const ip = "203.0.113.50";

      for (let attempt = 0; attempt < LOGIN_RATE_LIMIT.limit; attempt += 1) {
        const outcome = await harness.login.login({ email, password: "wrong", ip });
        expect(outcome).toEqual({ ok: false, reason: "invalid_credentials" });
      }
      const blocked = await harness.login.login({ email, password: "wrong", ip });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.reason).toBe("rate_limited");
    });

    it("blocks registration after the per-email attempt limit", async () => {
      const harness = createHarness(client);
      const email = uniqueEmail("rl-register");
      const ip = "203.0.113.51";

      // First attempt succeeds; subsequent duplicates are email_taken but still
      // consume the per-email budget, so the limit is eventually reached.
      const first = await harness.register.register({
        legalName: "Legal",
        displayName: "Display",
        email,
        password: VALID_PASSWORD,
        ip,
      });
      expect(first.ok).toBe(true);

      let sawRateLimit = false;
      for (let attempt = 1; attempt < REGISTER_EMAIL_RATE_LIMIT.limit + 2; attempt += 1) {
        const outcome = await harness.register.register({
          legalName: "Legal",
          displayName: "Display",
          email,
          password: VALID_PASSWORD,
          ip,
        });
        if (!outcome.ok && outcome.reason === "rate_limited") {
          sawRateLimit = true;
          break;
        }
      }
      expect(sawRateLimit).toBe(true);
    });

    it("blocks verification and reset requests after their per-email limit", async () => {
      const harness = createHarness(client);
      const { email } = await registerOwner(harness);

      let verifyBlocked = false;
      for (let attempt = 0; attempt < REGISTER_EMAIL_RATE_LIMIT.limit + 2; attempt += 1) {
        const outcome = await harness.requestEmailVerification.request({ email, ip: "203.0.113.52" });
        if (!outcome.ok && outcome.reason === "rate_limited") {
          verifyBlocked = true;
          break;
        }
      }
      expect(verifyBlocked).toBe(true);

      let resetBlocked = false;
      for (let attempt = 0; attempt < REGISTER_EMAIL_RATE_LIMIT.limit + 2; attempt += 1) {
        const outcome = await harness.requestPasswordReset.request({ email, ip: "203.0.113.53" });
        if (!outcome.ok && outcome.reason === "rate_limited") {
          resetBlocked = true;
          break;
        }
      }
      expect(resetBlocked).toBe(true);
    });
  });

  // Requirement 4.4: sensitive member management is gated to the owner role.
  describe("Owner/member permission matrix", () => {
    function memberContext(partnerId: string, memberId: string): SessionContext {
      return toSessionContext({ memberId, partnerId, role: "member", securityVersion: 1 });
    }

    it("lets an owner invite a member and writes an audit event", async () => {
      const harness = createHarness(client);
      const { partnerId, ownerMemberId } = await registerOwner(harness);
      const ownerContext = toSessionContext({
        memberId: ownerMemberId,
        partnerId,
        role: "owner",
        securityVersion: 1,
      });

      const inviteEmail = uniqueEmail("invitee");
      const outcome = await harness.members.invite({
        caller: ownerContext,
        email: inviteEmail,
        role: "member",
        requestId: randomUUID(),
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.member.role).toBe("member");
      expect(outcome.member.partnerId).toBe(partnerId);

      const audit = await client.auditEvent.findFirst({
        where: { partnerId, action: "member.invited", targetId: outcome.member.id },
      });
      expect(audit).not.toBeNull();
    });

    it("forbids a member from inviting other members", async () => {
      const harness = createHarness(client);
      const { partnerId } = await registerOwner(harness);
      const outcome = await harness.members.invite({
        caller: memberContext(partnerId, randomUUID()),
        email: uniqueEmail("blocked"),
        role: "member",
        requestId: randomUUID(),
      });
      expect(outcome).toEqual({ ok: false, reason: "forbidden" });
    });
  });

  // Requirements 4.2/4.3: cross-tenant resource access is indistinguishable from
  // a missing resource (RESOURCE_NOT_FOUND), never a leak of another tenant's data.
  describe("Cross-tenant enumeration", () => {
    it("returns not-found when reading another tenant's member id", async () => {
      const harness = createHarness(client);
      const tenantA = await registerOwner(harness);
      const tenantB = await registerOwner(harness);

      const repoAsA = new PartnerMemberRepository(client, createTenantContext(tenantA.partnerId));
      // Tenant A cannot see tenant B's owner member — folded partnerId hides it.
      await expect(repoAsA.findById(tenantB.ownerMemberId)).resolves.toBeNull();
    });

    it("maps a cross-tenant update to RESOURCE_NOT_FOUND, not a silent edit", async () => {
      const harness = createHarness(client);
      const tenantA = await registerOwner(harness);
      const tenantB = await registerOwner(harness);

      const repoAsA = new PartnerMemberRepository(client, createTenantContext(tenantA.partnerId));
      await expect(
        repoAsA.update(tenantB.ownerMemberId, { status: "DISABLED" }),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);

      // Tenant B's owner is untouched.
      const untouched = await client.partnerMember.findUnique({
        where: { id: tenantB.ownerMemberId },
        select: { status: true },
      });
      expect(untouched?.status).toBe("PENDING_VERIFICATION");
    });
  });

  // Requirements 3.x/4.1: the Partner Admin realm is separate from tenant auth
  // and drives the approval lifecycle.
  describe("Partner Admin realm and approval lifecycle", () => {
    async function seedAdmin(
      harness: Harness,
      permissions: readonly string[] = [PARTNER_LIFECYCLE_PERMISSION],
    ): Promise<{ email: string; password: string }> {
      const email = uniqueEmail("admin");
      const passwordHash = await harness.passwordHasher.hash(VALID_PASSWORD);
      await client.partnerAdmin.create({
        data: {
          id: randomUUID(),
          emailNormalized: email,
          passwordHash,
          permissions: [...permissions],
          status: "ACTIVE",
        },
      });
      return { email, password: VALID_PASSWORD };
    }

    it("authenticates an admin under a distinct admin cookie and realm", async () => {
      const harness = createHarness(client);
      const { email, password } = await seedAdmin(harness);

      const outcome = await harness.adminLogin.login({ email, password, ip: "203.0.113.60" });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.setCookieHeader).toContain(ADMIN_SESSION_COOKIE_NAME);
      expect(outcome.setCookieHeader).not.toContain(SESSION_COOKIE_NAME + "=");

      const resolved = await harness.resolveAdminSession.resolve(outcome.token);
      expect(resolved.authenticated).toBe(true);
    });

    it("keeps the tenant and admin realms isolated (tokens do not cross)", async () => {
      const harness = createHarness(client);
      const { email, password } = await seedAdmin(harness);
      const owner = await registerOwner(harness);

      const adminOutcome = await harness.adminLogin.login({ email, password, ip: "203.0.113.61" });
      const ownerLogin = await harness.login.login({
        email: owner.email,
        password: owner.password,
        ip: "203.0.113.62",
      });
      expect(adminOutcome.ok && ownerLogin.ok).toBe(true);
      if (!adminOutcome.ok || !ownerLogin.ok) return;

      // A tenant session token is not a valid admin session, and vice versa.
      expect((await harness.resolveAdminSession.resolve(ownerLogin.token)).authenticated).toBe(false);
      expect((await harness.resolveSession.resolve(adminOutcome.token)).authenticated).toBe(false);
    });

    it("approves a pending partner and audits the status change", async () => {
      const harness = createHarness(client);
      const admin = await seedAdmin(harness);
      const owner = await registerOwner(harness);

      const adminOutcome = await harness.adminLogin.login({
        email: admin.email,
        password: admin.password,
        ip: "203.0.113.63",
      });
      expect(adminOutcome.ok).toBe(true);
      if (!adminOutcome.ok) return;

      const result = await harness.partnerLifecycle.execute({
        admin: adminOutcome.admin,
        partnerId: owner.partnerId,
        command: "approve",
        reason: "KYC review passed",
        requestId: randomUUID(),
      });
      expect(result).toEqual({ ok: true, status: "approved" });

      const partner = await client.partner.findUnique({
        where: { id: owner.partnerId },
        select: { status: true, approvedAt: true },
      });
      expect(partner?.status).toBe("APPROVED");
      expect(partner?.approvedAt).not.toBeNull();

      const audit = await client.auditEvent.findFirst({
        where: { partnerId: owner.partnerId, action: "partner.status_changed" },
      });
      expect(audit).not.toBeNull();
    });

    it("forbids partner lifecycle changes for an admin without the permission", async () => {
      const harness = createHarness(client);
      const admin = await seedAdmin(harness, []); // no lifecycle permission
      const owner = await registerOwner(harness);

      const adminOutcome = await harness.adminLogin.login({
        email: admin.email,
        password: admin.password,
        ip: "203.0.113.64",
      });
      expect(adminOutcome.ok).toBe(true);
      if (!adminOutcome.ok) return;

      const result = await harness.partnerLifecycle.execute({
        admin: adminOutcome.admin,
        partnerId: owner.partnerId,
        command: "approve",
        reason: "should be blocked",
        requestId: randomUUID(),
      });
      expect(result).toEqual({ ok: false, reason: "forbidden" });

      const partner = await client.partner.findUnique({
        where: { id: owner.partnerId },
        select: { status: true },
      });
      expect(partner?.status).toBe("PENDING");
    });
  });
});
