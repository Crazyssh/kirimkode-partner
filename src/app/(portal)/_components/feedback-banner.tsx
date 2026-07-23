"use client";

/**
 * Dismissible banner that surfaces the outcome of a mutation (requirement
 * 15.6). Presentational only: it takes an already-parsed {@link Feedback} and
 * renders an accessible status region. Success uses a polite live region;
 * errors use an assertive `alert` role so assistive tech announces them.
 */
import { useState } from "react";

import type { Feedback } from "../_lib/feedback";
import { IconX } from "./icons";

export function FeedbackBanner({ feedback }: { feedback: Feedback }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const isSuccess = feedback.type === "success";
  const tone = isSuccess
    ? "border-brand-deep/50 bg-brand/10 text-brand-soft"
    : "border-red-400/30 bg-red-400/10 text-red-200";

  return (
    <div
      role={isSuccess ? "status" : "alert"}
      aria-live={isSuccess ? "polite" : "assertive"}
      className={`mb-6 flex items-start justify-between gap-4 rounded-xl border px-4 py-3 text-sm ${tone}`}
    >
      <p className="font-medium">{feedback.message}</p>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Tutup notifikasi"
        className="shrink-0 rounded p-1 opacity-70 transition-opacity hover:opacity-100"
      >
        <IconX className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
