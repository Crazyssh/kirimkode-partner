"use client";

/**
 * Submit button that reflects the enclosing form's pending state for
 * accessibility. Used by the inline mutation forms on the operational pages so
 * a click cannot be double-submitted and assistive tech announces progress.
 * Primary = solid brand green with dark text (Modal-style CTA).
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
  /** Optional confirmation prompt shown before a destructive submit. */
  confirm?: string;
}) {
  const { pending } = useFormStatus();

  const tone =
    variant === "primary"
      ? "bg-brand font-semibold text-[#0C120A] hover:bg-brand-soft"
      : variant === "danger"
        ? "border border-red-400/40 text-red-300 hover:bg-red-400/10"
        : "border border-line-strong text-ink hover:bg-white/5";

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
      className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm transition-colors disabled:opacity-60 ${tone}`}
    >
      {pending ? (pendingLabel ?? "Memproses…") : children}
    </button>
  );
}
