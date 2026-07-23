/**
 * Wide gradient banner strip (HeroSMS puts one at the top of the dashboard
 * and the prices page). Dark green gradient with a soft brand glow —
 * Modal-style. Server component.
 */
import type { ReactNode } from "react";

export function HeroBanner({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  /** Optional right-aligned slot (action button / link). */
  children?: ReactNode;
}) {
  return (
    <div className="relative mb-6 overflow-hidden rounded-xl border border-brand-deep/30 bg-gradient-to-r from-surface-raised via-[#12241A] to-surface-raised px-6 py-5">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 right-10 h-48 w-48 rounded-full bg-brand/20 blur-3xl"
      />
      <div className="relative flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-base font-semibold text-ink">{title}</p>
          {description ? (
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-muted">
              {description}
            </p>
          ) : null}
        </div>
        {children ? <div className="shrink-0">{children}</div> : null}
      </div>
    </div>
  );
}
