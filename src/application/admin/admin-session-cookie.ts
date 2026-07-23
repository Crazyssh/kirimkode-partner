/**
 * `Set-Cookie` serialization for the Partner Admin session cookie.
 *
 * The cookie name is `__Host-partner_admin_session` — deliberately distinct
 * from the tenant `__Host-partner_session` so the two realms never share a
 * credential. The `__Host-` prefix is only honoured by browsers when the cookie
 * is `Secure`, has `Path=/`, and carries no `Domain` attribute, which also pins
 * it to the exact origin. Combined with `HttpOnly` (no JS access) and
 * `SameSite=Lax` this matches the tenant session hardening (design.md
 * section 1).
 */
export const ADMIN_SESSION_COOKIE_NAME = "__Host-partner_admin_session" as const;

export interface AdminSessionCookieAttributes {
  readonly name: typeof ADMIN_SESSION_COOKIE_NAME;
  readonly value: string;
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: "Lax";
  readonly path: "/";
  /** Cookie lifetime in seconds; matches the session's absolute TTL. */
  readonly maxAgeSeconds: number;
}

function assertMaxAge(maxAgeSeconds: number): void {
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    throw new Error("INVALID_COOKIE_MAX_AGE");
  }
}

/** Attributes for the cookie that carries a freshly issued admin session token. */
export function buildAdminSessionCookie(
  token: string,
  maxAgeSeconds: number,
): AdminSessionCookieAttributes {
  assertMaxAge(maxAgeSeconds);
  if (!token) throw new Error("INVALID_ADMIN_SESSION_TOKEN");
  return Object.freeze({
    name: ADMIN_SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAgeSeconds,
  });
}

/** Serialize cookie attributes into a `Set-Cookie` header value. */
export function serializeAdminSessionCookie(
  cookie: AdminSessionCookieAttributes,
): string {
  return [
    `${cookie.name}=${cookie.value}`,
    `Path=${cookie.path}`,
    "HttpOnly",
    "Secure",
    `SameSite=${cookie.sameSite}`,
    `Max-Age=${cookie.maxAgeSeconds}`,
  ].join("; ");
}

/** A `Set-Cookie` value that immediately clears the admin session cookie. */
export function serializeClearedAdminSessionCookie(): string {
  return [
    `${ADMIN_SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}
