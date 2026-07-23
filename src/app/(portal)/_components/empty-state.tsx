/**
 * Empty-state block with next-step guidance (requirement 15.3). Server
 * component — presentational only. Shown when a resource list is empty so the
 * partner always sees a relevant next action instead of a blank table.
 */
import type { ReactNode } from "react";

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-surface-raised/40 px-6 py-14 text-center">
      <p className="text-sm font-semibold text-ink">{title}</p>
      {children ? (
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
          {children}
        </p>
      ) : null}
    </div>
  );
}
