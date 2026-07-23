"use server";

/**
 * Logout server action for the portal shell (task 15.1).
 *
 * Demonstrates the mutation feedback contract: revoke the session server-side
 * (idempotent — task 7.2), clear the `__Host-partner_session` cookie, and
 * redirect back to `/login`. Revocation is enforced on the server; the client
 * only triggers the action.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getAuthServices, SESSION_COOKIE_NAME } from "@application/auth";

export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;

  await getAuthServices().logout.logout(token);

  // Clear the cookie with the same host-locked attributes it was set with.
  cookieStore.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  redirect("/login");
}
