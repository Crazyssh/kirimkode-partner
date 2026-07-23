/**
 * Consume an email-verification token and mark the member's email verified.
 *
 * The presented raw token is hashed and looked up; the pure domain
 * {@link consumeOneTimeToken} enforces the single-use, expiry, and type checks
 * before any effect. The effect (mark used + verify member) runs atomically in
 * the gateway, and the DB single-use guard makes concurrent redemptions resolve
 * to at most one success (requirement 2.6). Failure reasons are collapsed for
 * the transport so a caller cannot probe token existence.
 */
import { consumeOneTimeToken } from "@domain/task-5-1/one-time-token";

import type { Clock, OneTimeTokenGateway, OneTimeTokenIssuer } from "./ports";

export type VerifyEmailOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "invalid_or_expired" };

const INVALID: VerifyEmailOutcome = Object.freeze({
  ok: false,
  reason: "invalid_or_expired",
});

export interface VerifyEmailServiceDeps {
  readonly tokens: OneTimeTokenGateway;
  readonly tokenIssuer: OneTimeTokenIssuer;
  readonly clock: Clock;
}

export class VerifyEmailService {
  private readonly deps: VerifyEmailServiceDeps;

  constructor(deps: VerifyEmailServiceDeps) {
    this.deps = deps;
  }

  async verify(rawToken: string | null | undefined): Promise<VerifyEmailOutcome> {
    if (!rawToken) return INVALID;

    const tokenHash = this.deps.tokenIssuer.hashToken(rawToken);
    const stored = await this.deps.tokens.findByTokenHash(tokenHash);
    if (stored === null) return INVALID;

    const now = this.deps.clock.nowEpochMs();
    const result = consumeOneTimeToken({
      token: {
        id: stored.id,
        memberId: stored.memberId,
        type: stored.type,
        tokenHash: stored.tokenHash,
        issuedAtEpochMs: stored.issuedAtEpochMs,
        expiresAtEpochMs: stored.expiresAtEpochMs,
        usedAtEpochMs: stored.usedAtEpochMs,
      },
      expectedMemberId: stored.memberId,
      expectedType: "email_verification",
      presentedTokenHash: tokenHash,
      nowEpochMs: now,
    });
    if (!result.consumed) return INVALID;

    const applied = await this.deps.tokens.applyEmailVerification(
      stored.id,
      stored.memberId,
      stored.partnerId,
      now,
    );
    return applied ? { ok: true } : INVALID;
  }
}
