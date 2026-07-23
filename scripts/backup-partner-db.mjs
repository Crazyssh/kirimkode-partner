import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  assertPartnerBackupArtifact,
  assertPartnerBackupRoot,
  formatBackupTimestamp,
  parsePartnerDatabaseUrl,
  postgresEnvironment,
} from "./lib/partner-target-guards.mjs";

export const DEFAULT_PARTNER_BACKUP_ROOT = "/var/backups/kirimkode-partner";

export function createPartnerBackupPlan(environment = process.env, now = new Date()) {
  parsePartnerDatabaseUrl(environment.PARTNER_DATABASE_URL || "");
  const backupRoot = assertPartnerBackupRoot(environment.PARTNER_BACKUP_ROOT || DEFAULT_PARTNER_BACKUP_ROOT);
  const artifact = assertPartnerBackupArtifact(
    path.join(backupRoot, `kirimkode_partner_${formatBackupTimestamp(now)}.dump`),
    backupRoot,
  );
  return {
    artifact,
    backupRoot,
    command: "pg_dump",
    args: ["--format=custom", "--no-owner", "--no-privileges", `--file=${artifact}.partial`],
  };
}

export function runPartnerBackup(environment = process.env) {
  const plan = createPartnerBackupPlan(environment);
  mkdirSync(plan.backupRoot, { mode: 0o700, recursive: true });
  if (environment.PARTNER_BACKUP_DRY_RUN === "1") {
    console.log(`Partner backup: ${plan.command} ${plan.args.join(" ")}`);
    return plan.artifact;
  }
  const partial = `${plan.artifact}.partial`;
  try {
    const result = spawnSync(plan.command, plan.args, {
      env: postgresEnvironment(environment.PARTNER_DATABASE_URL, environment),
      shell: false,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`pg_dump failed with status ${result.status}`);
    renameSync(partial, plan.artifact);
    const sha256 = createHash("sha256").update(readFileSync(plan.artifact)).digest("hex");
    writeFileSync(`${plan.artifact}.manifest.json`, `${JSON.stringify({ database: "kirimkode_partner", sha256 }, null, 2)}\n`, { mode: 0o600 });
    return plan.artifact;
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(runPartnerBackup()); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
