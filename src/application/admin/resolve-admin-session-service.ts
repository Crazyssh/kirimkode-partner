/**
 * Resolve a presented admin session token into an authenticated admin.
 *
 * This is the read path used by `/admin` route handlers and server components
 * on every request. It hashes the presented token, loads the admin session
 * joined to its admin, and lets the pure policy decide activity (revocation,
 * absolute/idle expiry, security version). A disabled admin is rejected even
 * without a version bump. When active, the idle window is slid forward. The
 * `permissions` a caller later uses to gate a command come only from here —
 * never from the client.
 */
import {
  canAdminLogin,
  evaluateAdminSession,
  type AuthenticatedAdmin,
  type SessionTtlPolicy,
} from "@domain/task-7-5";

import type { AdminSessionGateway, AdminSessionTokenIssuer, Clock } from "./ports";

export type ResolveAdminSessionOutcome =
  | { readonly authenticated: true; readonly admin: AuthenticatedAdmin }
  | { readonly authenticated: false };

const UNAUTHENTICATED: ResolveAdminSessionOutcome = Object.freeze({
  authenticated: false,
});

export interface ResolveAdminSessionServiceDeps {
  readonly sessions: AdminSessionGateway;
  readonly tokenIssuer: AdminSessionTokenIssuer;
  readonly clock: Clock;
  readonly ttl: SessionTtlPolicy;
}

export class ResolveAdminSessionService {
  private readonly deps: ResolveAdminSessionServiceDeps;

  constructor(deps: ResolveAdminSessionServiceDeps) {
    this.deps = deps;
  }

  async resolve(token: string | null | undefined): Promise<ResolveAdminSessionOutcome> {
    if (!token) return UNAUTHENTICATED;

    const tokenHash = this.deps.tokenIssuer.hashToken(token);
    const context = await this.deps.sessions.findByTokenHash(tokenHash);
    if (context === null) return UNAUTHENTICATED;

    const now = this.deps.clock.nowEpochMs();
    const evaluation = evaluateAdminSession({
      session: context.session,
      nowEpochMs: now,
      currentSecurityVersion: context.currentSecurityVersion,
      idleTtlMs: this.deps.ttl.idleTtlMs,
    });
    if (!evaluation.active || !canAdminLogin(context.status)) {
      return UNAUTHENTICATED;
    }

    await this.deps.sessions.slideIdleExpiry(
      tokenHash,
      evaluation.slideIdleExpiryToEpochMs,
      now,
    );

    return {
      authenticated: true,
      admin: {
        adminId: context.session.adminId,
        permissions: context.permissions,
        securityVersion: context.currentSecurityVersion,
      },
    };
  }
}
