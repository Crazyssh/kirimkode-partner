/**
 * Mutation feedback contract for the Partner Admin area (task 15.3).
 *
 * Mirrors the portal's redirect-based feedback (task 15.1) but kept separate so
 * the admin area stays self-contained (requirement 16.1). Admin server actions
 * report success/failure by redirecting back with
 * `?feedback=<message>&feedbackType=<success|error>`, which the shared admin
 * FeedbackBanner renders.
 */
import { redirect } from "next/navigation";

export type FeedbackType = "success" | "error";

export interface Feedback {
  readonly type: FeedbackType;
  readonly message: string;
}

/** The `searchParams` shape a Next.js page receives (already awaited). */
export type SearchParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Parse a feedback message from a page's search params. Returns null when no
 * feedback is present. An unrecognised type defaults to `error` so a malformed
 * value never masquerades as success.
 */
export function parseFeedback(searchParams: SearchParams | undefined): Feedback | null {
  if (!searchParams) return null;
  const message = firstValue(searchParams.feedback)?.trim();
  if (!message) return null;
  const rawType = firstValue(searchParams.feedbackType);
  const type: FeedbackType = rawType === "success" ? "success" : "error";
  return { type, message };
}

/** Build an admin page URL carrying a feedback message for the banner. */
export function adminFeedbackTarget(
  path: string,
  type: FeedbackType,
  message: string,
): string {
  const params = new URLSearchParams({ feedback: message, feedbackType: type });
  return `${path}?${params.toString()}`;
}

/** Redirect back to `path` with a feedback banner message (never returns). */
export function redirectWithFeedback(
  path: string,
  type: FeedbackType,
  message: string,
): never {
  redirect(adminFeedbackTarget(path, type, message));
}
