/**
 * Revoke an admin session and clear its cookie.
 *
 * Logout is idempotent: hashing a missing or already-revoked token revokes
 * nothing but still returns the cleared-cookie header, so repeated or
 * unauthenticated logout calls are harmless.
 */
import { serializeClearedAdminSessionCookie } from "./admin-session-cookie";
import type { AdminSessionGateway, AdminSessionTokenIssuer, Clock } from "./ports";

export interface AdminLogoutResult {
  readonly setCookieHeader: string;
}

export interface AdminLogoutServiceDeps {
  readonly sessions: AdminSessionGateway;
  readonly tokenIssuer: AdminSessionTokenIssuer;
  readonly clock: Clock;
}

export class AdminLogoutService {
  private readonly deps: AdminLogoutServiceDeps;

  constructor(deps: AdminLogoutServiceDeps) {
    this.deps = deps;
  }

  async logout(token: string | null | undefined): Promise<AdminLogoutResult> {
    if (token) {
      const tokenHash = this.deps.tokenIssuer.hashToken(token);
      await this.deps.sessions.revokeByTokenHash(
        tokenHash,
        this.deps.clock.nowEpochMs(),
      );
    }
    return { setCookieHeader: serializeClearedAdminSessionCookie() };
  }
}
