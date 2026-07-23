import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createPartnerBackupPlan } from "../../scripts/backup-partner-db.mjs";
import { createPartnerReleasePlan } from "../../scripts/release-partner.mjs";
import {
  assertPartnerBackupArtifact,
  assertPartnerProcessName,
  parsePartnerDatabaseUrl,
  postgresEnvironment,
} from "../../scripts/lib/partner-target-guards.mjs";

const appRoot = fileURLToPath(new URL("../../", import.meta.url));
const partnerDatabaseUrl = "postgresql://kirimkode_partner_app:secret@127.0.0.1:5432/kirimkode_partner?sslmode=require";

function deploymentFile(relativePath: string): string {
  return readFileSync(path.join(appRoot, relativePath), "utf8");
}

describe("Partner deployment target guards", () => {
  // Validates: Requirements 1.2, 1.5, 22.3, 22.6
  it("accepts only the dedicated Partner PM2 process and database", () => {
    expect(assertPartnerProcessName("kirimkode-partner")).toBe("kirimkode-partner");
    expect(() => assertPartnerProcessName("kirimkode")).toThrow("unsafe PM2 target");
    expect(parsePartnerDatabaseUrl(partnerDatabaseUrl).databaseName).toBe("kirimkode_partner");
    expect(() => parsePartnerDatabaseUrl("postgresql://kirimkode_partner_app:secret@localhost:5432/kirimkode"))
      .toThrow("database target other than kirimkode_partner");
    expect(() => parsePartnerDatabaseUrl("postgresql://main_app:secret@localhost:5432/kirimkode_partner"))
      .toThrow("role outside the Partner namespace");
  });

  it("passes PostgreSQL credentials through environment instead of command arguments", () => {
    const environment = postgresEnvironment(partnerDatabaseUrl, {});
    expect(environment).toMatchObject({
      PGDATABASE: "kirimkode_partner",
      PGHOST: "127.0.0.1",
      PGPORT: "5432",
      PGUSER: "kirimkode_partner_app",
      PGPASSWORD: "secret",
      PGSSLMODE: "require",
    });
  });

  it("keeps backup artifacts inside the Partner-only namespace", () => {
    const backupRoot = path.join(appRoot, "backups", "kirimkode-partner");
    const artifact = path.join(backupRoot, "kirimkode_partner_20260101T010203Z.dump");
    expect(assertPartnerBackupArtifact(artifact, backupRoot)).toBe(path.resolve(artifact));
    expect(() => assertPartnerBackupArtifact(path.join(appRoot, "main.dump"), backupRoot))
      .toThrow("outside Partner backup root");
    expect(() => assertPartnerBackupArtifact(path.join(backupRoot, "kirimkode.dump"), backupRoot))
      .toThrow("filename contract");
  });
});

describe("Partner deployment artifacts", () => {
  // Validates: Requirements 1.2, 1.5, 20.1, 22.6
  it("defines one isolated PM2 process on port 3001 with dedicated paths", () => {
    const ecosystem = deploymentFile("deploy/ecosystem.config.cjs");
    expect(ecosystem).toContain('name: "kirimkode-partner"');
    expect(ecosystem).toContain('PARTNER_PORT: "3001"');
    expect(ecosystem).toContain("/var/log/kirimkode-partner/");
    expect(ecosystem).toContain("/etc/kirimkode-partner/partner.env");
    expect(ecosystem).not.toMatch(/name:\s*["']kirimkode["']/);
  });

  it("routes both Partner domains only to the Partner port", () => {
    const portal = deploymentFile("deploy/nginx/partner.kirimkode.com.conf");
    const api = deploymentFile("deploy/nginx/partner-api.kirimkode.com.conf");
    expect(portal).toContain("server_name partner.kirimkode.com");
    expect(api).toContain("server_name partner-api.kirimkode.com");
    expect(portal).toContain("proxy_pass http://127.0.0.1:3001");
    expect(api).toContain("proxy_pass http://127.0.0.1:3001");
    expect(api).toContain("^/api/(agent|internal)/v1");
    expect(api).toContain("location / { return 404; }");
    expect(`${portal}\n${api}`).not.toContain("127.0.0.1:3000");
  });

  it("builds, migrates, and reloads only Partner Platform", () => {
    const plan = createPartnerReleasePlan(appRoot);
    expect(plan.map(({ command, args }) => [command, ...args])).toEqual([
      ["npm", "ci"],
      ["npm", "run", "build"],
      ["npm", "exec", "--", "prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"],
      ["pm2", "reload", "kirimkode-partner", "--update-env"],
    ]);
    expect(JSON.stringify(plan)).not.toMatch(/(?:reload|restart).*?["']?kirimkode["']?(?!-partner)/);
  });

  it("creates a Partner-only custom-format backup plan", () => {
    const backupRoot = path.join(appRoot, "backups", "kirimkode-partner");
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
    expect(plan.args.join(" ")).not.toContain(partnerDatabaseUrl);
  });
});
