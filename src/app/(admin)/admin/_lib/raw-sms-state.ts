/**
 * Shared state contract for the raw SMS reveal action (task 15.4).
 *
 * Kept out of the `"use server"` action module because such a module may only
 * export async functions. The reveal server action returns this discriminated
 * state to the {@link RawSmsReveal} client component via `useActionState`; the
 * decrypted content lives only in the transient `revealed` state and is never
 * persisted or placed in the URL.
 */
import type { RawSmsRevealed } from "@application/admin";

export type RawSmsRevealState =
  | { readonly status: "idle" }
  | { readonly status: "revealed"; readonly revealed: RawSmsRevealed }
  | { readonly status: "error"; readonly message: string };

export const RAW_SMS_INITIAL_STATE: RawSmsRevealState = { status: "idle" };
