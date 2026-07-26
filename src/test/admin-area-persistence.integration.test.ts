import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AdminAuditService,
  AdminConfigService,
  AdminRawSmsService,
  AdminResourceService,
  CONFIG_ADMIN_PERMISSION,
  InMemoryReauthRegistry,
  PARTNER_LIFECYCLE_PERMISSION,
  PartnerLifecycleService,
  RAW_SMS_PERMISSION,
  RESOURCE_ADMIN_PERMISSION,
  type EditablePlatformConfigFields,
} from "@application/admin";
import { OperationalQueryService } from "@application/portal";
import { createAuditEvent } from "@domain/task-5-7";
import type { AuthenticatedAdmin } from "@domain/task-7-5";
import {
  createPartnerDatabaseClient,
  PrismaAdminConfigGateway,
  PrismaAdminResourceMutationGateway,
  PrismaAdminResourceReadGateway,
  PrismaAuditBrowserGateway,
  PrismaAuditEventRepository,
  PrismaOperationalQueryGateway,
  PrismaPartnerLifecycleGateway,
  PrismaRawSmsReadGateway,
  PrismaUnitOfWork,
  type PartnerDatabaseClient,
} from "@infrastructure/database";
import { SmsOtpCipher } from "@infrastructure/crypto/sms-otp-cipher";
import { CryptoIdGenerator } from "@infrastructure/auth/system-clock";

import {
  createDisposableTestDatabase,
  type DisposableTestDatabase,
} from "./disposable-database";

/**
 * Admin-area persistence integration tests (Partner Admin cluster).
 *
 * These wire the *production* Prisma admin gateways against a real disposable
 * PostgreSQL database — no in-memory fakes — and drive them through the real
 * application services:
 *
 *  - {@link PartnerLifecycleService} + {@link PrismaPartnerLifecycleGateway}:
 *    the pending→approved→suspended→rejected state machine, its compare-and-set
 *    predicate, and the atomic audit event; a suspend leaves terminal order
 *    results intact (requirements 3.4, 3.5).
 *  - {@link AdminConfigService} + {@link PrismaAdminConfigGateway}: an
 *    append-only PlatformConfig publish (INSERT of `max(version)+1`, never an
 *    UPDATE), asserted against the `platform_configs_immutable` trigger which
 *    must reject any UPDATE/DELETE, and the `createdByAdminId` FK to
 *    `partner_admins` (requirements 16.5, 8.5).
 *  - {@link AdminResourceService} + resource read/mutation gateways: the
 *    redaction-safe partner directory/header/SMS reads and the non-destructive
 *    disable commands for device/number/offer, including the idle-number state
 *    guard and the `partner_numbers_active_canonical_check` CASE constraint
 *    (requirements 16.3, 16.4, 16.7, 7.4).
 *  - {@link AdminAuditService} + {@link PrismaAuditBrowserGateway}: paged,
 *    filtered, newest-first browsing (requirements 19.1, 19.2).
 *  - {@link AdminRawSmsService} + {@link PrismaRawSmsReadGateway}: the gated
 *    raw SMS/OTP reveal, its decrypt round-trip, and the redacted/no-reauth
 *    refusals (requirements 16.7, 19.3).
 *
 * The suite seeds real state, runs the real gateway operation, then queries the
 * rows back to assert the persisted effect (and, for immutability, the trigger).
 */
const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const adminUrl = process.env.PARTNER_TEST_DATABASE_ADMIN_URL ?? "";
const hasPostgres = adminUrl.length > 0;

/** Deterministic anchor well after the seeded config's `activeFrom`. */
const BASE_EPOCH_MS = Date.UTC(2026, 7, 1, 12, 0, 0);
const HOUR_MS = 60 * 60 * 1000;

/** A deterministic test AES key/version for the SMS/OTP envelope. */
const CIPHER_KEY_VERSION = 9;
const cipher = new SmsOtpCipher({
  current: { version: CIPHER_KEY_VERSION, key: Buffer.alloc(32, 0x3b).toString("base64url") },
});

const idGenerator = new CryptoIdGenerator();

/** A test-controllable clock satisfying the admin services' `Clock` port. */
class MutableClock {
  private current: number;

  constructor(startEpochMs: number) {
    this.current = startEpochMs;
  }

  nowEpochMs(): number {
    return this.current;
  }

