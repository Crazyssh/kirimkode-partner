import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const databaseUrlValue = process.env.PARTNER_DATABASE_URL;
if (!databaseUrlValue) throw new Error("PARTNER_DATABASE_URL is required for Partner seed");
const databaseUrl = new URL(databaseUrlValue);
if (databaseUrl.protocol !== "postgresql:" && databaseUrl.protocol !== "postgres:") {
  throw new Error("Partner seed requires a PostgreSQL URL");
}
if (decodeURIComponent(databaseUrl.pathname) !== "/kirimkode_partner") {
  throw new Error("Partner seed refuses every database except kirimkode_partner");
}

const client = new Client({ connectionString: databaseUrl.toString() });
await client.connect();
try {
  const identity = await client.query("SELECT current_database() AS name");
  if (identity.rows[0]?.name !== "kirimkode_partner") throw new Error("Connected to unexpected database");
  const seedSql = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "seed.sql"), "utf8");
  await client.query("BEGIN");
  try { await client.query(seedSql); await client.query("COMMIT"); }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  console.log("Partner MVP PlatformConfig seed is present and unchanged.");
} finally {
  await client.end();
}