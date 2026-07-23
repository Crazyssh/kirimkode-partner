import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const PARTNER_PACKAGE_NAME = "@kirimkode/partner-platform";
const SAFE_MIGRATION_DATABASE = /^kirimkode_partner_(?:ci|test)(?:_[a-z0-9_]+)?$/;
const DESTRUCTIVE_SQL = /\b(DROP|TRUNCATE)\b/giu;

function maskSqlComments(sql) {
  let result = "";
  let index = 0;
  let blockDepth = 0;

  while (index < sql.length) {
    const pair = sql.slice(index, index + 2);
    if (blockDepth === 0 && pair === "--") {
      const lineEnd = sql.indexOf("\n", index);
      if (lineEnd === -1) return result + " ".repeat(sql.length - index);
      result += " ".repeat(lineEnd - index) + "\n";
      index = lineEnd + 1;
      continue;
    }
    if (pair === "/*") {
      blockDepth += 1;
      result += "  ";
      index += 2;
      continue;
    }
    if (blockDepth > 0 && pair === "*/") {
      blockDepth -= 1;
      result += "  ";
      index += 2;
      continue;
    }
    const character = sql[index];
    result += blockDepth > 0 && character !== "\n" ? " " : character;
    index += 1;
  }

  return result;
}

function locationAt(sql, index) {
  const lines = sql.slice(0, index).split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

export function scanMigrationSql(sql, source = "migration.sql") {
  const visibleSql = maskSqlComments(sql);
  return [...visibleSql.matchAll(DESTRUCTIVE_SQL)].map((match) => ({
    source,
    keyword: match[1].toUpperCase(),
    ...locationAt(sql, match.index),
  }));
}

export async function findMigrationSqlFiles(rootDirectory) {
  let entries;
  try {
    entries = await readdir(rootDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(rootDirectory, entry.name);
      if (entry.isDirectory()) return findMigrationSqlFiles(entryPath);
      return entry.isFile() && entry.name === "migration.sql" ? [entryPath] : [];
    }),
  );
  return files.flat().sort();
}

export async function scanMigrationDirectory(rootDirectory) {
  const files = await findMigrationSqlFiles(rootDirectory);
  const scans = await Promise.all(
    files.map(async (file) => {
      const sql = await readFile(file, "utf8");
      return scanMigrationSql(sql, path.relative(rootDirectory, file));
    }),
  );
  return scans.flat();
}

export function assertPartnerCiDatabaseUrl(value) {
  if (!value) throw new Error("PARTNER_MIGRATION_DATABASE_URL is required");
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Partner CI migration requires a PostgreSQL URL");
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!SAFE_MIGRATION_DATABASE.test(databaseName)) {
    throw new Error(
      `Refusing non-disposable Partner migration database: ${databaseName || "<empty>"}`,
    );
  }
  return url;
}

export function assertPartnerRepository(packageName, repositoryRoot) {
  if (packageName !== PARTNER_PACKAGE_NAME) {
    throw new Error(`Refusing non-Partner package: ${packageName}`);
  }
  if (path.basename(repositoryRoot) !== "kirimkode-partner") {
    throw new Error(`Refusing non-Partner repository directory: ${repositoryRoot}`);
  }
}
