/**
 * Shared helpers for portal mutation server actions (task 15.2).
 *
 * Every operational mutation is a server action that re-resolves the session,
 * calls an application command (which independently re-checks role + partner
 * status), and then reports the outcome. Simple mutations surface their result
 * through the task 15.1 feedback contract: a redirect back to the page with
 * `?feedback=<message>&feedbackType=<success|error>` that the shared
 * FeedbackBanner renders (requirement 15.6). This module centralises the
 * redirect target construction and a typed result shape for the interactive
 * forms (device create/rotate) that must display a one-time secret inline.
 */
import { redirect } from "next/navigation";

import type { FeedbackType } from "./feedback";

/** Build a page URL carrying a feedback message for the FeedbackBanner. */
export function feedbackTarget(
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
  redirect(feedbackTarget(path, type, message));
}

/**
 * Result shape for interactive forms driven by `useActionState`. Used where a
 * redirect would lose transient data that must be shown once — namely the
 * one-time agent secret returned when a device credential is issued/rotated
 * (requirement 5.2).
 */
export interface FormActionState {
  readonly status: "idle" | "success" | "error";
  readonly message: string;
  /** One-time agent token (`<publicId>.<secret>`); shown once, never stored. */
  readonly agentToken?: string;
  readonly publicId?: string;
}

/** The initial, inert state for a `useActionState`-driven form. */
export const IDLE_FORM_STATE: FormActionState = { status: "idle", message: "" };