  set(epochMs: number): void {
    this.current = epochMs;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

async function deployFromEmpty(connectionString: string): Promise<void> {
  await execFileAsync(process.execPath, ["scripts/migrate-from-empty.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, PARTNER_MIGRATION_DATABASE_URL: connectionString },
    maxBuffer: 10 * 1024 * 1024,
  });
}

/** The immutable MVP platform config the admin form reads (mirrors seed.sql). */
function platformConfigData(version: number, activeKey: string) {
  return {
    id: randomUUID(),
    version,
    serviceCode: "wa",
    countryCode: "ID",
    operatorCode: "any",
    currency: "IDR",
    minBasePriceIdr: 500,
    maxBasePriceIdr: 5_000,
    fixedFeeIdr: 250,
    markupBps: 1_500,
    roundToIdr: 50,
    heartbeatIntervalSeconds: 30,
    heartbeatTimeoutSeconds: 90,
    heartbeatSweepSeconds: 30,
    orderTimeoutSeconds: 1_200,
    cancelMinimumSeconds: 180,
    reservationRecoverySeconds: 30,
    earningHoldSeconds: 86_400,
    minimumPayoutIdr: 1_000,
    smsRawRetentionDays: 7,
    otpRetentionHours: 24,
    heartbeatMetadataRetentionDays: 30,
    securityEventRetentionDays: 90,
    auditRetentionDays: 2_557,
    financialRetentionDays: 2_557,
    simulatorAllowlistJson: { partnerIds: [] },
    activeKey,
    activeFrom: new Date(Date.UTC(2026, 6, 22, 0, 1, 0)),
  };
}

/** The seed's editable fields with one edit, valid against the pure invariants
 * (task 5.7) AND the `platform_configs_policy_check` DB constraint. */
function editedConfigFields(
  overrides: Partial<EditablePlatformConfigFields> = {},
): EditablePlatformConfigFields {
  return {
    minBasePriceIdr: 500,
    maxBasePriceIdr: 5_000,
    fixedFeeIdr: 300,
    markupBps: 1_600,
    roundToIdr: 50,
    orderTimeoutSeconds: 1_200,
    cancelMinimumSeconds: 180,
    heartbeatIntervalSeconds: 30,
    heartbeatTimeoutSeconds: 90,
    earningHoldSeconds: 86_400,
    minimumPayoutIdr: 1_000,
    smsRawRetentionDays: 7,
    otpRetentionHours: 24,
    heartbeatMetadataRetentionDays: 30,
    securityEventRetentionDays: 90,
    auditRetentionDays: 2_557,
    financialRetentionDays: 2_557,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixture seeding (raw client), in FK dependency order.
// ---------------------------------------------------------------------------

/** A real `partner_admins` row; its id is the `AuthenticatedAdmin.adminId`, so
 * the config publish's `createdByAdminId` FK resolves. */
async function createAdmin(
  client: PartnerDatabaseClient,
  permissions: readonly string[],
): Promise<AuthenticatedAdmin> {
  const id = randomUUID();
  await client.partnerAdmin.create({
    data: {
      id,
      emailNormalized: `admin-${id}@example.test`,
      passwordHash: "x".repeat(60),
      permissions: [...permissions],
    },
  });
  return { adminId: id, permissions: [...permissions], securityVersion: 1 };
}

async function createPartner(
  client: PartnerDatabaseClient,
  status: "PENDING" | "APPROVED" | "SUSPENDED" | "REJECTED",
): Promise<string> {
  const id = randomUUID();
  await client.partner.create({
    data: {
      id,
      legalName: "Admin Integration Legal",
      displayName: "Admin Integration Partner",
      status,
      simulatorAllowed: false,
      ...(status === "APPROVED" ? { approvedAt: new Date(BASE_EPOCH_MS - HOUR_MS) } : {}),
    },
  });
  return id;
}

async function createOnlineDevice(
  client: PartnerDatabaseClient,
  partnerId: string,
): Promise<string> {
  const id = randomUUID();
  await client.partnerDevice.create({
    data: {
      id,
      partnerId,
      type: "SIMULATOR",
      label: "Sim",
      effectiveStatus: "ONLINE",
      lastSeenAt: new Date(BASE_EPOCH_MS),
      capabilitiesJson: { sms: true, notification: false, resend: false, operator: null, slots: 1 },
    },
  });
  return id;
}

async function createActiveOffer(
  client: PartnerDatabaseClient,
  partnerId: string,
): Promise<string> {
  const id = randomUUID();
  await client.partnerOffer.create({
    data: {
      id,
      partnerId,
      serviceCode: "wa",
      countryCode: "ID",
      operatorCode: "any",
      basePriceIdr: 1_000,
      status: "ACTIVE",
      configVersion: 1,
      activeDimensionKey: `${partnerId}:wa:ID:any`,
    },
  });
  return id;
}

function uniqueCanonicalNumber(): string {
  // Canonical rule: `+628` then a NON-ZERO digit, then 8 more. Drawing the
  // first digit from 0-9 produced `+6280…` roughly one run in ten, which the
  // domain rightly rejects — a self-inflicted flake, not a product bug.
  let digits = String(randomInt(1, 10));
  for (let i = 0; i < 8; i += 1) digits += String(randomInt(0, 10));
  return `+628${digits}`;
}

async function createNumber(
  client: PartnerDatabaseClient,
  partnerId: string,
  deviceId: string,
  status: "OFFLINE" | "AVAILABLE" | "RESERVED" | "BUSY",
): Promise<{ numberId: string; canonicalNumber: string }> {
  const numberId = randomUUID();
  const canonicalNumber = uniqueCanonicalNumber();
  await client.partnerNumber.create({
    data: {
      id: numberId,
      partnerId,
      deviceId,
      canonicalNumber,
      // The `partner_numbers_active_canonical_check` CASE constraint requires
      // active = canonical while enabled & not disabled.
      activeCanonicalNumber: canonicalNumber,
      countryCode: "ID",
      operatorCode: "any",
      status,
      enabled: true,
    },
  });
  return { numberId, canonicalNumber };
}

// ---------------------------------------------------------------------------
describe.runIf(hasPostgres)("Admin area persistence integration", () => {
  let database: DisposableTestDatabase;
  let client: PartnerDatabaseClient;
  let unitOfWork: PrismaUnitOfWork;

  let lifecycle: PartnerLifecycleService;
  let configService: AdminConfigService;
  let resources: AdminResourceService;
  let auditBrowser: AdminAuditService;
  let rawSms: AdminRawSmsService;
  let reauthRegistry: InMemoryReauthRegistry;
  const clock = new MutableClock(BASE_EPOCH_MS);

  beforeAll(async () => {
    database = await createDisposableTestDatabase(adminUrl);
    await deployFromEmpty(database.connectionString);
    client = createPartnerDatabaseClient({ databaseUrl: database.connectionString });
    await client.$connect();
    await client.platformConfig.create({ data: platformConfigData(1, "mvp-active") });

    unitOfWork = new PrismaUnitOfWork(client);
    const operational = new OperationalQueryService({
      gateway: new PrismaOperationalQueryGateway(client),
    });
    reauthRegistry = new InMemoryReauthRegistry();

    lifecycle = new PartnerLifecycleService({
      gateway: new PrismaPartnerLifecycleGateway(unitOfWork),
      clock,
      idGenerator,
    });
    configService = new AdminConfigService({
      gateway: new PrismaAdminConfigGateway(client),
      clock,
      idGenerator,
    });
    resources = new AdminResourceService({
      reads: new PrismaAdminResourceReadGateway(client),
      mutations: new PrismaAdminResourceMutationGateway(unitOfWork),
      operational,
      clock,
      idGenerator,
    });
    auditBrowser = new AdminAuditService({
      gateway: new PrismaAuditBrowserGateway(client),
    });
    rawSms = new AdminRawSmsService({
      reads: new PrismaRawSmsReadGateway(client),
      decryptor: cipher,
      audit: new PrismaAuditEventRepository(client),
      registry: reauthRegistry,
      clock,
      idGenerator,
    });
  }, 120_000);

  afterAll(async () => {
    await client?.$disconnect();
    await database?.dispose();
  }, 30_000);

  // -------------------------------------------------------------------------
  // Partner lifecycle: approve/suspend/reject over the CAS state machine, with
  // an atomic audit event; a suspend never touches terminal order results.
  // -------------------------------------------------------------------------
  describe("Partner lifecycle drives the CAS state machine with atomic audit", () => {
    it("approves a pending partner, stamps approvedAt, and writes one audit event", async () => {
      clock.set(BASE_EPOCH_MS);
      const admin = await createAdmin(client, [PARTNER_LIFECYCLE_PERMISSION]);
      const partnerId = await createPartner(client, "PENDING");
      const requestId = randomUUID();

      const outcome = await lifecycle.execute({
        admin,
        partnerId,
        command: "approve",
        reason: "verified onboarding documents",
        requestId,
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("unreachable");
      expect(outcome.status).toBe("approved");

      const partner = await client.partner.findUniqueOrThrow({ where: { id: partnerId } });
      expect(partner.status).toBe("APPROVED");
      expect(partner.statusReason).toBe("verified onboarding documents");
      expect(partner.approvedAt?.getTime()).toBe(BASE_EPOCH_MS);

      // The status change and its audit event committed atomically.
      const audits = await client.auditEvent.findMany({
        where: { partnerId, action: "partner.status_changed" },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].requestId).toBe(requestId);
      expect(audits[0].actorType).toBe("PARTNER_ADMIN");
      expect(audits[0].result).toBe("SUCCEEDED");
      // The actor is stored only as a one-way hash, never the raw admin id.
      expect(audits[0].actorRefHash).not.toContain(admin.adminId);
      expect(audits[0].actorRefHash).toHaveLength(64);
    });

    it("suspends an approved partner without mutating its terminal order result", async () => {
      clock.set(BASE_EPOCH_MS + HOUR_MS);
      const admin = await createAdmin(client, [PARTNER_LIFECYCLE_PERMISSION]);
      const partnerId = await createPartner(client, "APPROVED");
      const deviceId = await createOnlineDevice(client, partnerId);
      const offerId = await createActiveOffer(client, partnerId);
      const { numberId } = await createNumber(client, partnerId, deviceId, "AVAILABLE");
      const orderId = randomUUID();
      // A pre-existing terminal SUCCESS order; a suspend must leave it intact.
      await client.partnerOrder.create({
        data: {
          id: orderId,
          buyerOrderRef: `buyer-${orderId}`,
          buyerAccountRef: `acct-${randomUUID()}`,
          partnerId,
          numberId,
          offerId,
          status: "SUCCESS",
          expiresAt: new Date(BASE_EPOCH_MS + HOUR_MS),
          succeededAt: new Date(BASE_EPOCH_MS - HOUR_MS),
          terminalAt: new Date(BASE_EPOCH_MS - HOUR_MS),
        },
      });

      const outcome = await lifecycle.execute({
        admin,
        partnerId,
        command: "suspend",
        reason: "risk review",
        requestId: randomUUID(),
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("unreachable");
      expect(outcome.status).toBe("suspended");

      const partner = await client.partner.findUniqueOrThrow({ where: { id: partnerId } });
      expect(partner.status).toBe("SUSPENDED");
      // Terminal order result untouched (requirement 3.4).
      const order = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe("SUCCESS");
      expect(order.terminalAt?.getTime()).toBe(BASE_EPOCH_MS - HOUR_MS);
    });

    it("rejects an illegal command for the current status without any write", async () => {
      clock.set(BASE_EPOCH_MS);
      const admin = await createAdmin(client, [PARTNER_LIFECYCLE_PERMISSION]);
      const partnerId = await createPartner(client, "APPROVED");

      // `approve` is only legal from `pending`; from `approved` it is invalid.
      const outcome = await lifecycle.execute({
        admin,
        partnerId,
        command: "approve",
        reason: "should not apply",
        requestId: randomUUID(),
      });

      expect(outcome).toEqual({ ok: false, reason: "invalid_command" });
      const partner = await client.partner.findUniqueOrThrow({ where: { id: partnerId } });
      expect(partner.status).toBe("APPROVED");
      expect(await client.auditEvent.count({ where: { partnerId } })).toBe(0);
    });

    it("loses the compare-and-set race when the expected status is stale", async () => {
      const gateway = new PrismaPartnerLifecycleGateway(unitOfWork);
      const partnerId = await createPartner(client, "APPROVED");

      // The row is APPROVED, so a CAS keyed on the stale `pending` expectation
      // must affect zero rows and report a lost race — proving the gateway's
      // `where: { id, status }` predicate is enforced by real storage.
      const applied = await gateway.runForPartner(partnerId, (tx) =>
        tx.updateStatus({
          partnerId,
          expectedStatus: "pending",
          nextStatus: "suspended",
          reason: "stale",
          nowEpochMs: BASE_EPOCH_MS,
        }),
      );
      expect(applied).toBe(false);
      const partner = await client.partner.findUniqueOrThrow({ where: { id: partnerId } });
      expect(partner.status).toBe("APPROVED");
    });

    it("forbids a lifecycle command from an admin lacking the permission", async () => {
      const admin = await createAdmin(client, []);
      const partnerId = await createPartner(client, "PENDING");

      const outcome = await lifecycle.execute({
        admin,
        partnerId,
        command: "approve",
        reason: "no permission",
        requestId: randomUUID(),
      });

      expect(outcome).toEqual({ ok: false, reason: "forbidden" });
      const partner = await client.partner.findUniqueOrThrow({ where: { id: partnerId } });
      expect(partner.status).toBe("PENDING");
    });
  });

  // -------------------------------------------------------------------------
  // PlatformConfig: append-only publish (INSERT max(version)+1) + immutability
  // trigger. Never an UPDATE of an existing row (requirements 16.5, 8.5).
  // -------------------------------------------------------------------------
  describe("PlatformConfig publish is append-only and versions are immutable", () => {
    it("appends a new immutable version, keeps the old one, and audits the change", async () => {
      clock.set(BASE_EPOCH_MS);
      const admin = await createAdmin(client, [CONFIG_ADMIN_PERMISSION]);

      const active = await configService.loadActiveConfig();
      expect(active).not.toBeNull();
      if (active === null) throw new Error("unreachable");
      const previousVersion = active.version;
      // Snapshot the current highest row so we can prove it is never mutated.
      const beforeRow = await client.platformConfig.findFirstOrThrow({
        where: { version: previousVersion },
      });

      const requestId = randomUUID();
      const outcome = await configService.updateConfig({
        admin,
        edited: editedConfigFields({ fixedFeeIdr: 321, markupBps: 1_700 }),
        reason: "raise markup for Q3",
        requestId,
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("unreachable");
      expect(outcome.version).toBe(previousVersion + 1);

      // The new version is a brand-new row carrying the edited values, a fresh
      // active-slot key, and the FK-resolved createdByAdminId.
      const newRow = await client.platformConfig.findFirstOrThrow({
        where: { version: outcome.version },
      });
      expect(newRow.id).not.toBe(beforeRow.id);
      expect(newRow.fixedFeeIdr).toBe(321);
      expect(newRow.markupBps).toBe(1_700);
      expect(newRow.activeKey).toBe(`active-v${outcome.version}`);
      expect(newRow.createdByAdminId).toBe(admin.adminId);
      expect(newRow.activeFrom.getTime()).toBe(BASE_EPOCH_MS);

      // The previous version row is byte-for-byte unchanged (append-only).
      const afterRow = await client.platformConfig.findFirstOrThrow({
        where: { version: previousVersion },
      });
      expect(afterRow.markupBps).toBe(beforeRow.markupBps);
      expect(afterRow.fixedFeeIdr).toBe(beforeRow.fixedFeeIdr);
      expect(afterRow.activeKey).toBe(beforeRow.activeKey);

      // loadActive now resolves the highest version.
      const nowActive = await configService.loadActiveConfig();
      expect(nowActive?.version).toBe(outcome.version);
      expect(nowActive?.fixedFeeIdr).toBe(321);

      // The config.changed audit event committed in the same transaction.
      const audits = await client.auditEvent.findMany({
        where: { requestId, action: "config.changed" },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].partnerId).toBeNull();
    });

    it("rejects a direct UPDATE and DELETE via the platform_configs_immutable trigger", async () => {
      const row = await client.platformConfig.findFirstOrThrow({ orderBy: { version: "asc" } });

      // The trigger raises SQLSTATE 55000 on any UPDATE or DELETE of a version.
      await expect(
        client.$executeRawUnsafe(
          `UPDATE platform_configs SET "markupBps" = 9999 WHERE id = '${row.id}'`,
        ),
      ).rejects.toThrow(/immutable/i);
      await expect(
        client.$executeRawUnsafe(`DELETE FROM platform_configs WHERE id = '${row.id}'`),
      ).rejects.toThrow(/immutable/i);

      // The row survived both rejected mutations unchanged.
      const after = await client.platformConfig.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.markupBps).toBe(row.markupBps);
    });

    it("forbids a config publish from an admin lacking config:admin", async () => {
      const admin = await createAdmin(client, []);
      const before = await client.platformConfig.count();
      const outcome = await configService.updateConfig({
        admin,
        edited: editedConfigFields(),
        reason: "no permission",
        requestId: randomUUID(),
      });
      expect(outcome).toEqual({ ok: false, reason: "forbidden" });
      expect(await client.platformConfig.count()).toBe(before);
    });
  });

  // -------------------------------------------------------------------------
  // Admin resource explorer: redaction-safe reads + non-destructive disables.
  // -------------------------------------------------------------------------
  describe("Admin resource reads and disable commands", () => {
    it("lists partners with resource counts and loads a redaction-safe header", async () => {
      const partnerId = await createPartner(client, "APPROVED");
      const deviceId = await createOnlineDevice(client, partnerId);
      await createActiveOffer(client, partnerId);
      await createNumber(client, partnerId, deviceId, "AVAILABLE");
      await createNumber(client, partnerId, deviceId, "OFFLINE");

      const list = await resources.listPartners();
      const item = list.find((p) => p.partnerId === partnerId);
      expect(item).toBeDefined();
      expect(item?.status).toBe("approved");
      expect(item?.deviceCount).toBe(1);
      expect(item?.numberCount).toBe(2);

      const header = await resources.loadPartnerHeader(partnerId);
      expect(header?.partnerId).toBe(partnerId);
      expect(header?.status).toBe("approved");
    });

    it("disables a device (status-only, disabledAt stamped) with an audit event", async () => {
      clock.set(BASE_EPOCH_MS + 2 * HOUR_MS);
      const admin = await createAdmin(client, [RESOURCE_ADMIN_PERMISSION]);
      const partnerId = await createPartner(client, "APPROVED");
      const deviceId = await createOnlineDevice(client, partnerId);

      const outcome = await resources.disableDevice({
        admin,
        partnerId,
        resourceId: deviceId,
        reason: "compromised agent",
        requestId: randomUUID(),
      });
      expect(outcome).toEqual({ ok: true });

      const device = await client.partnerDevice.findUniqueOrThrow({ where: { id: deviceId } });
      // Satisfies partner_devices_disabled_check: disabled <=> disabledAt set.
      expect(device.effectiveStatus).toBe("DISABLED");
      expect(device.disabledAt?.getTime()).toBe(BASE_EPOCH_MS + 2 * HOUR_MS);
      expect(
        await client.auditEvent.count({ where: { partnerId, action: "device.changed" } }),
      ).toBe(1);
    });

    it("disables an idle number, nulls the active canonical, and appends history", async () => {
      clock.set(BASE_EPOCH_MS);
      const admin = await createAdmin(client, [RESOURCE_ADMIN_PERMISSION]);
      const partnerId = await createPartner(client, "APPROVED");
      const deviceId = await createOnlineDevice(client, partnerId);
      const { numberId } = await createNumber(client, partnerId, deviceId, "AVAILABLE");

      const outcome = await resources.disableNumber({
        admin,
        partnerId,
        resourceId: numberId,
        reason: "decommissioned SIM",
        requestId: randomUUID(),
      });
      expect(outcome).toEqual({ ok: true });

      const number = await client.partnerNumber.findUniqueOrThrow({ where: { id: numberId } });
      // Satisfies partner_numbers_active_canonical_check (ELSE branch): once not
      // enabled, activeCanonicalNumber must be null.
      expect(number.status).toBe("DISABLED");
      expect(number.enabled).toBe(false);
      expect(number.activeCanonicalNumber).toBeNull();

      const history = await client.numberStateHistory.findMany({ where: { numberId } });
      expect(history).toHaveLength(1);
      expect(history[0].fromStatus).toBe("AVAILABLE");
      expect(history[0].toStatus).toBe("DISABLED");
      expect(history[0].actorType).toBe("PARTNER_ADMIN");
      expect(
        await client.auditEvent.count({ where: { partnerId, action: "number.changed" } }),
      ).toBe(1);
    });

    it("state-guards disabling an in-flight (busy) number and mutates nothing", async () => {
      const admin = await createAdmin(client, [RESOURCE_ADMIN_PERMISSION]);
      const partnerId = await createPartner(client, "APPROVED");
      const deviceId = await createOnlineDevice(client, partnerId);
      const { numberId, canonicalNumber } = await createNumber(
        client,
        partnerId,
        deviceId,
        "BUSY",
      );

      const outcome = await resources.disableNumber({
        admin,
        partnerId,
        resourceId: numberId,
        reason: "cannot disable in flight",
        requestId: randomUUID(),
      });
      expect(outcome).toEqual({ ok: false, reason: "state_guarded", status: "busy" });

      // The busy number and its active canonical are untouched, no history/audit.
      const number = await client.partnerNumber.findUniqueOrThrow({ where: { id: numberId } });
      expect(number.status).toBe("BUSY");
      expect(number.activeCanonicalNumber).toBe(canonicalNumber);
      expect(await client.numberStateHistory.count({ where: { numberId } })).toBe(0);
      expect(await client.auditEvent.count({ where: { partnerId } })).toBe(0);
    });

    it("disables an offer, freeing its active-dimension slot, with an audit event", async () => {
      const admin = await createAdmin(client, [RESOURCE_ADMIN_PERMISSION]);
      const partnerId = await createPartner(client, "APPROVED");
      const offerId = await createActiveOffer(client, partnerId);

      const outcome = await resources.disableOffer({
        admin,
        partnerId,
        resourceId: offerId,
        reason: "pull supply",
        requestId: randomUUID(),
      });
      expect(outcome).toEqual({ ok: true });

      const offer = await client.partnerOffer.findUniqueOrThrow({ where: { id: offerId } });
      // Satisfies partner_offers_active_dimension_check (ELSE branch).
      expect(offer.status).toBe("DISABLED");
      expect(offer.activeDimensionKey).toBeNull();
      expect(
        await client.auditEvent.count({ where: { partnerId, action: "offer.changed" } }),
      ).toBe(1);
    });

    it("returns not_found for a foreign-partner resource id", async () => {
      const admin = await createAdmin(client, [RESOURCE_ADMIN_PERMISSION]);
      const partnerA = await createPartner(client, "APPROVED");
      const partnerB = await createPartner(client, "APPROVED");
      const deviceB = await createOnlineDevice(client, partnerB);

      // The device belongs to partner B; scoping it under partner A is a miss.
      const outcome = await resources.disableDevice({
        admin,
        partnerId: partnerA,
        resourceId: deviceB,
        reason: "wrong tenant",
        requestId: randomUUID(),
      });
      expect(outcome).toEqual({ ok: false, reason: "not_found" });
      const device = await client.partnerDevice.findUniqueOrThrow({ where: { id: deviceB } });
      expect(device.effectiveStatus).toBe("ONLINE");
    });

    it("lists a partner's SMS as redaction-safe metadata only", async () => {
      const partnerId = await createPartner(client, "APPROVED");
      const deviceId = await createOnlineDevice(client, partnerId);
      const { numberId, canonicalNumber } = await createNumber(
        client,
        partnerId,
        deviceId,
        "AVAILABLE",
      );
      const body = "WhatsApp code 424242 do not share";
      const sender = "WhatsAppBusiness";
      const smsId = randomUUID();
      const senderEnc = cipher.encrypt(sender);
      const bodyEnc = cipher.encrypt(body);
      await client.partnerSms.create({
        data: {
          id: smsId,
          deviceId,
          numberId,
          messageId: randomUUID(),
          idempotencyKey: randomUUID(),
          senderCiphertext: Buffer.from(senderEnc.ciphertext),
          bodyCiphertext: Buffer.from(bodyEnc.ciphertext),
          keyVersion: cipher.keyVersion,
          bodyFingerprint: cipher.fingerprint(body),
          receivedAtDevice: new Date(BASE_EPOCH_MS - 2_000),
          receivedAtServer: new Date(BASE_EPOCH_MS),
          matchStatus: "UNMATCHED",
        },
      });

      const rows = await resources.listRedactedSms(partnerId);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.id).toBe(smsId);
      expect(row.canonicalNumber).toBe(canonicalNumber);
      expect(row.matchStatus).toBe("unmatched");
      expect(row.bodyFingerprint).toBe(cipher.fingerprint(body));
      // No ciphertext / plaintext / OTP ever leaves the redaction-safe projection.
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain("424242");
      expect(serialized).not.toContain("WhatsApp");
      expect(serialized).not.toContain("Ciphertext");
    });
  });

  // -------------------------------------------------------------------------
  // Audit browser: bounded, filtered, newest-first paging over real rows.
  // -------------------------------------------------------------------------
  describe("Audit browser pages newest-first with filters", () => {
    it("pages a partner's audit events newest-first with an accurate total", async () => {
      const partnerId = await createPartner(client, "APPROVED");
      const auditRepo = new PrismaAuditEventRepository(client);
      // Three events for this partner, oldest → newest.
      const times = [BASE_EPOCH_MS, BASE_EPOCH_MS + 1_000, BASE_EPOCH_MS + 2_000];
      for (const occurredAtEpochMs of times) {
        await auditRepo.record({
          id: randomUUID(),
          partnerId,
          requestId: randomUUID(),
          descriptor: createAuditEvent({
            actorType: "partner_admin",
            actorRef: `admin-${randomUUID()}`,
            action: "partner.status_changed",
            targetType: "partner",
            targetId: partnerId,
            result: "success",
            occurredAtEpochMs,
            metadata: { note: "browse test" },
          }),
        });
      }

      const page1 = await auditBrowser.listAuditEvents({ partnerId, page: 1, pageSize: 2 });
      expect(page1.total).toBe(3);
      expect(page1.hasNext).toBe(true);
      expect(page1.items).toHaveLength(2);
      // Newest first.
      expect(page1.items[0].occurredAtEpochMs).toBe(BASE_EPOCH_MS + 2_000);
      expect(page1.items[1].occurredAtEpochMs).toBe(BASE_EPOCH_MS + 1_000);
      // Redaction-safe: actor is a 64-char hash, metadata is the safe object.
      expect(page1.items[0].actorRefHash).toHaveLength(64);
      expect(page1.items[0].safeMetadata).toEqual({ note: "browse test" });

      const page2 = await auditBrowser.listAuditEvents({ partnerId, page: 2, pageSize: 2 });
      expect(page2.items).toHaveLength(1);
      expect(page2.hasNext).toBe(false);
      expect(page2.items[0].occurredAtEpochMs).toBe(BASE_EPOCH_MS);
    });

    it("filters by action and ignores an unknown action filter", async () => {
      const partnerId = await createPartner(client, "APPROVED");
      const auditRepo = new PrismaAuditEventRepository(client);
      await auditRepo.record({
        id: randomUUID(),
        partnerId,
        requestId: randomUUID(),
        descriptor: createAuditEvent({
          actorType: "partner_admin",
          actorRef: `admin-${randomUUID()}`,
          action: "config.changed",
          targetType: "platform_config",
          targetId: "wa/ID/any",
          result: "success",
          occurredAtEpochMs: BASE_EPOCH_MS,
        }),
      });

      // A known action filter narrows to exactly the matching rows.
      const filtered = await auditBrowser.listAuditEvents({
        partnerId,
        action: "config.changed",
      });
      expect(filtered.total).toBe(1);
      expect(filtered.items[0].action).toBe("config.changed");

      // An action that filters nothing this partner did returns an empty page.
      const none = await auditBrowser.listAuditEvents({
        partnerId,
        action: "number.changed",
      });
      expect(none.total).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Gated raw SMS/OTP reveal: decrypt round-trip + redacted/no-reauth refusals.
  // -------------------------------------------------------------------------
  describe("Raw SMS reveal is gated, decrypts, and audits", () => {
    async function seedMatchedSmsWithOtp(): Promise<{
      smsId: string;
      partnerId: string;
      canonicalNumber: string;
      sender: string;
      body: string;
      otp: string;
    }> {
      const partnerId = await createPartner(client, "APPROVED");
      const deviceId = await createOnlineDevice(client, partnerId);
      const offerId = await createActiveOffer(client, partnerId);
      const { numberId, canonicalNumber } = await createNumber(
        client,
        partnerId,
        deviceId,
        "BUSY",
      );
      const otp = "246810";
      const sender = "WhatsAppBusiness";
      const body = `Your WhatsApp code is ${otp}`;
      const orderId = randomUUID();
      const otpEnc = cipher.encrypt(otp);
      await client.partnerOrder.create({
        data: {
          id: orderId,
          buyerOrderRef: `buyer-${orderId}`,
          buyerAccountRef: `acct-${randomUUID()}`,
          partnerId,
          numberId,
          offerId,
          status: "SUCCESS",
          otpCiphertext: Buffer.from(otpEnc.ciphertext),
          otpKeyVersion: otpEnc.keyVersion,
          otpFingerprint: cipher.fingerprint(otp),
          expiresAt: new Date(BASE_EPOCH_MS + HOUR_MS),
          succeededAt: new Date(BASE_EPOCH_MS),
          terminalAt: new Date(BASE_EPOCH_MS),
        },
      });
      const smsId = randomUUID();
      const senderEnc = cipher.encrypt(sender);
      const bodyEnc = cipher.encrypt(body);
      await client.partnerSms.create({
        data: {
          id: smsId,
          deviceId,
          numberId,
          messageId: randomUUID(),
          idempotencyKey: randomUUID(),
          senderCiphertext: Buffer.from(senderEnc.ciphertext),
          bodyCiphertext: Buffer.from(bodyEnc.ciphertext),
          keyVersion: cipher.keyVersion,
          bodyFingerprint: cipher.fingerprint(body),
          receivedAtDevice: new Date(BASE_EPOCH_MS - 2_000),
          receivedAtServer: new Date(BASE_EPOCH_MS),
          matchStatus: "MATCHED",
          matchedOrderId: orderId,
          extractedAt: new Date(BASE_EPOCH_MS),
        },
      });
      return { smsId, partnerId, canonicalNumber, sender, body, otp };
    }

    it("reveals decrypted sender/body/OTP once and writes the sms.raw_accessed audit", async () => {
      clock.set(BASE_EPOCH_MS);
      const admin = await createAdmin(client, [RAW_SMS_PERMISSION]);
      // A fresh step-up re-auth so the 15-minute window is satisfied.
      reauthRegistry.record(admin.adminId, BASE_EPOCH_MS);
      const seeded = await seedMatchedSmsWithOtp();
      const requestId = randomUUID();

      const outcome = await rawSms.reveal({
        admin,
        smsId: seeded.smsId,
        reason: "fraud investigation ticket #42",
        requestId,
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("unreachable");
      const revealed = outcome.revealed;
      expect(revealed.smsId).toBe(seeded.smsId);
      expect(revealed.canonicalNumber).toBe(seeded.canonicalNumber);
      expect(revealed.matchStatus).toBe("matched");
      // The ciphertext round-trips back to the seeded plaintext through the cipher.
      expect(revealed.sender).toBe(seeded.sender);
      expect(revealed.body).toBe(seeded.body);
      expect(revealed.otp).toBe(seeded.otp);

      // The mandatory audit event was written and carries no decrypted content.
      const audits = await client.auditEvent.findMany({
        where: { requestId, partnerId: seeded.partnerId },
      });
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits[0].safeMetadataJson)).not.toContain(seeded.otp);
    });

    it("refuses a reveal without a fresh step-up re-authentication", async () => {
      clock.set(BASE_EPOCH_MS);
      const admin = await createAdmin(client, [RAW_SMS_PERMISSION]);
      const seeded = await seedMatchedSmsWithOtp();

      // No reauth recorded for this admin → the gate refuses before decrypting.
      const outcome = await rawSms.reveal({
        admin,
        smsId: seeded.smsId,
        reason: "no reauth on record",
        requestId: randomUUID(),
      });
      expect(outcome).toEqual({ ok: false, reason: "reauth_required" });
      expect(
        await client.auditEvent.count({ where: { partnerId: seeded.partnerId } }),
      ).toBe(0);
    });

    it("refuses to reveal a retention-redacted SMS", async () => {
      clock.set(BASE_EPOCH_MS);
      const admin = await createAdmin(client, [RAW_SMS_PERMISSION]);
      reauthRegistry.record(admin.adminId, BASE_EPOCH_MS);
      const partnerId = await createPartner(client, "APPROVED");
      const deviceId = await createOnlineDevice(client, partnerId);
      const { numberId } = await createNumber(client, partnerId, deviceId, "AVAILABLE");
      const smsId = randomUUID();
      // A redacted SMS: ciphertext scrubbed to empty, redactedAt stamped.
      await client.partnerSms.create({
        data: {
          id: smsId,
          deviceId,
          numberId,
          messageId: randomUUID(),
          idempotencyKey: randomUUID(),
          senderCiphertext: Buffer.alloc(0),
          bodyCiphertext: Buffer.alloc(0),
          keyVersion: cipher.keyVersion,
          bodyFingerprint: cipher.fingerprint("redacted"),
          receivedAtDevice: new Date(BASE_EPOCH_MS - 2_000),
          receivedAtServer: new Date(BASE_EPOCH_MS),
          matchStatus: "UNMATCHED",
          redactedAt: new Date(BASE_EPOCH_MS + HOUR_MS),
        },
      });

      const outcome = await rawSms.reveal({
        admin,
        smsId,
        reason: "already redacted",
        requestId: randomUUID(),
      });
      expect(outcome).toEqual({ ok: false, reason: "redacted" });
    });
  });
});
