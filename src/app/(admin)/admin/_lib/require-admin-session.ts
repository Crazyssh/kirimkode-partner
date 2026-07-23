/**
 * Server-side admin-realm session guard for the Partner Admin area (task 15.3).
 *
 * Every protected admin server component and admin server action calls this
 * before rendering or mutating. It reads the dedicated admin session cookie
 * (`__Host-partner_admin_session`, entirely separate from the tenant portal
 * session — requirement 16.1), resolves it through the admin authorization
 * service (task 7.5), and redirects to `/admin/login` when the session is
 * missing, expired, or revoked. The returned {@link AuthenticatedAdmin} carries
 * the admin id and the permission list derived solely from the resolved session
 * — never from a client field — which downstream commands use to gate sensitive
 * actions server-side (requirements 16.2, 16.4). UI gating is only a convenience
 * layered on top of this server enforcement.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ADMIN_SESSION_COOKIE_NAME, getAdminServices } from "@application/admin";
import type { AuthenticatedAdmin } from "@domain/task-7-5";

export async function requireAdminSession(): Promise<AuthenticatedAdmin> {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_SESSION_COOKIE_NAME)?.value ?? null;

  const outcome = await getAdminServices().authorization.authorize(token);
  if (!outcome.ok) {
    redirect("/admin/login");
  }
  return outcome.admin;
}
