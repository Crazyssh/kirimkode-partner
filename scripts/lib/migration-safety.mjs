import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const PARTNER_PACKAGE_NAME = "@kirimkode/partner-platform";
const SAFE_MIGRATION_DATABASE = /^kirimkode_partner_(?:ci|test)(?:_[a-z0-9_]+)?$/;
const DESTRUCTIVE_SQL = /\b(DROP|TRUNCATE)\b/giu;

/**
 * Blank out everything that is NOT executable SQL so the destructive-keyword
 * scan only sees real statements, while keeping every index aligned with the
 * original text (each masked character is replaced 1:1, newlines preserved).
 *
 * The masker is aware of single-quoted Postgres string literals (including the
 * `''` escaped-quote), which is what closes the scanner-bypass: a `--` or `/*`
 * token INSIDE a string literal is data, not a comment, so it can no longer
 * swallow a real `DROP`/`TRUNCATE` that follows the closing quote. String
 * contents are themselves masked, so a destructive keyword that is merely the
 * data of a string literal (e.g. `VALUES ('DROP TABLE ...')`) is not flagged —
 * such a keyword is never an executed statement. The policy is safe by
 * construction: a destructive keyword only executes as SQL when it sits OUTSIDE
 * any string, and that is exactly what stays visible. An unterminated literal
 * masks to end-of-input (Postgres rejects it as a syntax error anyway), erring
 * away from a bypass.
 */
function maskSqlComments(sql) {
  let result = "";
  let index = 0;
  let blockDepth = 0;
  let inString = false;

  while (index < sql.length) {
    const character = sql[index];

    if (inString) {
      // Inside a single-quoted string literal: all data, no comments start
      // here. A doubled quote (`''`) is an escaped quote and stays inside; a
      // lone quote closes the literal.
      if (character === "'") {
        if (sql[index + 1] === "'") {
          result += "  ";
          index += 2;
          continue;
        }
        inString = false;
        result += " ";
        index += 1;
        continue;
      }
      result += character === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }

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
    // A string literal only opens in normal SQL, never inside a comment, so a
    // quote within a comment stays inert.
    if (blockDepth === 0 && character === "'") {
      inString = true;
      result += " ";
      index += 1;
      continue;
    }
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
