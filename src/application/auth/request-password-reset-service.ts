/**
 * Issue a password-reset token and send the reset email.
 *
 * Like verification requests, the outcome is generic regardless of whether the
 * email maps to a member, so the endpoint cannot enumerate accounts
 * (requirement 2.7). Each attempt is rate limited per email and per IP.
 * Issuing a new token invalidates prior unused reset tokens (design.md section
 * 1). Delivery is best-effort and never reveals the token (requirement 19.6).
 */
import { normalizeEmail } from "@domain/task-5-1/identity";
import { issueOneTimeToken } from "@domain/task-5-1/one-time-token";

import { buildPasswordResetMessage } from "./auth-email";
import {
  EMAIL_ACTION_EMAIL_RATE_LIMIT,
  EMAIL_ACTION_IP_RATE_LIMIT,
  passwordResetRequestEmailRateLimitKey,
  passwordResetRequestIpRateLimitKey,
} from "./auth-config";
import type { AuthRateLimiter } from "./auth-rate-limiter";
import type {
  AuthIdentityGateway,
  Clock,
  EmailSender,
  IdGenerator,
  OneTimeTokenGateway,
  OneTimeTokenIssuer,
} from "./ports";

const UNKNOWN_IP = "unknown";

export interface RequestPasswordResetInput {
  readonly email: string;
  readonly ip: string;
}

export type RequestPasswordResetOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "rate_limited"; readonly retryAfterMs: number };

export interface RequestPasswordResetServiceDeps {
  readonly identity: AuthIdentityGateway;
  readonly tokens: OneTimeTokenGateway;
  readonly tokenIssuer: OneTimeTokenIssuer;
  readonly emailSender: EmailSender;
  readonly rateLimiter: AuthRateLimiter;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly portalOrigin: string;
}

export class RequestPasswordResetService {
  private readonly deps: RequestPasswordResetServiceDeps;

  constructor(deps: RequestPasswordResetServiceDeps) {
    this.deps = deps;
  }

  async request(input: RequestPasswordResetInput): Promise<RequestPasswordResetOutcome> {
    const emailNormalized = normalizeEmail(input.email);
    const ip = input.ip.trim() || UNKNOWN_IP;

    const emailKey = passwordResetRequestEmailRateLimitKey(emailNormalized);
    const ipKey = passwordResetRequestIpRateLimitKey(ip);
    const emailDecision = await this.deps.rateLimiter.check(emailKey, EMAIL_ACTION_EMAIL_RATE_LIMIT);
    const ipDecision = await this.deps.rateLimiter.check(ipKey, EMAIL_ACTION_IP_RATE_LIMIT);
    if (!emailDecision.allowed || !ipDecision.allowed) {
      return {
        ok: false,
        reason: "rate_limited",
        retryAfterMs: Math.max(emailDecision.retryAfterMs, ipDecision.retryAfterMs),
      };
    }
    await this.deps.rateLimiter.penalize(emailKey, EMAIL_ACTION_EMAIL_RATE_LIMIT);
    await this.deps.rateLimiter.penalize(ipKey, EMAIL_ACTION_IP_RATE_LIMIT);

    const member = await this.deps.identity.findMemberByEmail(emailNormalized);
    if (member !== null) {
      const now = this.deps.clock.nowEpochMs();
      const { token, tokenHash } = this.deps.tokenIssuer.issue();
      const record = issueOneTimeToken({
        id: this.deps.idGenerator.uuid(),
        memberId: member.memberId,
        type: "password_reset",
        tokenHash,
        issuedAtEpochMs: now,
      });
      await this.deps.tokens.issue(
        {
          id: record.id,
          memberId: member.memberId,
          partnerId: member.partnerId,
          type: "password_reset",
          tokenHash: record.tokenHash,
          issuedAtEpochMs: record.issuedAtEpochMs,
          expiresAtEpochMs: record.expiresAtEpochMs,
        },
        now,
      );
      await this.sendQuietly(emailNormalized, token);
    }

    return { ok: true };
  }

  private async sendQuietly(to: string, rawToken: string): Promise<void> {
    try {
      await this.deps.emailSender.send(
        buildPasswordResetMessage(to, this.deps.portalOrigin, rawToken),
      );
    } catch {
      // Intentionally ignored: never reveal delivery state or the token.
    }
  }
}
