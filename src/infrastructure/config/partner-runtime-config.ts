const PARTNER_RUNTIME_ID = "kirimkode-partner";
const PARTNER_DATABASE_NAME = "kirimkode_partner";
const PARTNER_PORT = 3001;
const PARTNER_PORTAL_ORIGIN = "https://partner.kirimkode.com";
const PARTNER_API_ORIGIN = "https://partner-api.kirimkode.com";
const PARTNER_TIMEZONE = "Asia/Jakarta";
const MINIMUM_SECRET_LENGTH = 32;
const ENCRYPTION_KEY_BYTES = 32;

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
export type PartnerEnvironment = "development" | "test" | "production";

export interface PartnerRuntimeConfig {
  runtimeId: typeof PARTNER_RUNTIME_ID;
  environment: PartnerEnvironment;
  databaseUrl: string;
  databaseName: typeof PARTNER_DATABASE_NAME;
  sessionSecret: string;
  session: Readonly<{
    cookieName: "__Host-partner_session";
    idleTtlSeconds: 43_200;
    absoluteTtlSeconds: 604_800;
  }>;
  internalApiHmac: Readonly<{
    clientId: string;
    currentKeyId: string;
    currentSecret: string;
    previousKeyId?: string;
    previousSecret?: string;
  }>;
  deviceCredentialPepper: string;
  smsOtpEncryption: Readonly<{ keyVersion: number; key: string }>;
  cronSecret: string;
  smtp: Readonly<{
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    from: string;
  }>;
  portalOrigin: typeof PARTNER_PORTAL_ORIGIN;
  apiOrigin: typeof PARTNER_API_ORIGIN;
  trustedProxies: readonly string[];
  port: typeof PARTNER_PORT;
  timezone: typeof PARTNER_TIMEZONE;
}
export interface ConfigurationIssue {
  variable: string;
  reason: string;
}

export class PartnerConfigurationError extends Error {
  readonly issues: readonly ConfigurationIssue[];

  constructor(issues: readonly ConfigurationIssue[]) {
    const safeIssues = issues.map((issue) => Object.freeze({ ...issue }));
    const summary = safeIssues
      .map(({ variable, reason }) => `${variable} ${reason}`)
      .join("; ");

    super(`Invalid Partner runtime configuration: ${summary}`);
    this.name = "PartnerConfigurationError";
    this.issues = Object.freeze(safeIssues);
  }
}

function readNonBlank(
  environment: RuntimeEnvironment,
  variable: string,
  issues: ConfigurationIssue[],
): string | undefined {
  const value = environment[variable];
  if (value === undefined || value.trim().length === 0) {
    issues.push({ variable, reason: "is required" });
    return undefined;
  }
  return value;
}

function readOptional(environment: RuntimeEnvironment, variable: string): string | undefined {
  const value = environment[variable];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function readInteger(
  environment: RuntimeEnvironment,
  variable: string,
  issues: ConfigurationIssue[],
): number | undefined {
  const value = readNonBlank(environment, variable, issues);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    issues.push({ variable, reason: "must be an integer" });
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    issues.push({ variable, reason: "must be a safe integer" });
    return undefined;
  }
  return parsed;
}

