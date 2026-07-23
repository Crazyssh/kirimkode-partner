/**
 * Central, pure redaction for structured logs, error responses, and security
 * events (task 16.5; design section 12; requirements 18.7, 19.6).
 *
 * The design mandates that the following are NEVER written to a general log or
 * error response: `authorization` headers, cookies, passwords, tokens, API
 * keys, the full account number, the OTP, and the raw SMS body. Rather than
 * trusting every call site to remember that list, this module is the single
 * choke point: {@link redact} walks an arbitrary structured value and replaces
 * every sensitive field with {@link REDACTION_PLACEHOLDER}. The log-record and
 * security-event builders run this over every payload, so a leak is not
 * possible without deleting this enforcement.
 *
 * Matching is *key based* and deterministic:
 *
 *  - A key whose normalized form (lower-cased, with `-`/`_`/spaces removed) is
 *    an exact member of {@link SENSITIVE_KEYS} is always redacted. This covers
 *    the enumerated fields (`authorization`, `cookie`, `otp`, raw `sms`/`body`,
 *    `accountNumber`, …) without over-matching operational counters such as
 *    `unmatchedSms` or `otpAttempts`, whose values are safe to log.
 *  - A key that *contains* one of the {@link SENSITIVE_SUBSTRINGS} markers
 *    (`password`, `token`, `secret`, `authorization`, `apikey`) is always
 *    redacted, because any field whose name embeds those words carries a
 *    credential (e.g. `refreshToken`, `clientSecret`, `xApiKey`).
 *
 * The walk is structural: it recurses into nested objects and arrays, tolerates
 * cycles (a repeated reference becomes {@link CIRCULAR_PLACEHOLDER}), and leaves
 * every non-sensitive scalar untouched. The module is pure — no I/O, no clock,
 * no runtime globals — so it is trivially unit-testable and safe to run in the
 * domain layer.
 */

/** The value substituted for any redacted field. */
export const REDACTION_PLACEHOLDER = "[REDACTED]" as const;

/** The value substituted when a circular reference is detected. */
export const CIRCULAR_PLACEHOLDER = "[CIRCULAR]" as const;

/**
 * Normalize a key for matching: lower-case and strip the separators that
 * distinguish otherwise-identical field spellings (`api-key`, `api_key`,
 * `apiKey` → `apikey`).
 */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

/**
 * Exact (normalized) key names that must always be redacted. Enumerated rather
 * than substring-matched so that operational fields whose names merely embed a
 * sensitive word (e.g. `smsCount`, `otpAttempts`) remain loggable.
 */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  // Authorization / transport credentials.
  "authorization",
  "proxyauthorization",
  "cookie",
  "cookies",
  "setcookie",
  // Passwords / tokens / keys / secrets (exact spellings; substrings below
  // catch the compound forms).
  "password",
  "passwordhash",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "bearer",
  "apikey",
  "apisecret",
  "secret",
  "clientsecret",
  "privatekey",
  "signature",
  "hmac",
  // One-time password / OTP.
  "otp",
  "otpcode",
  "otpvalue",
  "onetimepassword",
  // Raw SMS content.
  "sms",
  "rawsms",
  "smsbody",
  "smscontent",
  "smsmessage",
  "messagebody",
  "body",
  "sender",
  // Full bank account number / PIN.
  "accountnumber",
  "bankaccountnumber",
  "fullaccountnumber",
  "pin",
]);

/**
 * Substrings that mark any containing key as a credential regardless of the
 * surrounding characters (`xRefreshToken`, `db_password`, `stripeApiKey`, …).
 * Deliberately narrow so operational metrics are not swept up.
 */
export const SENSITIVE_SUBSTRINGS: readonly string[] = [
  "password",
  "token",
  "secret",
  "authorization",
  "apikey",
];

/** Decide whether a single field key identifies a sensitive value. */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return SENSITIVE_SUBSTRINGS.some((marker) => normalized.includes(marker));
}

/** A JSON-shaped value the redactor can walk. */
export type RedactableValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | RedactableValue[]
  | { readonly [key: string]: RedactableValue };

function isPlainRecord(value: unknown): value is Record<string, RedactableValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Recursively redact every sensitive field in `value`. Non-sensitive scalars
 * pass through unchanged; nested objects and arrays are rebuilt with their
 * sensitive members replaced by {@link REDACTION_PLACEHOLDER}. Circular
 * references collapse to {@link CIRCULAR_PLACEHOLDER} so the redactor always
 * terminates.
 */
export function redact<T extends RedactableValue>(value: T): RedactableValue {
  return redactInternal(value, new WeakSet<object>());
}

function redactInternal(
  value: RedactableValue,
  seen: WeakSet<object>,
): RedactableValue {
  if (Array.isArray(value)) {
    if (seen.has(value)) return CIRCULAR_PLACEHOLDER;
    seen.add(value);
    return value.map((item) => redactInternal(item, seen));
  }

  if (isPlainRecord(value)) {
    if (seen.has(value)) return CIRCULAR_PLACEHOLDER;
    seen.add(value);
    const result: Record<string, RedactableValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = isSensitiveKey(key)
        ? REDACTION_PLACEHOLDER
        : redactInternal(nested, seen);
    }
    return result;
  }

  // Primitive (string/number/boolean/null/undefined): nothing to redact.
  return value;
}

/**
 * Redact a record and return it typed as a plain object, the common shape for
 * log/security-event metadata bags.
 */
export function redactRecord(
  record: Readonly<Record<string, RedactableValue>>,
): Record<string, RedactableValue> {
  return redactInternal({ ...record }, new WeakSet<object>()) as Record<
    string,
    RedactableValue
  >;
}
