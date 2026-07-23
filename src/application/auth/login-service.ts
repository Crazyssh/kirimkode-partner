/**
 * Authenticate a member and open a session.
 *
 * The flow is enumeration-safe: it always runs a password verification (against
 * the stored hash when the account exists, against a decoy hash otherwise) and
 * collapses every failure into one generic outcome (requirement 2.5). On
 * success it issues an opaque session token, persists only its hash, and
 * returns the cookie to set. Login failures are rate-limited per (email+IP);
 * a success clears the counter.
 */
import { createSessionRecord, evaluateLogin, type AuthenticatedPrincipal } from "@domain/task-7-2";
import type { SessionTtlPolicy } from "@domain/task-7-2";
import { normalizeEmail } from "@domain/task-5-1/identity";

import { LOGIN_RATE_LIMIT, loginRateLimitKey } from "./auth-config";
import type { AuthRateLimiter } from "./auth-rate-limiter";
import {
  buildSessionCookie,
  serializeSessionCookie,
  type SessionCookieAttributes,
} from "./session-cookie";
import type {
  AuthIdentityGateway,
  Clock,
  IdGenerator,
  PasswordHasher,
  SessionGateway,
  SessionTokenIssuer,
} from "./ports";

const UNKNOWN_IP = "unknown";

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly ip: string;
}

export type LoginOutcome =
  | {
      readonly ok: true;
      readonly principal: AuthenticatedPrincipal;
      /** Raw token; returned once so the caller can set the cookie. */
      readonly token: string;
      readonly cookie: SessionCookieAttributes;
      readonly setCookieHeader: string;
      readonly expiresAtEpochMs: number;
    }
  | { readonly ok: false; readonly reason: "invalid_credentials" }
  | { readonly ok: false; readonly reason: "rate_limited"; readonly retryAfterMs: number };

export interface LoginServiceDeps {
  readonly identity: AuthIdentityGateway;
  readonly passwordHasher: PasswordHasher;
  readonly sessions: SessionGateway;
  readonly tokenIssuer: SessionTokenIssuer;
  readonly rateLimiter: AuthRateLimiter;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly ttl: SessionTtlPolicy;
}

export class LoginService {
  private readonly deps: LoginServiceDeps;

  constructor(deps: LoginServiceDeps) {
    this.deps = deps;
  }

  async login(input: LoginInput): Promise<LoginOutcome> {
    const emailNormalized = normalizeEmail(input.email);
    const ip = input.ip.trim() || UNKNOWN_IP;
    const key = loginRateLimitKey(emailNormalized, ip);

    const gate = await this.deps.rateLimiter.check(key, LOGIN_RATE_LIMIT);
    if (!gate.allowed) {
      return { ok: false, reason: "rate_limited", retryAfterMs: gate.retryAfterMs };
    }

    const member = await this.deps.identity.findMemberByEmail(emailNormalized);
    // Always run a verification so timing does not reveal whether the email
    // exists; use a decoy hash when it does not.
    const hashToCheck = member?.passwordHash ?? this.deps.passwordHasher.decoyHash;
    const passwordMatches = await this.deps.passwordHasher.verify(hashToCheck, input.password);

    const decision = evaluateLogin({
      memberFound: member !== null,
      passwordMatches,
      candidate:
        member === null
          ? undefined
          : {
              memberId: member.memberId,
              partnerId: member.partnerId,
              role: member.role,
              securityVersion: member.securityVersion,
              status: member.status,
            },
    });

    if (!decision.authenticated) {
      await this.deps.rateLimiter.penalize(key, LOGIN_RATE_LIMIT);
      return { ok: false, reason: "invalid_credentials" };
    }

    await this.deps.rateLimiter.clear(key);

    const now = this.deps.clock.nowEpochMs();
    const { token, tokenHash } = this.deps.tokenIssuer.issue();
    const session = createSessionRecord({
      id: this.deps.idGenerator.uuid(),
      memberId: decision.principal.memberId,
      partnerId: decision.principal.partnerId,
      tokenHash,
      securityVersion: decision.principal.securityVersion,
      createdAtEpochMs: now,
      ttl: this.deps.ttl,
    });
    await this.deps.sessions.create(session);

    const maxAgeSeconds = Math.floor(this.deps.ttl.absoluteTtlMs / 1_000);
    const cookie = buildSessionCookie(token, maxAgeSeconds);

    return {
      ok: true,
      principal: decision.principal,
      token,
      cookie,
      setCookieHeader: serializeSessionCookie(cookie),
      expiresAtEpochMs: session.expiresAtEpochMs,
    };
  }
}
