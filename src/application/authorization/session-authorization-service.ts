/**
 * Session authorization service — the server-side "middleware" seam.
 *
 * Route handlers, server components, and admin/portal actions call this before
 * doing tenant work: it turns a presented session cookie token into a trusted
 * {@link SessionContext} (principal + validated tenant scope) and optionally
 * enforces a required permission. It never trusts a client-supplied tenant id
 * or role; both are derived from the resolved session (task 7.2). Keeping the
 * dependency as a narrow {@link SessionResolver} port lets it be unit-tested
 * with an in-memory fake and reused wherever a session must be authorized
 * (requirements 4.1, 4.2, 4.4).
 */
import type { TenantOperation } from "@domain/task-5-1/tenant-policy";

import type { ResolveSessionOutcome } from "../auth/resolve-session-service";
import {
  checkPermission,
  toSessionContext,
  type SessionContext,
} from "./session-context";

/** The read path used to resolve a presented token; ResolveSessionService fits. */
export interface SessionResolver {
  resolve(token: string | null | undefined): Promise<ResolveSessionOutcome>;
}

export type AuthorizeOutcome =
  | { readonly ok: true; readonly context: SessionContext }
  | { readonly ok: false; readonly reason: "unauthenticated" };

export type AuthorizeOperationOutcome =
  | { readonly ok: true; readonly context: SessionContext }
  | { readonly ok: false; readonly reason: "unauthenticated" }
  | { readonly ok: false; readonly reason: "forbidden" };

export interface SessionAuthorizationServiceDeps {
  readonly sessionResolver: SessionResolver;
}

export class SessionAuthorizationService {
  private readonly deps: SessionAuthorizationServiceDeps;

  constructor(deps: SessionAuthorizationServiceDeps) {
    this.deps = deps;
  }

  /**
   * Resolve a presented session token into a {@link SessionContext}. Returns a
   * generic `unauthenticated` result for any missing/expired/revoked session so
   * callers cannot distinguish the failure mode.
   */
  async authorize(token: string | null | undefined): Promise<AuthorizeOutcome> {
    const outcome = await this.deps.sessionResolver.resolve(token);
    if (!outcome.authenticated) {
      return { ok: false, reason: "unauthenticated" };
    }
    return { ok: true, context: toSessionContext(outcome.principal) };
  }

  /**
   * Resolve a session and require a sensitive-operation permission in one step.
   * Unauthenticated sessions are rejected before the permission is evaluated;
   * an authenticated principal lacking the permission is `forbidden`.
   */
  async authorizeOperation(
    token: string | null | undefined,
    operation: TenantOperation,
  ): Promise<AuthorizeOperationOutcome> {
    const authorized = await this.authorize(token);
    if (!authorized.ok) {
      return authorized;
    }
    const permission = checkPermission(authorized.context, operation);
    if (!permission.allowed) {
      return { ok: false, reason: "forbidden" };
    }
    return { ok: true, context: authorized.context };
  }
}
