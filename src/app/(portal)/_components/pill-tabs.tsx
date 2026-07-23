/**
 * Segmented pill tabs (HeroSMS-style). Server component — tabs are plain
 * links (usually `?tab=` query params or sibling routes), the active one is
 * decided by the caller so pages stay server-rendered.
 */
import Link from "next/link";

export interface PillTab {
  readonly label: string;
  readonly href: string;
  readonly active: boolean;
}

export function PillTabs({ tabs }: { tabs: readonly PillTab[] }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-line bg-surface-inset p-1">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.active ? "page" : undefined}
          className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
            tab.active
              ? "bg-white/10 font-medium text-ink"
              : "text-ink-muted hover:text-ink"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
