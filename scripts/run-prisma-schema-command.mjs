import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const allowedCommands = new Set(["validate", "generate"]);
const command = process.argv[2];

if (!command || !allowedCommands.has(command)) {
  throw new Error("Expected a non-connecting Prisma schema command: validate or generate");
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prismaCli = path.join(repositoryRoot, "node_modules", "prisma", "build", "index.js");
const schemaPath = path.join(repositoryRoot, "prisma", "schema.prisma");

if (!existsSync(prismaCli) || !existsSync(schemaPath)) {
  throw new Error("Pinned Prisma CLI and Partner schema are required");
}

const result = spawnSync(
  process.execPath,
  [prismaCli, command, "--schema", schemaPath],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PARTNER_DATABASE_URL:
        process.env.PARTNER_DATABASE_URL ??
        "postgresql://schema_validation:local_only@127.0.0.1:5432/kirimkode_partner_schema_validation",
    },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);