import { readFileSync } from "node:fs";
import path from "node:path";

export const PARTNER_DATABASE_NAME = "kirimkode_partner";
export const PARTNER_PACKAGE_NAME = "@kirimkode/partner-platform";
export const PARTNER_PROCESS_NAME = "kirimkode-partner";
export const PARTNER_PORT = "3001";

export function assertPartnerProcessName(value) {
  if (value !== PARTNER_PROCESS_NAME) {
    throw new Error(`Refusing unsafe PM2 target: expected ${PARTNER_PROCESS_NAME}`);
  }
  return value;
}

export function assertPartnerAppRoot(value) {
  const appRoot = path.resolve(value);
  const packageFile = path.join(appRoot, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(packageFile, "utf8"));
  } catch {
    throw new Error(`Refusing app root without readable package.json: ${appRoot}`);
  }
  if (manifest.name !== PARTNER_PACKAGE_NAME) {
    throw new Error(`Refusing non-Partner app root: ${appRoot}`);
  }
  return appRoot;
}

export function parsePartnerDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Refusing invalid PARTNER_DATABASE_URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Refusing non-PostgreSQL PARTNER_DATABASE_URL");
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (databaseName !== PARTNER_DATABASE_NAME) {
    throw new Error(`Refusing database target other than ${PARTNER_DATABASE_NAME}`);
  }
  const username = decodeURIComponent(url.username);
  if (!/^kirimkode_partner_(?:app|backup|restore)$/.test(username)) {
    throw new Error("Refusing database role outside the Partner namespace");
  }
  return { databaseName, url, username };
}

export function parsePartnerMigrationDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Refusing invalid PARTNER_MIGRATION_DATABASE_URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Refusing non-PostgreSQL PARTNER_MIGRATION_DATABASE_URL");
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (databaseName !== PARTNER_DATABASE_NAME) {
    throw new Error(`Refusing database target other than ${PARTNER_DATABASE_NAME}`);
  }
  const username = decodeURIComponent(url.username);
  // The runtime app role has CREATE revoked (see prisma/admin/partner-role-grants
  // .sql.template), so it can never run DDL migrations. Release migrations must
  // connect as a dedicated DDL-capable migrator/owner role instead.
  if (!/^kirimkode_partner_(?:migrator|owner)$/.test(username)) {
    throw new Error("Refusing migration role that cannot run Partner DDL");
  }
  return { databaseName, url, username, value };
}

export function postgresEnvironment(databaseUrl, baseEnvironment = process.env) {
  const { url } = parsePartnerDatabaseUrl(databaseUrl);
  const environment = {
    ...baseEnvironment,
    PGDATABASE: PARTNER_DATABASE_NAME,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
  };
  const sslMode = url.searchParams.get("sslmode");
  if (sslMode) environment.PGSSLMODE = sslMode;
  return environment;
}

export function assertPartnerBackupRoot(value) {
  const root = path.resolve(value);
  if (path.basename(root) !== PARTNER_PROCESS_NAME) {
    throw new Error(`Refusing backup root outside ${PARTNER_PROCESS_NAME}`);
  }
  return root;
}

export function assertPartnerBackupArtifact(value, backupRoot) {
  const root = assertPartnerBackupRoot(backupRoot);
  const artifact = path.resolve(value);
  const relative = path.relative(root, artifact);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refusing backup artifact outside Partner backup root");
  }
  if (!/^kirimkode_partner_\d{8}T\d{6}Z\.dump$/.test(path.basename(artifact))) {
    throw new Error("Refusing artifact outside the Partner backup filename contract");
  }
  return artifact;
}

export function assertRestoreConfirmation(value) {
  if (value !== PARTNER_DATABASE_NAME) {
    throw new Error(`Restore requires PARTNER_RESTORE_CONFIRM=${PARTNER_DATABASE_NAME}`);
  }
}

export function formatBackupTimestamp(date = new Date()) {
  return date.toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
