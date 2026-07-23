/**
 * Consume a password-reset token and set a new password.
 *
 * The new password is validated against policy first, then the raw token is
 * hashed and validated by the pure {@link consumeOneTimeToken} (single-use,
 * expiry, type). The effect — mark token used, store the new hash, bump the
 * member's security version — runs atomically; the version bump revokes all
 * existing sessions (design.md section 1). The DB single-use guard means
 * concurrent redemptions yield at most one success (requirement 2.6/2.7).
 */
import { validatePassword, type IdentityFailureCode } from "@domain/task-5-1/identity";
import { consumeOneTimeToken } from "@domain/task-5-1/one-time-token";

import type {
  Clock,
  OneTimeTokenGateway,
  OneTimeTokenIssuer,
  PasswordHasher,
} from "./ports";

export interface ResetPasswordInput {
  readonly token: string;
  readonly newPassword: string;
}

export type ResetPasswordOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "invalid_or_expired" }
  | { readonly ok: false; readonly reason: "weak_password"; readonly code: IdentityFailureCode };

const INVALID: ResetPasswordOutcome = Object.freeze({
  ok: false,
  reason: "invalid_or_expired",
});

export interface ResetPasswordServiceDeps {
  readonly tokens: OneTimeTokenGateway;
  readonly tokenIssuer: OneTimeTokenIssuer;
  readonly passwordHasher: PasswordHasher;
  readonly clock: Clock;
}

export class ResetPasswordService {
  private readonly deps: ResetPasswordServiceDeps;

  constructor(deps: ResetPasswordServiceDeps) {
    this.deps = deps;
  }

  async reset(input: ResetPasswordInput): Promise<ResetPasswordOutcome> {
    const passwordValidation = validatePassword(input.newPassword);
    if (!passwordValidation.valid) {
      return { ok: false, reason: "weak_password", code: passwordValidation.code };
    }
    if (!input.token) return INVALID;

    const tokenHash = this.deps.tokenIssuer.hashToken(input.token);
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
      expectedType: "password_reset",
      presentedTokenHash: tokenHash,
      nowEpochMs: now,
    });
    if (!result.consumed) return INVALID;

    const newPasswordHash = await this.deps.passwordHasher.hash(input.newPassword);
    const applied = await this.deps.tokens.applyPasswordReset(
      stored.id,
      stored.memberId,
      stored.partnerId,
      now,
      newPasswordHash,
    );
    return applied ? { ok: true } : INVALID;
  }
}
