"use client";

/**
 * Submit button that reflects the enclosing form's pending state for
 * accessibility (task 15.3). Used by the admin inline mutation forms so a click
 * cannot be double-submitted and assistive tech announces progress. A `confirm`
 * prompt guards the destructive-looking disable actions.
 */
import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  confirm,
}: {
  children: ReactNode;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "danger";
  confirm?: string;
}) {
  const { pending } = useFormStatus();

  const tone =
    variant === "primary"
      ? "bg-violet-600 text-white hover:bg-violet-700"
      : variant === "danger"
        ? "border border-red-300 text-red-700 hover:bg-red-50"
        : "border border-slate-300 text-slate-700 hover:bg-slate-100";

  return (
    <button
      type="submit"
      disabled={pending}
      onClick={
        confirm
          ? (event) => {
              if (!window.confirm(confirm)) event.preventDefault();
            }
          : undefined
      }
      className={`inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${tone}`}
    >
      {pending ? (pendingLabel ?? "Memproses…") : children}
    </button>
  );
}
