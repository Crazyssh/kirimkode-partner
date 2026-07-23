/**
 * Authenticate a Partner Admin and open an admin-realm session.
 *
 * This is the `/admin` login path, entirely separate from tenant login: it
 * resolves a {@link PartnerAdmin} account (not a partner member), issues a
 * session under the `__Host-partner_admin_session` cookie, and never derives a
 * `partnerId`. The flow is enumeration-safe — it always runs a password
 * verification (against the stored hash when the account exists, against a
 * decoy hash otherwise) and collapses every failure into one generic outcome.
 * Admin login failures are rate-limited per (email+IP); a success clears the
 * counter.
 */
import { normalizeEmail } from "@domain/task-5-1/identity";
import {
  canAdminLogin,
  createAdminSessionRecord,
  type AuthenticatedAdmin,
  type SessionTtlPolicy,
} from "@domain/task-7-5";

import type { AuthRateLimiter } from "@application/auth/auth-rate-limiter";

import { ADMIN_LOGIN_RATE_LIMIT, adminLoginRateLimitKey } from "./admin-config";
import {
  buildAdminSessionCookie,
  serializeAdminSessionCookie,
  type AdminSessionCookieAttributes,
} from "./admin-session-cookie";
import type {
  AdminIdentityGateway,
  AdminPasswordHasher,
  AdminSessionGateway,
  AdminSessionTokenIssuer,
  Clock,
  IdGenerator,
} from "./ports";

const UNKNOWN_IP = "unknown";

export interface AdminLoginInput {
  readonly email: string;
  readonly password: string;
  readonly ip: string;
}

export type AdminLoginOutcome =
  | {
      readonly ok: true;
      readonly admin: AuthenticatedAdmin;
      /** Raw token; returned once so the caller can set the cookie. */
      readonly token: string;
      readonly cookie: AdminSessionCookieAttributes;
      readonly setCookieHeader: string;
      readonly expiresAtEpochMs: number;
    }
  | { readonly ok: false; readonly reason: "invalid_credentials" }
  | { readonly ok: false; readonly reason: "rate_limited"; readonly retryAfterMs: number };

export interface AdminLoginServiceDeps {
  readonly identity: AdminIdentityGateway;
  readonly passwordHasher: AdminPasswordHasher;
  readonly sessions: AdminSessionGateway;
  readonly tokenIssuer: AdminSessionTokenIssuer;
  readonly rateLimiter: AuthRateLimiter;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly ttl: SessionTtlPolicy;
}

export class AdminLoginService {
  private readonly deps: AdminLoginServiceDeps;

  constructor(deps: AdminLoginServiceDeps) {
    this.deps = deps;
  }

  async login(input: AdminLoginInput): Promise<AdminLoginOutcome> {
    const emailNormalized = normalizeEmail(input.email);
    const ip = input.ip.trim() || UNKNOWN_IP;
    const key = adminLoginRateLimitKey(emailNormalized, ip);

    const gate = await this.deps.rateLimiter.check(key, ADMIN_LOGIN_RATE_LIMIT);
    if (!gate.allowed) {
      return { ok: false, reason: "rate_limited", retryAfterMs: gate.retryAfterMs };
    }

    const admin = await this.deps.identity.findAdminByEmail(emailNormalized);
    // Always run a verification so timing does not reveal whether the email
    // exists; use a decoy hash when it does not.
    const hashToCheck = admin?.passwordHash ?? this.deps.passwordHasher.decoyHash;
    const passwordMatches = await this.deps.passwordHasher.verify(
      hashToCheck,
      input.password,
    );

    const authenticated =
      admin !== null && passwordMatches && canAdminLogin(admin.status);

    if (!authenticated) {
      await this.deps.rateLimiter.penalize(key, ADMIN_LOGIN_RATE_LIMIT);
      return { ok: false, reason: "invalid_credentials" };
    }

    await this.deps.rateLimiter.clear(key);

    const now = this.deps.clock.nowEpochMs();
    const { token, tokenHash } = this.deps.tokenIssuer.issue();
    const session = createAdminSessionRecord({
      id: this.deps.idGenerator.uuid(),
      adminId: admin.adminId,
      tokenHash,
      securityVersion: admin.securityVersion,
      createdAtEpochMs: now,
      ttl: this.deps.ttl,
    });
    await this.deps.sessions.create(session);

    const maxAgeSeconds = Math.floor(this.deps.ttl.absoluteTtlMs / 1_000);
    const cookie = buildAdminSessionCookie(token, maxAgeSeconds);

    return {
      ok: true,
      admin: {
        adminId: admin.adminId,
        permissions: admin.permissions,
        securityVersion: admin.securityVersion,
      },
      token,
      cookie,
      setCookieHeader: serializeAdminSessionCookie(cookie),
      expiresAtEpochMs: session.expiresAtEpochMs,
    };
  }
}
