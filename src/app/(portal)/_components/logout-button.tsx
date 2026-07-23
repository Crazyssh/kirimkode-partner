"use client";

/**
 * Logout control for the portal shell. Submits to the {@link logoutAction}
 * server action so the session is revoked server-side; the button reflects the
 * pending state for accessibility.
 */
import { useFormStatus } from "react-dom";

import { logoutAction } from "../_actions/logout";
import { IconLogout } from "./icons";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      title="Keluar"
      className="flex items-center gap-2 rounded-full border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:opacity-60"
    >
      <IconLogout className="h-3.5 w-3.5" />
      {pending ? "Keluar…" : "Keluar"}
    </button>
  );
}

export function LogoutButton() {
  return (
    <form action={logoutAction}>
      <SubmitButton />
    </form>
  );
}
