"use client";

/**
 * Portal primary navigation. The set of items is decided server-side in the
 * layout (role gating per requirement 15.5) and passed in; this component only
 * renders them and highlights the active route via `usePathname`. Items whose
 * page is not yet available are rendered as disabled so the shell never links
 * to a dead route. Icons are resolved locally from the route so the pure
 * presentation module stays icon-agnostic.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType, SVGProps } from "react";

import {
  IconBank,
  IconCart,
  IconCoins,
  IconCpu,
  IconGrid,
  IconKey,
  IconSim,
  IconTag,
  IconUsers,
} from "./icons";

export interface NavItem {
  readonly href: string;
  readonly label: string;
  /** When false, the item is shown but not yet linkable (future page). */
  readonly available: boolean;
}

const NAV_ICON: Readonly<
  Record<string, ComponentType<SVGProps<SVGSVGElement>>>
> = {
  "/": IconGrid,
  "/devices": IconCpu,
  "/numbers": IconSim,
  "/offers": IconTag,
  "/orders": IconCart,
  "/earnings": IconCoins,
  "/payouts": IconBank,
  "/members": IconUsers,
  "/api-keys": IconKey,
};

export function PortalNav({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Navigasi portal" className="flex flex-col gap-0.5">
      {items.map((item) => {
        const active = pathname === item.href;
        const Icon = NAV_ICON[item.href];
        const icon = Icon ? <Icon className="h-4 w-4 shrink-0" /> : null;

        if (!item.available) {
          return (
            <span
              key={item.href}
              aria-disabled="true"
              title="Segera hadir"
              className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm text-ink-faint"
            >
              {icon}
              {item.label}
            </span>
          );
        }
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
              active
                ? "bg-brand/10 font-medium text-brand"
                : "text-ink-muted hover:bg-white/5 hover:text-ink"
            }`}
          >
            {active ? (
              <span
                aria-hidden
                className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand"
              />
            ) : null}
            {icon}
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
