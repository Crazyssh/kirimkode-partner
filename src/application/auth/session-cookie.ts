/**
 * `Set-Cookie` serialization for the session cookie.
 *
 * The cookie name is `__Host-partner_session`. The `__Host-` prefix is only
 * honoured by browsers when the cookie is `Secure`, has `Path=/`, and carries
 * no `Domain` attribute, which also pins it to the exact origin. Combined with
 * `HttpOnly` (no JS access) and `SameSite=Lax` (sent on top-level navigations,
 * not cross-site POSTs) this matches design.md section 1.
 */
export const SESSION_COOKIE_NAME = "__Host-partner_session" as const;

export interface SessionCookieAttributes {
  readonly name: typeof SESSION_COOKIE_NAME;
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

/** Attributes for the cookie that carries a freshly issued session token. */
export function buildSessionCookie(
  token: string,
  maxAgeSeconds: number,
): SessionCookieAttributes {
  assertMaxAge(maxAgeSeconds);
  if (!token) throw new Error("INVALID_SESSION_TOKEN");
  return Object.freeze({
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAgeSeconds,
  });
}

/** Serialize cookie attributes into a `Set-Cookie` header value. */
export function serializeSessionCookie(cookie: SessionCookieAttributes): string {
  return [
    `${cookie.name}=${cookie.value}`,
    `Path=${cookie.path}`,
    "HttpOnly",
    "Secure",
    `SameSite=${cookie.sameSite}`,
    `Max-Age=${cookie.maxAgeSeconds}`,
  ].join("; ");
}

/** A `Set-Cookie` value that immediately clears the session cookie (logout). */
export function serializeClearedSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}
