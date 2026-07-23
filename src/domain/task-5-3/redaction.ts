export const REDACTED = "[REDACTED]" as const;
const TRUNCATED = "[TRUNCATED]" as const;
const MAX_DEPTH = 6;
const MAX_ITEMS = 50;
const MAX_STRING_LENGTH = 1_024;

export type SafeMetadataValue = string | number | boolean | null | readonly SafeMetadataValue[] | SafeMetadata;
export interface SafeMetadata { readonly [key: string]: SafeMetadataValue }

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveMetadataKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return [
    "password", "passwd", "authorization", "cookie", "setcookie", "token", "accesstoken",
    "refreshtoken", "apikey", "secret", "clientsecret", "devicessecret", "signature", "otp",
    "onetimepassword", "sms", "smsbody", "rawsms", "messagebody", "accountnumber",
  ].some((marker) => normalized === marker || normalized.endsWith(marker));
}

export function redactText(value: string, sensitiveValues: readonly string[] = []): string {
  let safe = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive) safe = safe.split(sensitive).join(REDACTED);
  }
  safe = safe
    .replace(/\b(?:Bearer|Device)\s+[^\s,;]+/gi, REDACTED)
    .replace(/\b(?:password|passwd|token|secret|api[_ -]?key|authorization|cookie|otp|sms(?:body)?|account(?:number|no))\b\s*[:=]\s*[^\s,;]+/gi, REDACTED);
  return safe.length <= MAX_STRING_LENGTH ? safe : `${safe.slice(0, MAX_STRING_LENGTH)}${TRUNCATED}`;
}

function sanitize(value: unknown, sensitiveValues: readonly string[], seen: WeakSet<object>, depth: number): SafeMetadataValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return redactText(value, sensitiveValues);
  if (typeof value !== "object") return REDACTED;
  if (depth >= MAX_DEPTH || seen.has(value)) return REDACTED;
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => sanitize(item, sensitiveValues, seen, depth + 1));
    if (value.length > MAX_ITEMS) items.push(TRUNCATED);
    return items;
  }

  const output: Record<string, SafeMetadataValue> = Object.create(null) as Record<string, SafeMetadataValue>;
  for (const key of Object.keys(value as object).sort().slice(0, MAX_ITEMS)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) continue;
    output[key] = isSensitiveMetadataKey(key)
      ? REDACTED
      : sanitize((value as Record<string, unknown>)[key], sensitiveValues, seen, depth + 1);
  }
  return output;
}

export function createSafeMetadata(
  metadata: Readonly<Record<string, unknown>>,
  sensitiveValues: readonly string[] = [],
): SafeMetadata {
  return sanitize(metadata, sensitiveValues, new WeakSet<object>(), 0) as SafeMetadata;
}
