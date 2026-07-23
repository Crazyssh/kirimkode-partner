"use client";

/**
 * Dismissible banner that surfaces the outcome of an admin mutation (task 15.3).
 * Presentational only: it takes an already-parsed {@link Feedback} and renders
 * an accessible status region. Success uses a polite live region; errors use an
 * assertive `alert` role so assistive tech announces them.
 */
import { useState } from "react";

import type { Feedback } from "../_lib/admin-feedback";

export function FeedbackBanner({ feedback }: { feedback: Feedback }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const isSuccess = feedback.type === "success";
  const tone = isSuccess
    ? "border-green-200 bg-green-50 text-green-800"
    : "border-red-200 bg-red-50 text-red-800";

  return (
    <div
      role={isSuccess ? "status" : "alert"}
      aria-live={isSuccess ? "polite" : "assertive"}
      className={`mb-6 flex items-start justify-between gap-4 rounded-lg border px-4 py-3 text-sm ${tone}`}
    >
      <p className="font-medium">{feedback.message}</p>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Tutup notifikasi"
        className="shrink-0 rounded p-1 text-lg leading-none opacity-70 hover:opacity-100"
      >
        ×
      </button>
    </div>
  );
}
