/**
 * Protected Partner portal shell (task 15.1).
 *
 * This layout wraps every portal route. It enforces an authenticated partner
 * session server-side via {@link requirePortalSession} — an unauthenticated
 * visitor is redirected to `/login` before any child renders — and derives the
 * navigation from the session principal's role (owner-only sections are hidden
 * for members, requirement 15.5). The tenant scope for all data comes from the
 * resolved session, never from the client. Rendering is dynamic because it
 * depends on the per-request session cookie.
 *
 * Visual shell: dark Modal.com-inspired chrome — fixed sidebar with icon nav,
 * sticky topbar with the partner identity, content area managed by each page.
 */
import type { ReactNode } from "react";

import { LogoutButton } from "./_components/logout-button";
import { PortalNav } from "./_components/portal-nav";
import { navItemsForRole } from "./_lib/portal-presentation";
import { requirePortalSession } from "./_lib/require-portal-session";

export const dynamic = "force-dynamic";

export default async function PortalLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await requirePortalSession();
  const { role, partnerId } = session.principal;
  const partnerShortId = partnerId.slice(0, 8);

  return (
    <div
      data-portal-shell
      className="flex min-h-screen bg-surface font-sans text-ink antialiased"
    >
      <aside className="fixed inset-y-0 left-0 z-20 flex w-60 flex-col border-r border-line bg-surface-inset">
        <div className="flex h-14 items-center gap-2 border-b border-line px-5">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand font-mono text-sm font-bold text-[#0C120A]">
            K
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold tracking-tight text-ink">
              KirimKode
            </p>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-brand">
              Partner
            </p>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <PortalNav items={navItemsForRole(role)} />
        </div>
        <div className="border-t border-line px-5 py-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
            Peran
          </p>
          <p className="mt-0.5 text-sm text-ink-muted">
            {role === "owner" ? "Owner" : "Anggota"}
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col pl-60">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-end gap-3 border-b border-line bg-surface/80 px-6 backdrop-blur">
          <span className="hidden items-center gap-2 rounded-full border border-line bg-surface-raised px-3 py-1 sm:flex">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
              Partner ID
            </span>
            <span className="font-mono text-xs text-ink">{partnerShortId}</span>
          </span>
          <span className="rounded-full border border-line bg-surface-raised px-3 py-1 text-xs text-ink-muted">
            {role === "owner" ? "Owner" : "Anggota"}
          </span>
          <LogoutButton />
        </header>
        <div className="min-w-0 flex-1 px-8 py-7">{children}</div>
      </div>
    </div>
  );
}
