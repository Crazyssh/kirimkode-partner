/**
 * Presentational metric card for the dashboard. Shows a labelled value with an
 * optional hint used for empty-state next steps (requirement 15.3). Server
 * component — no interactivity. Dark Modal-style: mono uppercase label, large
 * mono value, optional brand accent for money-positive values.
 */
import type { ReactNode } from "react";

export function StatCard({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  /** Renders the value in the brand green (for positive money values). */
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface-raised p-5 transition-colors hover:border-line-strong">
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
        {label}
      </p>
      <p
        className={`mt-2 font-mono text-2xl font-semibold tabular-nums tracking-tight ${
          accent ? "text-brand" : "text-ink"
        }`}
      >
        {value}
      </p>
      {hint ? <p className="mt-2 text-xs leading-relaxed text-ink-faint">{hint}</p> : null}
    </div>
  );
}
