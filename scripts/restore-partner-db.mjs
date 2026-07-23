import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  assertPartnerBackupArtifact,
  assertPartnerBackupRoot,
  assertRestoreConfirmation,
  parsePartnerDatabaseUrl,
  postgresEnvironment,
} from "./lib/partner-target-guards.mjs";
import { DEFAULT_PARTNER_BACKUP_ROOT } from "./backup-partner-db.mjs";

export function createPartnerRestorePlan(artifactValue, environment = process.env) {
  const { databaseName } = parsePartnerDatabaseUrl(environment.PARTNER_DATABASE_URL || "");
  assertRestoreConfirmation(environment.PARTNER_RESTORE_CONFIRM);
  const backupRoot = assertPartnerBackupRoot(environment.PARTNER_BACKUP_ROOT || DEFAULT_PARTNER_BACKUP_ROOT);
  const artifact = assertPartnerBackupArtifact(artifactValue || "", backupRoot);
  const manifest = JSON.parse(readFileSync(`${artifact}.manifest.json`, "utf8"));
  if (manifest.database !== "kirimkode_partner") {
    throw new Error("Refusing backup manifest for a non-Partner database");
  }
  const sha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  if (manifest.sha256 !== sha256) throw new Error("Refusing backup with checksum mismatch");
  return {
    artifact,
    command: "pg_restore",
    // Without --dbname, pg_restore emits the archive as a SQL script to stdout
    // and exits 0 without touching any database — a silent no-op. Naming the
    // target database makes pg_restore connect (via the PG* environment set by
    // postgresEnvironment) and actually restore. The database name, not the
    // full URL, is passed so credentials never appear in argv.
    args: ["--dbname", databaseName, "--exit-on-error", "--single-transaction", "--clean", "--if-exists", "--no-owner", "--no-privileges", artifact],
  };
}

export function runPartnerRestore(artifact, environment = process.env) {
  const plan = createPartnerRestorePlan(artifact, environment);
  if (environment.PARTNER_RESTORE_DRY_RUN === "1") {
    console.log(`Partner restore: ${plan.command} ${plan.args.join(" ")}`);
    return;
  }
  const result = spawnSync(plan.command, plan.args, {
    env: postgresEnvironment(environment.PARTNER_DATABASE_URL, environment),
    shell: false,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pg_restore failed with status ${result.status}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { runPartnerRestore(process.argv[2]); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
