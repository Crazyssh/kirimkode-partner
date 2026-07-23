/**
 * Revoke a session and clear its cookie.
 *
 * Logout is idempotent: hashing a missing or already-revoked token revokes
 * nothing but still returns the cleared-cookie header, so repeated or
 * unauthenticated logout calls are harmless.
 */
import { serializeClearedSessionCookie } from "./session-cookie";
import type { Clock, SessionGateway, SessionTokenIssuer } from "./ports";

export interface LogoutResult {
  readonly setCookieHeader: string;
}

export interface LogoutServiceDeps {
  readonly sessions: SessionGateway;
  readonly tokenIssuer: SessionTokenIssuer;
  readonly clock: Clock;
}

export class LogoutService {
  private readonly deps: LogoutServiceDeps;

  constructor(deps: LogoutServiceDeps) {
    this.deps = deps;
  }

  async logout(token: string | null | undefined): Promise<LogoutResult> {
    if (token) {
      const tokenHash = this.deps.tokenIssuer.hashToken(token);
      await this.deps.sessions.revokeByTokenHash(tokenHash, this.deps.clock.nowEpochMs());
    }
    return { setCookieHeader: serializeClearedSessionCookie() };
  }
}
