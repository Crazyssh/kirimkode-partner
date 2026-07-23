export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function canonicalizeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError("Request payload numbers must be finite");
  }
  return JSON.stringify(Object.is(value, -0) ? 0 : value);
}

export function canonicalizeJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return canonicalizeNumber(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new TypeError("Request payload must contain only JSON values");
  }

  const record = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
    .join(",")}}`;
}

export interface CanonicalRequest {
  readonly scope: string;
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly method: string;
  readonly path: string;
  readonly payload: JsonValue;
}

function assertRequestIdentity(input: CanonicalRequest): void {
  for (const [name, value] of Object.entries({
    scope: input.scope,
    principalId: input.principalId,
    idempotencyKey: input.idempotencyKey,
    method: input.method,
    path: input.path,
  })) {
    if (!value.trim()) throw new TypeError(`${name} must not be empty`);
  }
}

export async function hashCanonicalRequest(input: CanonicalRequest): Promise<string> {
  assertRequestIdentity(input);
  const canonical = canonicalizeJson({
    version: 1,
    scope: input.scope,
    principalId: input.principalId,
    idempotencyKey: input.idempotencyKey.trim(),
    method: input.method.toUpperCase(),
    path: input.path,
    payload: input.payload,
  });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
