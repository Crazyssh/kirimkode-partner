/**
 * Partner Admin realm session endpoint (`/admin` auth).
 *
 * `POST` authenticates a Partner Admin and sets the dedicated
 * `__Host-partner_admin_session` cookie; `DELETE` revokes the session and
 * clears the cookie. This realm is entirely separate from the tenant portal
 * session (requirement 16.1). The route only touches transport concerns and
 * delegates all behaviour to the admin application services.
 */
import { getAdminServices, ADMIN_SESSION_COOKIE_NAME } from "@application/admin";
import { resolveClientIp } from "@application/http/client-ip";

export const dynamic = "force-dynamic";

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: { code: "INVALID_BODY" } }, { status: 400 });
  }

  const email = (body as { email?: unknown }).email;
  const password = (body as { password?: unknown }).password;
  if (typeof email !== "string" || typeof password !== "string") {
    return Response.json({ error: { code: "INVALID_BODY" } }, { status: 400 });
  }

  const adminServices = getAdminServices();
  const result = await adminServices.login.login({
    email,
    password,
    ip: resolveClientIp(request.headers, adminServices.trustedProxies),
  });

  if (!result.ok) {
    if (result.reason === "rate_limited") {
      return Response.json(
        { error: { code: "RATE_LIMITED" } },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(result.retryAfterMs / 1_000)) },
        },
      );
    }
    return Response.json(
      { error: { code: "INVALID_CREDENTIALS" } },
      { status: 401 },
    );
  }

  return Response.json(
    { data: { expiresAt: new Date(result.expiresAtEpochMs).toISOString() } },
    { status: 200, headers: { "Set-Cookie": result.setCookieHeader } },
  );
}

export async function DELETE(request: Request): Promise<Response> {
  const token = readCookie(request, ADMIN_SESSION_COOKIE_NAME);
  const result = await getAdminServices().logout.logout(token);
  return Response.json(
    { data: { ok: true } },
    { status: 200, headers: { "Set-Cookie": result.setCookieHeader } },
  );
}
