/**
 * Empty-state block for the admin area (task 15.3). Server component,
 * presentational only. Shown when a resource list is empty so the admin sees a
 * clear message instead of a blank table.
 */
import type { ReactNode } from "react";

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-8 text-center">
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {children ? (
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">{children}</p>
      ) : null}
    </div>
  );
}
