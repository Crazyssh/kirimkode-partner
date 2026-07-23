/**
 * Resolve a presented session token into an authenticated principal.
 *
 * This is the read path used by portal/admin middleware on every request. It
 * hashes the presented token, loads the session joined to its member, and lets
 * the pure policy decide activity (revocation, absolute/idle expiry, security
 * version). A disabled/suspended member is rejected even without a version
 * bump. When active, the idle window is slid forward. The `partnerId` a caller
 * later uses for tenant scoping comes only from here — never from the client.
 */
import {
  canMemberLogin,
  evaluateSession,
  type AuthenticatedPrincipal,
  type SessionTtlPolicy,
} from "@domain/task-7-2";

import type { Clock, SessionGateway, SessionTokenIssuer } from "./ports";

export type ResolveSessionOutcome =
  | { readonly authenticated: true; readonly principal: AuthenticatedPrincipal }
  | { readonly authenticated: false };

const UNAUTHENTICATED: ResolveSessionOutcome = Object.freeze({ authenticated: false });

export interface ResolveSessionServiceDeps {
  readonly sessions: SessionGateway;
  readonly tokenIssuer: SessionTokenIssuer;
  readonly clock: Clock;
  readonly ttl: SessionTtlPolicy;
}

export class ResolveSessionService {
  private readonly deps: ResolveSessionServiceDeps;

  constructor(deps: ResolveSessionServiceDeps) {
    this.deps = deps;
  }

  async resolve(token: string | null | undefined): Promise<ResolveSessionOutcome> {
    if (!token) return UNAUTHENTICATED;

    const tokenHash = this.deps.tokenIssuer.hashToken(token);
    const context = await this.deps.sessions.findByTokenHash(tokenHash);
    if (context === null) return UNAUTHENTICATED;

    const now = this.deps.clock.nowEpochMs();
    const evaluation = evaluateSession({
      session: context.session,
      nowEpochMs: now,
      currentSecurityVersion: context.currentSecurityVersion,
      idleTtlMs: this.deps.ttl.idleTtlMs,
    });
    if (!evaluation.active || !canMemberLogin(context.status)) {
      return UNAUTHENTICATED;
    }

    await this.deps.sessions.slideIdleExpiry(
      tokenHash,
      evaluation.slideIdleExpiryToEpochMs,
      now,
    );

    return {
      authenticated: true,
      principal: {
        memberId: context.session.memberId,
        partnerId: context.session.partnerId,
        role: context.role,
        securityVersion: context.currentSecurityVersion,
      },
    };
  }
}
