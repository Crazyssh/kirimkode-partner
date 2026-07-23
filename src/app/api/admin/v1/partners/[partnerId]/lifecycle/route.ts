/**
 * Partner Admin lifecycle command endpoint.
 *
 * `POST /api/admin/v1/partners/{partnerId}/lifecycle` runs one of the admin
 * lifecycle commands (approve, reject, suspend, reapprove) with a reason. The
 * route authorizes the admin session (separate `/admin` realm), then delegates
 * to the application service, which validates the command, drives the partner
 * status state machine, and writes the audit event atomically (requirements
 * 3.1–3.5, 16.1, 16.2). The command validation vocabulary lives in the
 * application/domain layers, so the route stays transport-only.
 */
import {
  getAdminServices,
  ADMIN_SESSION_COOKIE_NAME,
  PARTNER_LIFECYCLE_PERMISSION,
} from "@application/admin";

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

export async function POST(
  request: Request,
  context: { params: Promise<{ partnerId: string }> },
): Promise<Response> {
  const services = getAdminServices();

  const token = readCookie(request, ADMIN_SESSION_COOKIE_NAME);
  const authorized = await services.authorization.authorizePermission(
    token,
    PARTNER_LIFECYCLE_PERMISSION,
  );
  if (!authorized.ok) {
    const status = authorized.reason === "unauthenticated" ? 401 : 403;
    return Response.json(
      { error: { code: authorized.reason.toUpperCase() } },
      { status },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: { code: "INVALID_BODY" } }, { status: 400 });
  }
  const command = (body as { command?: unknown }).command;
  const reason = (body as { reason?: unknown }).reason;
  if (typeof command !== "string" || typeof reason !== "string") {
    return Response.json({ error: { code: "INVALID_BODY" } }, { status: 400 });
  }

  const { partnerId } = await context.params;
  const result = await services.partnerLifecycle.execute({
    admin: authorized.admin,
    partnerId,
    command,
    reason,
    requestId: crypto.randomUUID(),
  });

  if (result.ok) {
    return Response.json({ data: { status: result.status } }, { status: 200 });
  }

  switch (result.reason) {
    case "forbidden":
      return Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
    case "not_found":
      return Response.json({ error: { code: "PARTNER_NOT_FOUND" } }, { status: 404 });
    case "invalid_command":
      return Response.json(
        { error: { code: "INVALID_LIFECYCLE_COMMAND" } },
        { status: 422 },
      );
    case "conflict":
      return Response.json({ error: { code: "STATUS_CONFLICT" } }, { status: 409 });
    case "validation":
      return Response.json({ error: { code: result.code } }, { status: 400 });
    default:
      return Response.json({ error: { code: "INTERNAL" } }, { status: 500 });
  }
}
