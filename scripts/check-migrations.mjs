import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertPartnerRepository,
  scanMigrationDirectory,
} from "./lib/migration-safety.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
);
assertPartnerRepository(packageJson.name, repositoryRoot);

const migrationsRoot = path.join(repositoryRoot, "prisma", "migrations");
const violations = await scanMigrationDirectory(migrationsRoot);
if (violations.length > 0) {
  for (const violation of violations) {
    console.error(
      `${violation.source}:${violation.line}:${violation.column} destructive ${violation.keyword} is forbidden during Partner MVP`,
    );
  }
  process.exitCode = 1;
} else {
  console.log("Partner migration SQL safety check passed.");
}
