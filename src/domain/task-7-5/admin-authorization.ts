/**
 * Pure Partner Admin realm policy (task 7.5).
 *
 * Partner Admin is a global operator role that lives in its own realm, entirely
 * separate from tenant (partner member) identities: an admin has no
 * `partnerId`, authenticates on the `/admin` route with a dedicated session
 * cookie, and is gated by an explicit permission list rather than the tenant
 * owner/member matrix (design.md section 1 & 11, requirements 16.1, 16.2).
 *
 * This module owns two decisions and nothing else, so both are exhaustively
 * unit-testable without a clock, database, or crypto:
 *   - whether an admin account may authenticate at all (`canAdminLogin`);
 *   - whether an authenticated admin holds a required permission
 *     (`adminHasPermission`).
 */

/** Admin account lifecycle status; a disabled admin can never authenticate. */
export type PartnerAdminLoginStatus = "active" | "disabled";

/**
 * Permission that gates the partner lifecycle commands (approve, reject,
 * suspend, reapprove). Admins without it are forbidden from changing partner
 * status (requirement 16.2).
 */
export const PARTNER_LIFECYCLE_PERMISSION = "partner:lifecycle" as const;

/**
 * Permission that gates the payout review + settlement commands (approve, mark
 * processing, mark paid, reject, fail). Admins without it can never move a
 * payout through its lifecycle or release its locked earnings (requirements
 * 14.4, 16.6). Payout *requests* remain a tenant (partner) action; this realm
 * only reviews and settles them.
 */
export const PAYOUT_REVIEW_PERMISSION = "payout:review" as const;

/**
 * Permission that gates the admin resource explorer's risk-mitigation actions —
 * non-destructively disabling a Device, Partner_Number, or Offer without
 * deleting its history (requirement 16.4). Viewing the redaction-safe resource
 * explorer only requires an authenticated admin; changing resource state
 * requires this permission. Admins without it can browse but never disable.
 */
export const RESOURCE_ADMIN_PERMISSION = "resource:admin" as const;

/**
 * Permission that gates publishing a new immutable {@link PlatformConfig}
 * version (guardrail, fee, markup, round, timeouts, heartbeat cadence, hold,
 * minimum payout, retention). Admins without it can view the active config but
 * can never publish a new version (requirement 16.5). Config changes never
 * mutate an existing version; each publish appends a new one.
 */
export const CONFIG_ADMIN_PERMISSION = "config:admin" as const;

/**
 * Permission that gates the limited admin-initiated recovery actions — driving
 * a stuck order to a terminal state (fail/cancel/timeout) exclusively through
 * the existing compare-and-set transition commands, never an ad-hoc write.
 * Admins without it can never run a recovery (requirement 16.6). Every recovery
 * is audited and protected against double processing by the same idempotency +
 * CAS the Internal API uses.
 */
export const RECOVERY_ADMIN_PERMISSION = "recovery:admin" as const;

/**
 * The trusted, server-derived identity of an authenticated Partner Admin. Its
 * `permissions`/`securityVersion` come exclusively from the resolved admin
 * session — never from a client-supplied field. There is deliberately no
 * `partnerId`: an admin acts across the platform, not within one tenant.
 */
export interface AuthenticatedAdmin {
  readonly adminId: string;
  readonly permissions: readonly string[];
  readonly securityVersion: number;
}

/** Decide whether an admin account in the given status may authenticate. */
export function canAdminLogin(status: PartnerAdminLoginStatus): boolean {
  return status === "active";
}

/** Decide whether an admin holds a specific permission. */
export function adminHasPermission(
  permissions: readonly string[],
  permission: string,
): boolean {
  return permissions.includes(permission);
}
