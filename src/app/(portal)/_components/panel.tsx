/**
 * Card container for the portal's dark theme. Server component. Wraps tables,
 * forms and detail blocks in the standard raised-surface panel so every page
 * shares one silhouette (HeroSMS-style layout, Modal-style skin).
 */
import type { ReactNode } from "react";

export function Panel({
  children,
  padded = true,
  className = "",
}: {
  children: ReactNode;
  /** Disable for tables that need edge-to-edge rows. */
  padded?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-xl border border-line bg-surface-raised ${
        padded ? "p-5" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

/** Panel section heading: mono uppercase, used above forms/blocks in a panel. */
export function PanelHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
      {children}
    </h2>
  );
}