function readBoolean(
  environment: RuntimeEnvironment,
  variable: string,
  issues: ConfigurationIssue[],
): boolean | undefined {
  const value = readNonBlank(environment, variable, issues);
  if (value === undefined) return undefined;
  if (value !== "true" && value !== "false") {
    issues.push({ variable, reason: "must be either true or false" });
    return undefined;
  }
  return value === "true";
}
function isDedicatedPartnerDatabase(databaseUrl: string): boolean {
  try {
    const parsed = new URL(databaseUrl);
    const databaseName = decodeURIComponent(parsed.pathname).replace(/^\//, "");
    return (
      (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") &&
      databaseName === PARTNER_DATABASE_NAME &&
      parsed.username.length > 0 &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function isValidOrigin(value: string, expected: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.origin === expected && parsed.href === `${expected}/`;
  } catch {
    return false;
  }
}

function ipVersion(address: string): 0 | 4 | 6 {
  const ipv4Parts = address.split(".");
  if (
    ipv4Parts.length === 4 &&
    ipv4Parts.every(
      (part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255,
    )
  ) {
    return 4;
  }
  if (!address.includes(":") || /[\s%/]/.test(address)) return 0;
  try {
    const parsed = new URL(`http://[${address}]/`);
    return parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]") ? 6 : 0;
  } catch {
    return 0;
  }
}

function isValidTrustedProxy(value: string): boolean {
  const [address, prefix, ...rest] = value.split("/");
  const version = ipVersion(address);
  if (rest.length > 0 || version === 0 || address === "0.0.0.0" || address === "::") {
    return false;
  }
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits > 0 && bits <= (version === 4 ? 32 : 128);
}

function readTrustedProxies(
  environment: RuntimeEnvironment,
  issues: ConfigurationIssue[],
): readonly string[] | undefined {
  const value = readNonBlank(environment, "PARTNER_TRUSTED_PROXIES", issues);
  if (value === undefined) return undefined;
  const proxies = value.split(",").map((proxy) => proxy.trim());
  if (
    proxies.some((proxy) => proxy.length === 0 || !isValidTrustedProxy(proxy)) ||
    new Set(proxies).size !== proxies.length
  ) {
    issues.push({
      variable: "PARTNER_TRUSTED_PROXIES",
      reason: "must contain unique explicit IP addresses or CIDR ranges",
    });
    return undefined;
  }
  return Object.freeze(proxies);
}

function validateSecret(
  variable: string,
  value: string | undefined,
  issues: ConfigurationIssue[],
): void {
  if (value !== undefined && value.length < MINIMUM_SECRET_LENGTH) {
    issues.push({
      variable,
      reason: `must contain at least ${MINIMUM_SECRET_LENGTH} characters`,
    });
  }
}

function validateEncryptionKey(
  value: string | undefined,
  issues: ConfigurationIssue[],
): void {
  if (
    value !== undefined &&
    (!/^[A-Za-z0-9_-]{43}$/.test(value) ||
      Buffer.from(value, "base64url").byteLength !== ENCRYPTION_KEY_BYTES)
  ) {
    issues.push({
      variable: "PARTNER_SMS_OTP_ENCRYPTION_KEY",
      reason: "must be a base64url-encoded 32-byte key",
    });
  }
}
function rejectSecretReuse(
  secrets: readonly (readonly [variable: string, value: string | undefined])[],
  issues: ConfigurationIssue[],
): void {
  for (let index = 0; index < secrets.length; index += 1) {
    const [variable, value] = secrets[index];
    if (value === undefined) continue;
    const reused = secrets.slice(0, index).some(([, priorValue]) => priorValue === value);
    if (reused) {
      issues.push({ variable, reason: "must not reuse another Partner secret" });
    }
  }
}

export function parsePartnerRuntimeConfig(
  environment: RuntimeEnvironment,
): Readonly<PartnerRuntimeConfig> {
  const issues: ConfigurationIssue[] = [];
  const runtimeId = readNonBlank(environment, "PARTNER_RUNTIME_ID", issues);
  const partnerEnvironment = readNonBlank(environment, "PARTNER_ENVIRONMENT", issues);
  const databaseUrl = readNonBlank(environment, "PARTNER_DATABASE_URL", issues);
  const sessionSecret = readNonBlank(environment, "PARTNER_SESSION_SECRET", issues);
  const hmacClientId = readNonBlank(environment, "PARTNER_INTERNAL_API_HMAC_CLIENT_ID", issues);
  const hmacCurrentKeyId = readNonBlank(environment, "PARTNER_INTERNAL_API_HMAC_CURRENT_KEY_ID", issues);
  const hmacCurrentSecret = readNonBlank(environment, "PARTNER_INTERNAL_API_HMAC_CURRENT_SECRET", issues);
  const hmacPreviousKeyId = readOptional(environment, "PARTNER_INTERNAL_API_HMAC_PREVIOUS_KEY_ID");
  const hmacPreviousSecret = readOptional(environment, "PARTNER_INTERNAL_API_HMAC_PREVIOUS_SECRET");
  const deviceCredentialPepper = readNonBlank(environment, "PARTNER_DEVICE_CREDENTIAL_PEPPER", issues);
  const encryptionKeyVersion = readInteger(environment, "PARTNER_SMS_OTP_ENCRYPTION_KEY_VERSION", issues);
  const encryptionKey = readNonBlank(environment, "PARTNER_SMS_OTP_ENCRYPTION_KEY", issues);
  const cronSecret = readNonBlank(environment, "PARTNER_CRON_SECRET", issues);
  const smtpHost = readNonBlank(environment, "PARTNER_SMTP_HOST", issues);
  const smtpPort = readInteger(environment, "PARTNER_SMTP_PORT", issues);
  const smtpSecure = readBoolean(environment, "PARTNER_SMTP_SECURE", issues);
  const smtpUsername = readNonBlank(environment, "PARTNER_SMTP_USERNAME", issues);
  const smtpPassword = readNonBlank(environment, "PARTNER_SMTP_PASSWORD", issues);
  const smtpFrom = readNonBlank(environment, "PARTNER_SMTP_FROM", issues);
  const portalOrigin = readNonBlank(environment, "PARTNER_PORTAL_ORIGIN", issues);
  const apiOrigin = readNonBlank(environment, "PARTNER_API_ORIGIN", issues);
  const trustedProxies = readTrustedProxies(environment, issues);
  const port = readInteger(environment, "PARTNER_PORT", issues);
  const timezone = readNonBlank(environment, "PARTNER_TIMEZONE", issues);

  if (runtimeId !== undefined && runtimeId !== PARTNER_RUNTIME_ID) {
    issues.push({ variable: "PARTNER_RUNTIME_ID", reason: "must identify the Partner runtime" });
  }
  if (
    partnerEnvironment !== undefined &&
    !["development", "test", "production"].includes(partnerEnvironment)
  ) {
    issues.push({ variable: "PARTNER_ENVIRONMENT", reason: "must be development, test, or production" });
  }
  if (databaseUrl !== undefined && !isDedicatedPartnerDatabase(databaseUrl)) {
    issues.push({
      variable: "PARTNER_DATABASE_URL",
      reason: "must be a PostgreSQL URL for the dedicated Partner database",
    });
  }
  validateSecret("PARTNER_SESSION_SECRET", sessionSecret, issues);
  validateSecret("PARTNER_INTERNAL_API_HMAC_CURRENT_SECRET", hmacCurrentSecret, issues);
  validateSecret("PARTNER_INTERNAL_API_HMAC_PREVIOUS_SECRET", hmacPreviousSecret, issues);
  validateSecret("PARTNER_DEVICE_CREDENTIAL_PEPPER", deviceCredentialPepper, issues);
  validateSecret("PARTNER_CRON_SECRET", cronSecret, issues);
  validateEncryptionKey(encryptionKey, issues);
  if (encryptionKeyVersion !== undefined && encryptionKeyVersion < 1) {
    issues.push({
      variable: "PARTNER_SMS_OTP_ENCRYPTION_KEY_VERSION",
      reason: "must be a positive integer",
    });
  }

  if ((hmacPreviousKeyId === undefined) !== (hmacPreviousSecret === undefined)) {
    issues.push({
      variable: hmacPreviousKeyId === undefined
        ? "PARTNER_INTERNAL_API_HMAC_PREVIOUS_KEY_ID"
        : "PARTNER_INTERNAL_API_HMAC_PREVIOUS_SECRET",
      reason: "must be configured together with the previous HMAC rotation value",
    });
  }

  rejectSecretReuse(
    [
      ["PARTNER_SESSION_SECRET", sessionSecret],
      ["PARTNER_INTERNAL_API_HMAC_CURRENT_SECRET", hmacCurrentSecret],
      ["PARTNER_INTERNAL_API_HMAC_PREVIOUS_SECRET", hmacPreviousSecret],
      ["PARTNER_DEVICE_CREDENTIAL_PEPPER", deviceCredentialPepper],
      ["PARTNER_SMS_OTP_ENCRYPTION_KEY", encryptionKey],
      ["PARTNER_CRON_SECRET", cronSecret],
    ],
    issues,
  );

  if (smtpHost !== undefined && (!/^[A-Za-z0-9.-]+$/.test(smtpHost) || smtpHost.includes(".."))) {
    issues.push({ variable: "PARTNER_SMTP_HOST", reason: "must be a hostname or IP address" });
  }
  if (smtpPort !== undefined && (smtpPort < 1 || smtpPort > 65_535)) {
    issues.push({ variable: "PARTNER_SMTP_PORT", reason: "must be between 1 and 65535" });
  }
  if (
    smtpFrom !== undefined &&
    !/^(?:[^<>\r\n]+ <)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(smtpFrom)
  ) {
    issues.push({ variable: "PARTNER_SMTP_FROM", reason: "must contain a valid sender email address" });
  }
  if (portalOrigin !== undefined && !isValidOrigin(portalOrigin, PARTNER_PORTAL_ORIGIN)) {
    issues.push({ variable: "PARTNER_PORTAL_ORIGIN", reason: "must be the dedicated Partner portal origin" });
  }
  if (apiOrigin !== undefined && !isValidOrigin(apiOrigin, PARTNER_API_ORIGIN)) {
    issues.push({ variable: "PARTNER_API_ORIGIN", reason: "must be the dedicated Partner API origin" });
  }
  if (port !== undefined && port !== PARTNER_PORT) {
    issues.push({ variable: "PARTNER_PORT", reason: `must equal ${PARTNER_PORT}` });
  }
  if (timezone !== undefined && timezone !== PARTNER_TIMEZONE) {
    issues.push({ variable: "PARTNER_TIMEZONE", reason: "must be the Partner display timezone" });
  }

  if (issues.length > 0) throw new PartnerConfigurationError(issues);

  const internalApiHmac = Object.freeze({
    clientId: hmacClientId as string,
    currentKeyId: hmacCurrentKeyId as string,
    currentSecret: hmacCurrentSecret as string,
    ...(hmacPreviousKeyId === undefined ? {} : { previousKeyId: hmacPreviousKeyId }),
    ...(hmacPreviousSecret === undefined ? {} : { previousSecret: hmacPreviousSecret }),
  });

  return Object.freeze({
    runtimeId: runtimeId as typeof PARTNER_RUNTIME_ID,
    environment: partnerEnvironment as PartnerEnvironment,
    databaseUrl: databaseUrl as string,
    databaseName: PARTNER_DATABASE_NAME,
    sessionSecret: sessionSecret as string,
    session: Object.freeze({
      cookieName: "__Host-partner_session" as const,
      idleTtlSeconds: 43_200 as const,
      absoluteTtlSeconds: 604_800 as const,
    }),
    internalApiHmac,
    deviceCredentialPepper: deviceCredentialPepper as string,
    smsOtpEncryption: Object.freeze({
      keyVersion: encryptionKeyVersion as number,
      key: encryptionKey as string,
    }),
    cronSecret: cronSecret as string,
    smtp: Object.freeze({
      host: smtpHost as string,
      port: smtpPort as number,
      secure: smtpSecure as boolean,
      username: smtpUsername as string,
      password: smtpPassword as string,
      from: smtpFrom as string,
    }),
    portalOrigin: portalOrigin as typeof PARTNER_PORTAL_ORIGIN,
    apiOrigin: apiOrigin as typeof PARTNER_API_ORIGIN,
    trustedProxies: trustedProxies as readonly string[],
    port: port as typeof PARTNER_PORT,
    timezone: timezone as typeof PARTNER_TIMEZONE,
  });
}
