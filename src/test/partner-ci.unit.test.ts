import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflowPath = fileURLToPath(
  new URL("../../.github/workflows/partner-ci.yml", import.meta.url),
);
const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const migrationRunnerPath = fileURLToPath(
  new URL("../../scripts/migrate-from-empty.mjs", import.meta.url),
);

// **Validates: Requirements 1.1, 22.3, 22.4, 22.6**
describe("Partner-only CI workflow", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const migrationRunner = readFileSync(migrationRunnerPath, "utf8");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    name: string;
    scripts: Record<string, string>;
  };
  const requiredScripts = [
    "lint",
    "typecheck",
    "build",
    "test:unit",
    "test:property",
    "test:integration",
    "migration:check",
    "migration:from-empty",
  ];

  it.each(requiredScripts)("runs required Partner validation: %s", (script) => {
    expect(workflow).toContain(`npm run ${script}`);
    expect(packageJson.scripts[script]).toBeTruthy();
  });

  it("keeps every CI entry point local to the Partner package", () => {
    expect(packageJson.name).toBe("@kirimkode/partner-platform");

    const commands = requiredScripts.map((script) => packageJson.scripts[script]).join("\n");
    expect(commands).not.toMatch(
      /(?:\.\.[\\/]|--prefix\s+\.\.|\bpm2\b|\brestart\b|kirimkode-main|main-platform)/iu,
    );
  });

  it("uses only Partner database namespaces and never restarts a process", () => {
    expect(workflow).toContain("kirimkode_partner_ci");
    expect(workflow).not.toMatch(
      /(?:\bpm2\b|\brestart\b|\.\.[\\/]|--prefix\s+\.\.|kirimkode-main|main-platform)/iu,
    );
    expect(workflow).not.toContain(
      "PARTNER_MIGRATION_DATABASE_URL: postgresql://postgres:partner_ci@localhost:5432/kirimkode\n",
    );
  });

  it("passes the validated disposable URL to the Partner Prisma datasource", () => {
    expect(migrationRunner).toContain("PARTNER_DATABASE_URL: databaseUrl.toString()");
    expect(migrationRunner).not.toMatch(
      /^\s*DATABASE_URL:\s*databaseUrl\.toString\(\),?$/mu,
    );
  });
});
