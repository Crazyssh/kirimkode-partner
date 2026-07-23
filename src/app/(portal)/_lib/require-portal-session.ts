/**
 * Server-side session guard for the Partner portal (task 15.1).
 *
 * Every protected portal server component calls this before rendering or
 * querying. It reads the opaque session cookie, resolves it through the
 * authorization service (task 7.2/7.4), and redirects to `/login` when the
 * session is missing, expired, or revoked. The returned {@link SessionContext}
 * carries the principal and a validated tenant scope whose `partnerId` is
 * derived only from the resolved session — never from a client field — so all
 * downstream queries are bound to the authenticated tenant (requirements 4.1,
 * 4.2, 15.5). Authorization is enforced here on the server; UI gating is only a
 * convenience layered on top.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE_NAME } from "@application/auth";
import {
  getAuthorizationServices,
  type SessionContext,
} from "@application/authorization";

export async function requirePortalSession(): Promise<SessionContext> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;

  const outcome = await getAuthorizationServices().sessionAuthorization.authorize(
    token,
  );
  if (!outcome.ok) {
    redirect("/login");
  }
  return outcome.context;
}
