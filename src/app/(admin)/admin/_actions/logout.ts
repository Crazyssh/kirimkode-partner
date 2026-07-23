"use server";

/**
 * Admin logout server action (task 15.3). Revokes the current admin session
 * server-side (idempotent) and clears the dedicated admin session cookie, then
 * returns the operator to the admin login page. Entirely separate from the
 * tenant portal logout (requirement 16.1).
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ADMIN_SESSION_COOKIE_NAME, getAdminServices } from "@application/admin";

export async function adminLogoutAction(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_SESSION_COOKIE_NAME)?.value ?? null;

  await getAdminServices().logout.logout(token);

  cookieStore.set(ADMIN_SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  redirect("/admin/login");
}
