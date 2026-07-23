/**
 * Authenticated Partner Admin shell (task 15.3).
 *
 * A presentational wrapper rendered by every protected admin page after
 * {@link requireAdminSession} has enforced the admin realm server-side. It
 * provides the admin-only chrome — a distinct violet-accented header separate
 * from the blue tenant portal (requirement 16.1), primary navigation, and a
 * logout control. Auth is enforced by each page, not here, so this component
 * stays a pure layout.
 */
import type { ReactNode } from "react";

import { AdminNav } from "./admin-nav";
import { ADMIN_NAV_ITEMS } from "../_lib/admin-presentation";
import { adminLogoutAction } from "../_actions/logout";

export function AdminShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="mx-auto flex max-w-6xl gap-8 px-6 py-8">
      <aside className="w-56 shrink-0">
        <div className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-violet-700">
            KirimKode Admin
          </p>
          <p className="mt-1 text-sm text-slate-500">Partner Platform</p>
        </div>
        <AdminNav items={ADMIN_NAV_ITEMS} />
        <div className="mt-6 border-t border-slate-200 pt-4">
          <form action={adminLogoutAction}>
            <button
              type="submit"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Keluar
            </button>
          </form>
        </div>
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
