import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertPartnerAppRoot,
  assertPartnerProcessName,
  parsePartnerDatabaseUrl,
  PARTNER_PROCESS_NAME,
} from "./lib/partner-target-guards.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createPartnerReleasePlan(appRoot = scriptRoot) {
  const root = assertPartnerAppRoot(appRoot);
  const processName = assertPartnerProcessName(PARTNER_PROCESS_NAME);
  return [
    { command: "npm", args: ["ci"], cwd: root },
    { command: "npm", args: ["run", "build"], cwd: root },
    { command: "npm", args: ["exec", "--", "prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"], cwd: root },
    { command: "pm2", args: ["reload", processName, "--update-env"], cwd: root },
  ];
}

function execute(step, dryRun) {
  console.log(`Partner release: ${step.command} ${step.args.join(" ")}`);
  if (dryRun) return;
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${step.command} failed with status ${result.status}`);
}

export function runPartnerRelease(environment = process.env) {
  const root = assertPartnerAppRoot(environment.PARTNER_APP_ROOT || scriptRoot);
  parsePartnerDatabaseUrl(environment.PARTNER_DATABASE_URL || "");
  for (const step of createPartnerReleasePlan(root)) {
    execute(step, environment.PARTNER_RELEASE_DRY_RUN === "1");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { runPartnerRelease(); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
