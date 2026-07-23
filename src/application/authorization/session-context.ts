/**
 * Server-side session context and tenant authorization helpers.
 *
 * A `SessionContext` is the trusted, server-derived view of "who is acting":
 * the authenticated principal plus the tenant scope that every downstream query
 * and mutation must use. The `partnerId` and `role` come exclusively from the
 * resolved session (task 7.2) — never from a client-supplied field — and the
 * tenant scope is a validated {@link TenantContext} (task 7.1). Sensitive
 * operations are gated by the pure role/permission matrix (task 5.1), so this
 * module is the single place transport code consults before touching a
 * tenant-scoped command (requirements 4.1, 4.2, 4.4).
 */
import { createTenantContext, type TenantContext } from "@infrastructure/database";
import type { AuthenticatedPrincipal } from "@domain/task-7-2";
import {
  hasTenantPermission,
  type TenantOperation,
  type TenantPrincipal,
} from "@domain/task-5-1/tenant-policy";

/** The trusted, server-derived identity + tenant scope for a request. */
export interface SessionContext {
  readonly principal: AuthenticatedPrincipal;
  /** Validated tenant scope; its `partnerId` is bound to the session. */
  readonly tenant: TenantContext;
}

/**
 * Build a {@link SessionContext} from an authenticated principal. The tenant
 * scope is constructed from `principal.partnerId` via the validating
 * {@link createTenantContext}, so a malformed principal can never widen a
 * query. The client never contributes the tenant id.
 */
export function toSessionContext(principal: AuthenticatedPrincipal): SessionContext {
  return Object.freeze({
    principal,
    tenant: createTenantContext(principal.partnerId),
  });
}

/** Project a principal onto the pure tenant-policy principal shape. */
export function toTenantPrincipal(principal: AuthenticatedPrincipal): TenantPrincipal {
  return {
    memberId: principal.memberId,
    partnerId: principal.partnerId,
    role: principal.role,
  };
}

export type PermissionCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: "FORBIDDEN" };

/**
 * Decide whether the session's principal may perform a sensitive operation.
 * Delegates to the pure permission matrix (task 5.1) so owner/member gating is
 * defined in exactly one place. Denials collapse to a generic `FORBIDDEN`.
 */
export function checkPermission(
  context: SessionContext,
  operation: TenantOperation,
): PermissionCheck {
  return hasTenantPermission(context.principal.role, operation)
    ? { allowed: true }
    : { allowed: false, code: "FORBIDDEN" };
}
