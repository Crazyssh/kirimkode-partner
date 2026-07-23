/**
 * Pure presentation logic backing the Partner portal pages (task 15.5).
 *
 * The portal pages are async server components that resolve a session and query
 * the application layer, so their per-page decisions — which nav items a role
 * sees, whether a status enables mutations, the dashboard's next-step guidance,
 * and whether a payout can be requested — cannot be unit-tested by rendering
 * them in a Node environment (there is no DOM/react-testing harness in this
 * repo). Extracting those decisions here keeps them side-effect free and
 * component-testable while the pages stay thin transport wrappers. Server-side
 * authorization is still enforced independently inside every application
 * command; this module only decides what the UI offers (requirements 15.1,
 * 15.3, 15.5, 15.6).
 */
import {
  hasTenantPermission,
  type PartnerMemberRole,
  type TenantOperation,
} from "@domain/task-5-1/tenant-policy";
import type { DashboardView, PartnerStatus } from "@application/portal";

/** A portal nav entry. Mirrors the {@link NavItem} the nav component renders. */
export interface PortalNavItem {
  readonly href: string;
  readonly label: string;
  readonly available: boolean;
}

/** The full portal nav in display order; `ownerOnly` gates member visibility. */
export const PORTAL_NAV: readonly (PortalNavItem & { readonly ownerOnly: boolean })[] =
  Object.freeze([
    { href: "/", label: "Dashboard", available: true, ownerOnly: false },
    { href: "/devices", label: "Perangkat", available: true, ownerOnly: false },
    { href: "/numbers", label: "Nomor", available: true, ownerOnly: false },
    { href: "/offers", label: "Offer", available: true, ownerOnly: false },
    { href: "/orders", label: "Order", available: true, ownerOnly: false },
    { href: "/earnings", label: "Earning", available: true, ownerOnly: false },
    { href: "/payouts", label: "Payout", available: true, ownerOnly: true },
    { href: "/members", label: "Anggota", available: true, ownerOnly: true },
    { href: "/api-keys", label: "API Key", available: true, ownerOnly: true },
  ]);

/**
 * The nav items visible to a role (requirement 15.5). Members never see the
 * owner-only sensitive sections; owners see everything.
 */
export function navItemsForRole(role: PartnerMemberRole): PortalNavItem[] {
  const isOwner = role === "owner";
  return PORTAL_NAV.filter((item) => isOwner || !item.ownerOnly).map(
    ({ href, label, available }) => ({ href, label, available }),
  );
}

/**
 * Whether a UI affordance for a sensitive tenant operation should be shown to a
 * role. Delegates to the single pure permission matrix (task 5.1); the mutation
 * itself is still authorized server-side (requirement 15.5).
 */
export function canManage(
  role: PartnerMemberRole,
  operation: TenantOperation,
): boolean {
  return hasTenantPermission(role, operation);
}

/** Only an approved partner may create/change inventory (requirement 3.2). */
export function mutationsEnabled(status: PartnerStatus | null): boolean {
  return status === "approved";
}

/**
 * Guidance banner shown when the partner is not approved (requirement 15.1). An
 * empty string is returned for `approved` (the banner is not rendered then).
 */
export function approvalGuidance(status: PartnerStatus, reason: string | null): string {
  const base: Record<PartnerStatus, string> = {
    approved: "",
    pending:
      "Akun partner Anda sedang menunggu persetujuan admin. Inventory belum dapat ditawarkan hingga disetujui.",
    suspended:
      "Akun partner Anda ditangguhkan. Reservasi baru dihentikan hingga status dipulihkan.",
    rejected: "Pengajuan partner Anda ditolak.",
  };
  const message = base[status];
  if (message === "") return "";
  return reason ? `${message} Alasan: ${reason}` : message;
}

/** The empty-state next steps shown on the dashboard (requirement 15.3). */
export function buildDashboardNextSteps(view: DashboardView): string[] {
  const steps: string[] = [];
  if (view.partner.status !== "approved") {
    steps.push("Tunggu persetujuan admin agar inventory dapat ditawarkan.");
    return steps;
  }
  if (view.devices.total === 0) {
    steps.push("Daftarkan perangkat simulator dan mulai kirim heartbeat.");
  }
  if (view.numbersAvailable === 0) {
    steps.push("Daftarkan nomor Indonesia (+62) pada perangkat yang online.");
  }
  if (view.orders.total === 0) {
    steps.push("Buat offer aktif agar nomor Anda dapat dipesan buyer.");
  }
  return steps;
}

/** Why a payout request form is blocked, or that it is available. */
export type PayoutAvailability =
  | { readonly canRequest: true }
  | {
      readonly canRequest: false;
      readonly reason: "no_active_destination" | "no_available_earnings" | "below_minimum";
    };

export interface PayoutAvailabilityInput {
  readonly activeDestinationCount: number;
  readonly availableEarningCount: number;
  readonly availableIdr: number;
  readonly minimumPayoutIdr: number;
}

/**
 * Decide whether the owner may request a payout right now (requirements 14.1,
 * 15.6): an active destination must exist, at least one available earning must
 * be selectable, and the available balance must meet the configured minimum.
 * Reasons are checked in a fixed precedence so the UI shows one clear blocker.
 */
export function resolvePayoutAvailability(
  input: PayoutAvailabilityInput,
): PayoutAvailability {
  if (input.activeDestinationCount <= 0) {
    return { canRequest: false, reason: "no_active_destination" };
  }
  if (input.availableEarningCount <= 0) {
    return { canRequest: false, reason: "no_available_earnings" };
  }
  if (input.availableIdr < input.minimumPayoutIdr) {
    return { canRequest: false, reason: "below_minimum" };
  }
  return { canRequest: true };
}
