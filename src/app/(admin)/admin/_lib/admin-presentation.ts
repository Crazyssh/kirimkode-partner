/**
 * Pure presentation logic backing the Partner Admin pages (task 15.5).
 *
 * The admin area is a distinct realm from the tenant portal (requirement 16.1):
 * it has its own nav, its own feedback contract, and its own session guard. The
 * decisions here — the admin nav set (every entry lives under `/admin`, so the
 * realm can never link back into the tenant portal) and the raw-SMS access gate
 * state that drives the least-privilege reveal screen — are extracted so they
 * are side-effect free and component-testable without a DOM harness. The gate
 * decision is UI-only; the reveal itself is still authorized, re-auth-checked,
 * and audited server-side inside {@link AdminRawSmsService} (requirements 16.7,
 * 19.3).
 */
import type { ReauthStatus } from "@application/admin";

/** An admin nav entry. Mirrors the {@link AdminNavItem} the nav renders. */
export interface AdminNavEntry {
  readonly href: string;
  readonly label: string;
}

/** The admin realm navigation, in display order. All hrefs are under `/admin`. */
export const ADMIN_NAV_ITEMS: readonly AdminNavEntry[] = Object.freeze([
  { href: "/admin", label: "Review Partner" },
  { href: "/admin/config", label: "Konfigurasi" },
  { href: "/admin/recovery", label: "Recovery" },
  { href: "/admin/audit", label: "Audit" },
  { href: "/admin/sms-access", label: "Akses SMS" },
]);

/**
 * UI state for the gated raw SMS/OTP screen (task 15.4). Derived purely from the
 * admin's permission + step-up re-auth freshness:
 * - `no_permission`: the admin lacks `sms:raw`; only a notice is shown.
 * - `needs_reauth`: has permission but no fresh re-auth; prompt to re-authenticate.
 * - `ready`: has permission and a fresh re-auth; the reveal form is enabled.
 */
export type RawSmsGateState =
  | { readonly mode: "no_permission" }
  | { readonly mode: "needs_reauth" }
  | { readonly mode: "ready"; readonly expiresAtEpochMs: number | null };

export function resolveRawSmsGate(status: ReauthStatus): RawSmsGateState {
  if (!status.hasPermission) {
    return { mode: "no_permission" };
  }
  if (!status.fresh) {
    return { mode: "needs_reauth" };
  }
  return { mode: "ready", expiresAtEpochMs: status.expiresAtEpochMs };
}
