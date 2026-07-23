import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd() });

async function restrictedRuleIds(
  source: string,
  relativeFilePath: string,
): Promise<(string | null)[]> {
  const [result] = await eslint.lintText(source, {
    filePath: path.join(process.cwd(), relativeFilePath),
  });

  return result.messages
    .filter((message) => message.ruleId?.startsWith("no-restricted-"))
    .map((message) => message.ruleId);
}

// **Validates: Requirements 1.2, 19.6, 20.1**
describe("architectural import boundaries", () => {
  it("allows route modules to invoke the application layer", async () => {
    const ruleIds = await restrictedRuleIds(
      'import { getEntryStatus } from "@application/bootstrap/get-entry-status";\nexport function GET() { return getEntryStatus("agent-api-v1"); }',
      "src/app/api/example/route.ts",
    );

    expect(ruleIds).toEqual([]);
  });

  it("rejects route access to domain, infrastructure, and raw Prisma", async () => {
    const ruleIds = await restrictedRuleIds(
      [
        'import "@domain/platform-entry";',
        'import "@infrastructure/database/client";',
        'import "@prisma/client";',
      ].join("\n"),
      "src/app/api/example/route.ts",
    );

    expect(ruleIds).toEqual([
      "no-restricted-imports",
      "no-restricted-imports",
      "no-restricted-imports",
    ]);
  });

  it("rejects raw Prisma and infrastructure imports from UI modules", async () => {
    const ruleIds = await restrictedRuleIds(
      'import "@/generated/prisma/client";\nimport "@infrastructure/database/client";',
      "src/app/example/page.tsx",
    );

    expect(ruleIds).toEqual([
      "no-restricted-imports",
      "no-restricted-imports",
    ]);
  });

  it("keeps domain code independent from runtime, database, and network APIs", async () => {
    const ruleIds = await restrictedRuleIds(
      [
        'import "@application/example";',
        'import "@infrastructure/database/client";',
        'import "pg";',
        "export const runtime = process.env.NODE_ENV;",
        'export const request = fetch("https://invalid.example");',
      ].join("\n"),
      "src/domain/example.ts",
    );

    expect(ruleIds).toEqual([
      "no-restricted-imports",
      "no-restricted-imports",
      "no-restricted-imports",
      "no-restricted-globals",
      "no-restricted-globals",
    ]);
  });
});
