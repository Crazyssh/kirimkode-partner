/**
 * Partner portal session endpoint (task 15.1 shell entry point).
 *
 * `POST` authenticates a Partner member and sets the `__Host-partner_session`
 * cookie; `DELETE` revokes the session and clears the cookie. This is the
 * tenant portal realm, entirely separate from the `/admin` realm. The route
 * only handles transport and delegates all behaviour to the human-auth
 * application services (task 7.2); the login outcome is enumeration-safe.
 */
import { getAuthServices, SESSION_COOKIE_NAME } from "@application/auth";

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

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() ?? "unknown";
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

  const result = await getAuthServices().login.login({
    email,
    password,
    ip: clientIp(request),
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
  const token = readCookie(request, SESSION_COOKIE_NAME);
  const result = await getAuthServices().logout.logout(token);
  return Response.json(
    { data: { ok: true } },
    { status: 200, headers: { "Set-Cookie": result.setCookieHeader } },
  );
}
