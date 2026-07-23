/**
 * Mutation feedback contract for the portal (task 15.1, requirement 15.6).
 *
 * Server actions and mutation routes surface success/failure by redirecting
 * back with `?feedback=<message>&feedbackType=<success|error>`. This helper
 * parses those params into a typed value the shared {@link FeedbackBanner}
 * renders. Centralising the shape here gives every operational page (task 15.2)
 * one consistent way to report the outcome of a mutation.
 */
export type FeedbackType = "success" | "error";

export interface Feedback {
  readonly type: FeedbackType;
  readonly message: string;
}

/** The `searchParams` shape a Next.js page receives (already awaited). */
export type SearchParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Parse a feedback message from a page's search params. Returns null when no
 * feedback is present or the message is empty. An unrecognised type defaults to
 * `error` so a malformed value never masquerades as success.
 */
export function parseFeedback(searchParams: SearchParams | undefined): Feedback | null {
  if (!searchParams) return null;
  const message = firstValue(searchParams.feedback)?.trim();
  if (!message) return null;
  const rawType = firstValue(searchParams.feedbackType);
  const type: FeedbackType = rawType === "success" ? "success" : "error";
  return { type, message };
}
