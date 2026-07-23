import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createPartnerBackupPlan } from "../../scripts/backup-partner-db.mjs";
import { createPartnerRestorePlan } from "../../scripts/restore-partner-db.mjs";
import { createPartnerReleasePlan } from "../../scripts/release-partner.mjs";
import {
  PARTNER_DATABASE_NAME,
  PARTNER_PROCESS_NAME,
  parsePartnerDatabaseUrl,
} from "../../scripts/lib/partner-target-guards.mjs";
import { createLivenessHandler } from "@app/api/health/live/route";
import { createReadinessHandler } from "@app/api/health/ready/route";
import { DEPENDENCY_UNAVAILABLE } from "@application/health/partner-health-service";

/**
 * Task 17.5 — Automated smoke/isolation test for Partner build and deployment.
 *
 * These are static assertions parsed from the REAL config, script, and template
 * artifacts (plus in-process health handlers), so no PostgreSQL is required.
 * They prove the Partner Platform builds/runs/deploys with process, port,
 * output, cache, env, log, Nginx, and database-grant isolation from the Main
 * Platform, and that a Partner outage degrades in a structured, non-crashing
 * way while Main's existing providers stay unaffected.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 18.1, 22.1, 22.5, 22.6**
 */

const partnerRoot = fileURLToPath(new URL("../../", import.meta.url));
// Sibling checkout of the Main repository (present only in the combined
// workspace, absent in the Partner-only CI checkout).
const mainRoot = fileURLToPath(new URL("../../../", import.meta.url));
const partnerDatabaseUrl =
  "postgresql://kirimkode_partner_app:secret@127.0.0.1:5432/kirimkode_partner?sslmode=require";

function partnerFile(relativePath: string): string {
  return readFileSync(path.join(partnerRoot, relativePath), "utf8");
}

function mainFile(relativePath: string): string {
  return readFileSync(path.join(mainRoot, relativePath), "utf8");
}

const mainAvailable = existsSync(path.join(mainRoot, "src", "lib", "provider-partner.ts"));

