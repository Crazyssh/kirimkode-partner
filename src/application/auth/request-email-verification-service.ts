/**
 * Issue an email-verification token and send the verification email.
 *
 * The response is deliberately generic: whether or not the email maps to a
 * member (or is already verified), the caller sees the same `{ ok: true }`
 * acknowledgement so the endpoint cannot be used to enumerate accounts
 * (requirement 2.6/2.7). Every reaching attempt is rate limited per email and
 * per IP before any work. Issuing a new token invalidates prior unused
 * verification tokens (design.md section 1). Email delivery is best-effort:
 * an SMTP failure never changes the generic outcome and never surfaces the
 * token (requirement 19.6).
 */
import { normalizeEmail } from "@domain/task-5-1/identity";
import { issueOneTimeToken } from "@domain/task-5-1/one-time-token";

import { buildEmailVerificationMessage } from "./auth-email";
import {
  EMAIL_ACTION_EMAIL_RATE_LIMIT,
  EMAIL_ACTION_IP_RATE_LIMIT,
  verifyEmailRequestEmailRateLimitKey,
  verifyEmailRequestIpRateLimitKey,
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

export interface RequestEmailVerificationInput {
  readonly email: string;
  readonly ip: string;
}

export type RequestEmailVerificationOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "rate_limited"; readonly retryAfterMs: number };

export interface RequestEmailVerificationServiceDeps {
  readonly identity: AuthIdentityGateway;
  readonly tokens: OneTimeTokenGateway;
  readonly tokenIssuer: OneTimeTokenIssuer;
  readonly emailSender: EmailSender;
  readonly rateLimiter: AuthRateLimiter;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly portalOrigin: string;
}

export class RequestEmailVerificationService {
  private readonly deps: RequestEmailVerificationServiceDeps;

  constructor(deps: RequestEmailVerificationServiceDeps) {
    this.deps = deps;
  }

  async request(
    input: RequestEmailVerificationInput,
  ): Promise<RequestEmailVerificationOutcome> {
    const emailNormalized = normalizeEmail(input.email);
    const ip = input.ip.trim() || UNKNOWN_IP;

    const emailKey = verifyEmailRequestEmailRateLimitKey(emailNormalized);
    const ipKey = verifyEmailRequestIpRateLimitKey(ip);
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
    // Only issue for a member still awaiting verification; every other case
    // returns the identical generic acknowledgement below.
    if (member !== null && member.status === "pending_verification") {
      const now = this.deps.clock.nowEpochMs();
      const { token, tokenHash } = this.deps.tokenIssuer.issue();
      const record = issueOneTimeToken({
        id: this.deps.idGenerator.uuid(),
        memberId: member.memberId,
        type: "email_verification",
        tokenHash,
        issuedAtEpochMs: now,
      });
      await this.deps.tokens.issue(
        {
          id: record.id,
          memberId: member.memberId,
          partnerId: member.partnerId,
          type: "email_verification",
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

  /** Best-effort delivery; swallow failures so the response stays generic. */
  private async sendQuietly(to: string, rawToken: string): Promise<void> {
    try {
      await this.deps.emailSender.send(
        buildEmailVerificationMessage(to, this.deps.portalOrigin, rawToken),
      );
    } catch {
      // Intentionally ignored: never reveal delivery state or the token.
    }
  }
}
