import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createPartnerBackupPlan } from "../../scripts/backup-partner-db.mjs";
import { createPartnerReleasePlan, partnerReleaseStepEnvironment } from "../../scripts/release-partner.mjs";
import { createPartnerRestorePlan } from "../../scripts/restore-partner-db.mjs";
import { CRON_SCHEDULE } from "../../scripts/lib/cron-schedule.mjs";
import {
  assertPartnerBackupArtifact,
  assertPartnerProcessName,
  parsePartnerDatabaseUrl,
  parsePartnerMigrationDatabaseUrl,
  postgresEnvironment,
} from "../../scripts/lib/partner-target-guards.mjs";

const appRoot = fileURLToPath(new URL("../../", import.meta.url));
const partnerDatabaseUrl = "postgresql://kirimkode_partner_app:secret@127.0.0.1:5432/kirimkode_partner?sslmode=require";
const partnerMigrationDatabaseUrl = "postgresql://kirimkode_partner_migrator:secret@127.0.0.1:5432/kirimkode_partner";

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

  it("sends hardened security headers on both Partner vhosts", () => {
    const portal = deploymentFile("deploy/nginx/partner.kirimkode.com.conf");
    const api = deploymentFile("deploy/nginx/partner-api.kirimkode.com.conf");

    for (const conf of [portal, api]) {
      // HSTS with a long max-age + includeSubDomains, emitted even on errors.
      expect(conf).toMatch(
        /add_header\s+Strict-Transport-Security\s+"max-age=\d{7,};[^"]*includeSubDomains"\s+always;/,
      );
      expect(conf).toMatch(/add_header\s+X-Content-Type-Options\s+"nosniff"\s+always;/);
      expect(conf).toMatch(/add_header\s+X-Frame-Options\s+"DENY"\s+always;/);
      expect(conf).toMatch(/add_header\s+Referrer-Policy\s+"[^"]+"\s+always;/);
      // A CSP that forbids framing, backstopping the X-Frame-Options clickjacking gate.
      expect(conf).toMatch(
        /add_header\s+Content-Security-Policy\s+"[^"]*frame-ancestors 'none'[^"]*"\s+always;/,
      );
    }

    // The portal serves a document, so it keeps a conservative same-origin
    // default; the JSON-only API is stricter still and may load nothing at all.
    expect(portal).toMatch(/Content-Security-Policy\s+"default-src 'self';/);
    expect(api).toMatch(/Content-Security-Policy\s+"default-src 'none';/);
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

  // Validates: Requirements 20.1, 20.2 — the jobs only ever run because an
  // external scheduler dispatches them, so the deploy guide has to say so.
  //
  // This is a documentation guard with a live failure behind it: the guide once
  // described the whole host setup without mentioning the scheduler at all, and a
  // server built from it looked healthy while earnings never became available and
  // partners could not cash out. `partner-cron-schedule.unit.test.ts` proves each
  // job HAS a cadence; nothing proved an operator is ever told to start the tick.
  it("tells the operator to register the cron scheduler, and how to verify it", () => {
    const guide = deploymentFile("deploy/README.md");

    // The dispatcher, and the fact that exactly one minutely entry drives it.
    expect(guide).toContain("scripts/run-cron.mjs");
    expect(guide).toMatch(/OnCalendar=minutely/);
    expect(guide).toMatch(/systemctl enable --now partner-cron\.timer/);

    // The consequence of skipping it, so the step does not read as optional.
    expect(guide).toMatch(/cannot cash out|never become available/i);

    // A post-release check the operator can alert on.
    expect(guide).toContain("/api/health/cron");
    expect(guide).toContain("--dry-run");
  });

  it("keeps the scheduler paths identical in the guide and in run-cron.mjs", () => {
    // A unit file pointing at a directory that does not exist fails silently once
    // a minute, which is indistinguishable from "nothing was due".
    const guide = deploymentFile("deploy/README.md");
    const runner = deploymentFile("scripts/run-cron.mjs");

    for (const literal of ["/var/www/kirimkode-partner", "/etc/kirimkode-partner/partner.env"]) {
      expect(guide).toContain(literal);
      expect(runner).toContain(literal);
    }
    // The pre-existing footer pointed at /srv and /etc/kirimkode/, neither of which
    // the guide ever creates. Neither may come back.
    for (const stale of ["/srv/kirimkode-partner", "/etc/kirimkode/partner-cron.env"]) {
      expect(`${guide}\n${runner}`).not.toContain(stale);
    }
  });

  it("names every scheduled job in the deploy guide", () => {
    // An eighth job added to the schedule without a line here would leave the
    // guide's job list quietly wrong for whoever operates the host.
    const guide = deploymentFile("deploy/README.md");
    for (const { job } of CRON_SCHEDULE) {
      expect(guide).toContain(job);
    }
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

describe("Partner deployment ops safety", () => {
  // Validates: Requirements 20.1, 22.6 — restore must not silently no-op and
  // release migrations must run as a DDL-capable role, never the app role.
  it("plans a restore that actually targets the Partner database via --dbname", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "partner-restore-plan-"));
    try {
      const backupRoot = path.join(tempRoot, "kirimkode-partner");
      mkdirSync(backupRoot, { recursive: true });
      const artifact = path.join(backupRoot, "kirimkode_partner_20260101T010203Z.dump");
      const dumpBytes = Buffer.from("partner-custom-format-dump");
      writeFileSync(artifact, dumpBytes);
      const sha256 = createHash("sha256").update(dumpBytes).digest("hex");
      writeFileSync(`${artifact}.manifest.json`, JSON.stringify({ database: "kirimkode_partner", sha256 }));

      const plan = createPartnerRestorePlan(artifact, {
        PARTNER_DATABASE_URL: partnerDatabaseUrl,
        PARTNER_BACKUP_ROOT: backupRoot,
        PARTNER_RESTORE_CONFIRM: "kirimkode_partner",
      });

      expect(plan.command).toBe("pg_restore");
      // Without --dbname, pg_restore prints the archive as a script to stdout and
      // exits 0 while restoring nothing; the target DB must be named to restore.
      const dbnameIndex = plan.args.indexOf("--dbname");
      expect(dbnameIndex).toBeGreaterThanOrEqual(0);
      expect(plan.args[dbnameIndex + 1]).toBe("kirimkode_partner");
      // Every safe flag is preserved, the archive is still the final argument,
      // and credentials never reach argv (they travel through the PG* env).
      for (const flag of ["--clean", "--if-exists", "--single-transaction", "--exit-on-error", "--no-owner", "--no-privileges"]) {
        expect(plan.args).toContain(flag);
      }
      expect(plan.args.at(-1)).toBe(artifact);
      expect(plan.args.join(" ")).not.toContain("secret");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs the release migrate step as the DDL-capable migrator role, not the app role", () => {
    const releaseEnvironment = {
      PARTNER_DATABASE_URL: partnerDatabaseUrl,
      PARTNER_MIGRATION_DATABASE_URL: partnerMigrationDatabaseUrl,
    };
    const plan = createPartnerReleasePlan(appRoot);
    const migrateStep = plan.find((step) => step.args.includes("migrate"));
    const reloadStep = plan.find((step) => step.command === "pm2");
    if (!migrateStep || !reloadStep) throw new Error("expected migrate and reload steps");

    // The migrate step swaps the datasource to the migrator URL so Prisma can run
    // DDL; the CREATE-revoked app-role URL is never used for migrations.
    const migrateEnvironment = partnerReleaseStepEnvironment(migrateStep, releaseEnvironment);
    expect(migrateEnvironment.PARTNER_DATABASE_URL).toBe(partnerMigrationDatabaseUrl);
    expect(migrateEnvironment.PARTNER_DATABASE_URL).not.toBe(partnerDatabaseUrl);

    // Every other step (build, reload, ...) keeps running as the runtime app role.
    expect(partnerReleaseStepEnvironment(reloadStep, releaseEnvironment).PARTNER_DATABASE_URL).toBe(partnerDatabaseUrl);

    // The migration URL is guarded: the production Partner DB with a migrator/owner
    // role only, and it refuses the app role (which cannot run DDL) outright.
    expect(parsePartnerMigrationDatabaseUrl(partnerMigrationDatabaseUrl).username).toBe("kirimkode_partner_migrator");
    expect(() => parsePartnerMigrationDatabaseUrl("postgresql://kirimkode_partner_app:secret@127.0.0.1:5432/kirimkode_partner"))
      .toThrow("migration role");
    expect(() => parsePartnerMigrationDatabaseUrl("postgresql://kirimkode_partner_migrator:secret@127.0.0.1:5432/kirimkode"))
      .toThrow("database target other than kirimkode_partner");
    expect(() => partnerReleaseStepEnvironment(migrateStep, {
      ...releaseEnvironment,
      PARTNER_MIGRATION_DATABASE_URL: partnerDatabaseUrl,
    })).toThrow("migration role");
  });
});