describe("Task 17.5 — build/output/env/log isolation (Req 1.1, 1.2)", () => {
  const packageJson = JSON.parse(partnerFile("package.json")) as {
    name: string;
    scripts: Record<string, string>;
  };

  it("builds with a dedicated Next output dir and standalone tracing root", () => {
    const nextConfig = partnerFile("next.config.ts");
    // Partner owns its own build output — never Main's `.next`.
    expect(nextConfig).toContain('distDir: ".partner-next"');
    expect(nextConfig).toContain('output: "standalone"');
    expect(nextConfig).toContain("outputFileTracingRoot: process.cwd()");
    expect(nextConfig).not.toMatch(/["'`]\.next["'`]/);
    expect(nextConfig).not.toMatch(/\.\.[\\/]/);
  });

  it("keeps typecheck build cache inside the Partner-only cache dir", () => {
    const tsconfig = partnerFile("tsconfig.json");
    expect(tsconfig).toContain(".partner-cache/typescript/tsconfig.tsbuildinfo");
    // The isolated output/cache dirs are owned artifacts, not shared with Main.
    const gitignore = partnerFile(".gitignore");
    expect(gitignore).toContain("/.partner-next/");
    expect(gitignore).toContain("/.partner-cache/");
  });

  it("runs build/lint/typecheck/test entirely within the Partner package", () => {
    expect(packageJson.name).toBe("@kirimkode/partner-platform");
    const isolationScripts = ["build", "lint", "typecheck", "test", "test:unit", "test:property", "test:integration"];
    const commands = isolationScripts.map((script) => packageJson.scripts[script]);
    for (const command of commands) {
      expect(command).toBeTruthy();
    }
    // No script escapes the package root, targets a sibling repo, or drives PM2.
    expect(commands.join("\n")).not.toMatch(
      /(?:\.\.[\\/]|--prefix\s+\.\.|\bpm2\b|\brestart\b|kirimkode-main|main-platform|\/var\/www\/kirimkode(?!-partner))/iu,
    );
    // Build only prepares Prisma + Next, never a Main artifact.
    expect(packageJson.scripts.build).toBe("npm run prisma:generate && next build");
    expect(packageJson.scripts.lint).toBe("eslint --no-cache .");
    expect(packageJson.scripts.typecheck).toBe("tsc --noEmit");
  });

  it("separates every runtime env key under the PARTNER_ namespace", () => {
    const envExample = partnerFile(".env.example");
    const declaredKeys = envExample
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.split("=", 1)[0]);
    expect(declaredKeys.length).toBeGreaterThan(0);
    for (const key of declaredKeys) {
      expect(key).toMatch(/^PARTNER_/);
    }
    // Dedicated DB, session, service (HMAC), and device secrets — all distinct
    // from Main (Req 22.1). Partner never references Main secret names.
    expect(declaredKeys).toContain("PARTNER_DATABASE_URL");
    expect(declaredKeys).toContain("PARTNER_SESSION_SECRET");
    expect(declaredKeys).toContain("PARTNER_INTERNAL_API_HMAC_CURRENT_SECRET");
    expect(declaredKeys).toContain("PARTNER_DEVICE_CREDENTIAL_PEPPER");
  });
});

describe("Task 17.5 — PM2 process/port/log isolation (Req 1.2, 1.5, 22.6)", () => {
  const ecosystem = partnerFile("deploy/ecosystem.config.cjs");

  it("targets only the Partner PM2 app on port 3001 with dedicated log paths", () => {
    expect(ecosystem).toContain('name: "kirimkode-partner"');
    expect(ecosystem).toContain('PARTNER_PORT: "3001"');
    expect(ecosystem).toContain('PORT: "3001"');
    expect(ecosystem).toContain("/var/log/kirimkode-partner/app.log");
    expect(ecosystem).toContain("/var/log/kirimkode-partner/error.log");
    expect(ecosystem).toContain("/etc/kirimkode-partner/partner.env");
    // Never references Main's app name, port, cwd, or logs.
    expect(ecosystem).not.toMatch(/name:\s*["']kirimkode["']/);
    expect(ecosystem).not.toContain(":3000");
    expect(ecosystem).not.toMatch(/\/var\/log\/kirimkode(?!-partner)\//);
    expect(ecosystem).not.toMatch(/\/var\/www\/kirimkode(?!-partner)/);
  });

  it("refuses to load the PM2 config outside the Partner app root", () => {
    expect(ecosystem).toContain('path.basename(appRoot) !== "kirimkode-partner"');
    expect(ecosystem).toContain("Refusing PM2 config outside the kirimkode-partner app root");
  });

  it("boots the process only when PARTNER_PORT equals 3001", () => {
    const starter = partnerFile("scripts/start-partner.mjs");
    expect(starter).toContain('const PARTNER_PORT = "3001"');
    expect(starter).toContain("PARTNER_PORT must equal 3001");
    expect(starter).not.toContain("3000");
  });
});

describe("Task 17.5 — deployment reload targets only Partner (Req 1.1, 22.6)", () => {
  it("builds, migrates, and reloads exclusively the Partner PM2 process", () => {
    const plan = createPartnerReleasePlan(partnerRoot);
    expect(plan.map(({ command, args }) => [command, ...args])).toEqual([
      ["npm", "ci"],
      ["npm", "run", "build"],
      ["npm", "exec", "--", "prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"],
      ["pm2", "reload", "kirimkode-partner", "--update-env"],
    ]);
    const serialized = JSON.stringify(plan);
    // Only the Partner process name appears; never a bare "kirimkode" Main app,
    // and never restart/kill of a Main PID/process.
    expect(serialized).toContain(PARTNER_PROCESS_NAME);
    expect(serialized).not.toMatch(/["']kirimkode["']/);
    expect(serialized).not.toMatch(/(?:reload|restart|delete|stop|kill)[^"]*["']kirimkode["'](?!-partner)/i);
  });

  it("never references a Main PID/process file in the release or start scripts", () => {
    const releaseScript = partnerFile("scripts/release-partner.mjs");
    const starter = partnerFile("scripts/start-partner.mjs");
    const guards = partnerFile("scripts/lib/partner-target-guards.mjs");
    // Any PM2 target must go through the process-name guard.
    expect(guards).toContain('export const PARTNER_PROCESS_NAME = "kirimkode-partner"');
    expect(guards).toContain("Refusing unsafe PM2 target");
    for (const source of [releaseScript, starter]) {
      expect(source).not.toMatch(/\/var\/run\/kirimkode(?!-partner)/);
      expect(source).not.toMatch(/\bkirimkode-main\b|\bmain-platform\b/);
    }
    // The only PID file the deployment writes belongs to the Partner process.
    expect(partnerFile("deploy/ecosystem.config.cjs")).toContain(
      "/var/run/kirimkode-partner/kirimkode-partner.pid",
    );
  });
});

describe("Task 17.5 — backup/restore guard against Main DB (Req 22.6)", () => {
  it("plans a custom-format Partner-only backup that never names the Main DB", () => {
    const backupRoot = path.join(partnerRoot, "backups", "kirimkode-partner");
    const plan = createPartnerBackupPlan(
      { PARTNER_DATABASE_URL: partnerDatabaseUrl, PARTNER_BACKUP_ROOT: backupRoot },
      new Date("2026-01-01T01:02:03.000Z"),
    );
    expect(plan.artifact).toBe(path.join(backupRoot, "kirimkode_partner_20260101T010203Z.dump"));
    expect([plan.command, ...plan.args]).toEqual([
      "pg_dump",
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--file=${plan.artifact}.partial`,
    ]);
  });

  it("refuses a backup whose database URL targets the Main database", () => {
    const backupRoot = path.join(partnerRoot, "backups", "kirimkode-partner");
    expect(() =>
      createPartnerBackupPlan(
        {
          PARTNER_DATABASE_URL:
            "postgresql://kirimkode_partner_app:secret@127.0.0.1:5432/kirimkode",
          PARTNER_BACKUP_ROOT: backupRoot,
        },
        new Date("2026-01-01T01:02:03.000Z"),
      ),
    ).toThrow("database target other than kirimkode_partner");
  });

  it("requires explicit confirmation and a Partner manifest before any restore", () => {
    const backupRoot = path.join(partnerRoot, "backups", "kirimkode-partner");
    const artifact = path.join(backupRoot, "kirimkode_partner_20260101T010203Z.dump");
    // Missing PARTNER_RESTORE_CONFIRM aborts before touching any database.
    expect(() =>
      createPartnerRestorePlan(artifact, {
        PARTNER_DATABASE_URL: partnerDatabaseUrl,
        PARTNER_BACKUP_ROOT: backupRoot,
      }),
    ).toThrow(`Restore requires PARTNER_RESTORE_CONFIRM=${PARTNER_DATABASE_NAME}`);
    // A Main-targeted URL is rejected regardless of confirmation.
    expect(() =>
      createPartnerRestorePlan(artifact, {
        PARTNER_DATABASE_URL:
          "postgresql://kirimkode_partner_app:secret@127.0.0.1:5432/kirimkode",
        PARTNER_BACKUP_ROOT: backupRoot,
        PARTNER_RESTORE_CONFIRM: "kirimkode",
      }),
    ).toThrow("database target other than kirimkode_partner");
  });

  it("only accepts a PARTNER_DATABASE_URL bound to the Partner DB and role namespace", () => {
    expect(parsePartnerDatabaseUrl(partnerDatabaseUrl).databaseName).toBe("kirimkode_partner");
    expect(() =>
      parsePartnerDatabaseUrl("postgresql://main_app:secret@127.0.0.1:5432/kirimkode_partner"),
    ).toThrow("role outside the Partner namespace");
  });
});

describe("Task 17.5 — Nginx HTTPS/live/readiness/routing (Req 1.4, 18.1)", () => {
  const portal = partnerFile("deploy/nginx/partner.kirimkode.com.conf");
  const api = partnerFile("deploy/nginx/partner-api.kirimkode.com.conf");

  it("forces HTTPS by redirecting plain HTTP on both Partner domains", () => {
    for (const conf of [portal, api]) {
      expect(conf).toMatch(/listen 80;/);
      expect(conf).toContain("return 308 https://");
      expect(conf).toMatch(/listen 443 ssl http2;/);
      expect(conf).toContain("ssl_certificate ");
      expect(conf).toContain("ssl_certificate_key ");
    }
  });

  it("exposes unauthenticated liveness and readiness only on the API host", () => {
    expect(api).toContain("^/api/health/(live|ready)$");
    expect(api).toContain("proxy_pass http://127.0.0.1:3001");
  });

  it("routes only the two Partner hostnames to the Partner port", () => {
    expect(portal).toContain("server_name partner.kirimkode.com");
    expect(api).toContain("server_name partner-api.kirimkode.com");
    expect(api).toContain("^/api/(agent|internal)/v1");
    // Agent/Internal host denies everything else and never proxies Main.
    expect(api).toContain("location / { return 404; }");
    expect(`${portal}\n${api}`).not.toContain("127.0.0.1:3000");
    expect(`${portal}\n${api}`).not.toMatch(/server_name\s+(?:www\.)?kirimkode\.com/);
  });
});

describe("Task 17.5 — DB grants stay inside the Partner database (Req 22.6)", () => {
  const roleTemplate = partnerFile("prisma/admin/partner-role-grants.sql.template");

  it("grants the Partner app role access to kirimkode_partner only", () => {
    expect(roleTemplate).toContain(
      "GRANT CONNECT ON DATABASE kirimkode_partner TO kirimkode_partner_app",
    );
    expect(roleTemplate).toContain("GRANT USAGE ON SCHEMA public TO kirimkode_partner_app");
    expect(roleTemplate).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kirimkode_partner_app",
    );
    // Least privilege: creating the role never grants superuser/replication.
    expect(roleTemplate).toContain(
      "CREATE ROLE kirimkode_partner_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION",
    );
  });

  it("hard-blocks any grant that would let the Partner role reach the Main DB", () => {
    // The template refuses to run unless it verifies the role cannot CONNECT to
    // the Main database `kirimkode`.
    expect(roleTemplate).toContain(
      "has_database_privilege(:'partner_app_role', database_catalog.oid, 'CONNECT')",
    );
    expect(roleTemplate).toContain(
      "Refusing setup: kirimkode_partner_app can CONNECT to Main database kirimkode",
    );
    // Every actual GRANT statement names only Partner-scoped objects; none
    // targets the bare Main database `kirimkode`.
    const grantStatements = roleTemplate
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^GRANT\b/i.test(line));
    expect(grantStatements.length).toBeGreaterThan(0);
    for (const statement of grantStatements) {
      expect(statement).not.toMatch(/\bkirimkode\b(?!_partner)/);
    }
  });

  it("keeps the MVP seed scoped to the Partner PlatformConfig only", () => {
    const seed = partnerFile("prisma/seed.sql");
    expect(seed).toContain('INSERT INTO "platform_configs"');
    // Seed never issues cross-database or grant statements.
    expect(seed).not.toMatch(/GRANT|REVOKE|CREATE ROLE|CREATE USER/i);
    expect(seed).not.toMatch(/\bkirimkode\b(?!_partner)/);
  });
});

describe("Task 17.5 — structured, non-crashing readiness contract (Req 1.3, 1.4)", () => {
  const time = "2026-01-01T00:00:00.000Z";

  it("returns a structured 200 liveness body without touching dependencies", () => {
    const get = createLivenessHandler(() => ({ status: "live", version: "9.9.9", time }));
    const response = get(new Request("https://partner.test/api/health/live"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("degrades to a structured 503 (not a crash) when the DB dependency is down", async () => {
    const get = createReadinessHandler(async () => ({
      status: DEPENDENCY_UNAVAILABLE,
      version: "9.9.9",
      time,
    }));
    const response = await get(new Request("https://partner.test/api/health/ready"));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe(DEPENDENCY_UNAVAILABLE);
  });

  it("reports ready with 200 when the dependency probe succeeds", async () => {
    const get = createReadinessHandler(async () => ({ status: "ready", version: "9.9.9", time }));
    const response = await get(new Request("https://partner.test/api/health/ready"));
    expect(response.status).toBe(200);
  });
});

// The following assertions read the Main repository as a sibling checkout. They
// are skipped automatically in the Partner-only CI checkout (where Main is
// absent) and never modify Main files — they are read-only contract checks that
// a Partner outage yields a structured failure while Main's existing providers
// (api1..api10 / unified) stay unaffected (Req 1.3, 22.2, 22.5).
describe.skipIf(!mainAvailable)("Task 17.5 — Main degrades structurally on Partner outage (Req 1.3, 22.5)", () => {
  it("maps every Partner failure to a stable, non-leaking error code", () => {
    const client = mainFile("src/lib/partner-client.ts");
    // A network error / timeout becomes a structured, retryable PARTNER_UNAVAILABLE.
    expect(client).toContain('throw new PartnerApiError("PARTNER_UNAVAILABLE", 0, true, null)');
    // Missing config keeps Pluto simply unavailable rather than crashing Main.
    expect(client).toContain('throw new PartnerApiError("PARTNER_CONFIG_MISSING", 0, false, null)');
    // The error carries only a stable code/status/retryable flag/requestId.
    expect(client).toMatch(/class PartnerApiError extends Error/);
  });

  it("treats a Partner outage as an empty catalog instead of breaking the buy page", () => {
    const provider = mainFile("src/lib/provider-partner.ts");
    // getLayanan swallows unavailability/stockout into an empty catalog.
    expect(provider).toMatch(/if \(!isPartnerClientConfigured\(\)\) return empty;/);
    expect(provider).toMatch(/}\s*catch\s*{[\s\S]*?return empty;/);
    // getBalance returns zero so a generic server-info sweep never crashes.
    expect(provider).toContain("return { balance: 0 };");
  });

  it("keeps Pluto out of unified/Bimasakti and away from api1..api10 lifecycle", () => {
    const dispatcher = mainFile("src/lib/otp.ts");
    // Partner recognised but its order lifecycle is guarded off the numeric flow.
    expect(dispatcher).toContain(
      'if (server === "partner") throw new Error("Use provider-partner reserve saga for partner (Pluto) orders");',
    );
    expect(dispatcher).toContain('if (server === "partner") throw new Error("Use provider-partner getOrderStatus for partner (Pluto) orders");');
    // Unified provider's server catalog never lists `partner`.
    const unified = mainFile("src/lib/unified-provider.ts");
    expect(unified).not.toMatch(/\bpartner:\s*{/);
    // Existing numeric providers remain declared in the unified server names.
    expect(unified).toContain("api1:");
    expect(unified).toContain("api10:");
  });

  it("keeps Main deployment on its own PM2 app/port, disjoint from Partner", () => {
    const mainEcosystem = mainFile("ecosystem.config.js");
    expect(mainEcosystem).toContain('name: "kirimkode"');
    expect(mainEcosystem).toContain("PORT: 3000");
    // Main's config never targets the Partner process or port.
    expect(mainEcosystem).not.toContain("kirimkode-partner");
    expect(mainEcosystem).not.toContain("3001");
  });
});
