/**
 * Admin session authorization service — the `/admin` server-side "middleware".
 *
 * Admin route handlers and server components call this before doing admin work:
 * it turns a presented admin session cookie token into a trusted
 * {@link AuthenticatedAdmin} and optionally enforces a required permission. It
 * never trusts a client-supplied permission; permissions are derived from the
 * resolved admin session. Keeping the dependency as a narrow
 * {@link AdminSessionResolver} port lets it be unit-tested with an in-memory
 * fake (requirements 16.1, 16.2).
 */
import { adminHasPermission, type AuthenticatedAdmin } from "@domain/task-7-5";

import type { ResolveAdminSessionOutcome } from "./resolve-admin-session-service";

/** The read path used to resolve a presented token; ResolveAdminSessionService fits. */
export interface AdminSessionResolver {
  resolve(token: string | null | undefined): Promise<ResolveAdminSessionOutcome>;
}

export type AuthorizeAdminOutcome =
  | { readonly ok: true; readonly admin: AuthenticatedAdmin }
  | { readonly ok: false; readonly reason: "unauthenticated" };

export type AuthorizeAdminPermissionOutcome =
  | { readonly ok: true; readonly admin: AuthenticatedAdmin }
  | { readonly ok: false; readonly reason: "unauthenticated" }
  | { readonly ok: false; readonly reason: "forbidden" };

export interface AdminAuthorizationServiceDeps {
  readonly sessionResolver: AdminSessionResolver;
}

export class AdminAuthorizationService {
  private readonly deps: AdminAuthorizationServiceDeps;

  constructor(deps: AdminAuthorizationServiceDeps) {
    this.deps = deps;
  }

  /**
   * Resolve a presented admin session token into an {@link AuthenticatedAdmin}.
   * Returns a generic `unauthenticated` result for any missing/expired/revoked
   * session so callers cannot distinguish the failure mode.
   */
  async authorize(token: string | null | undefined): Promise<AuthorizeAdminOutcome> {
    const outcome = await this.deps.sessionResolver.resolve(token);
    if (!outcome.authenticated) {
      return { ok: false, reason: "unauthenticated" };
    }
    return { ok: true, admin: outcome.admin };
  }

  /**
   * Resolve an admin session and require a permission in one step.
   * Unauthenticated sessions are rejected before the permission is evaluated;
   * an authenticated admin lacking the permission is `forbidden`.
   */
  async authorizePermission(
    token: string | null | undefined,
    permission: string,
  ): Promise<AuthorizeAdminPermissionOutcome> {
    const authorized = await this.authorize(token);
    if (!authorized.ok) {
      return authorized;
    }
    if (!adminHasPermission(authorized.admin.permissions, permission)) {
      return { ok: false, reason: "forbidden" };
    }
    return { ok: true, admin: authorized.admin };
  }
}
