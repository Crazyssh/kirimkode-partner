"use client";

/**
 * Admin primary navigation (task 15.3). Highlights the active section via
 * `usePathname`. The item set is decided server-side in the shell.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface AdminNavItem {
  readonly href: string;
  readonly label: string;
}

export function AdminNav({ items }: { items: readonly AdminNavItem[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Navigasi admin" className="flex flex-col gap-1">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-3 py-2 text-sm font-medium ${
              active ? "bg-violet-600 text-white" : "text-slate-700 hover:bg-slate-100"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
