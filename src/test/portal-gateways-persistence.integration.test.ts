import { execFile } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { toSessionContext } from "@application/authorization/session-context";
import { DeviceManagementService } from "@application/devices/device-management-service";
import { MemberManagementService } from "@application/members/member-management-service";
import { NumberManagementService } from "@application/numbers/number-management-service";
import { OfferManagementService } from "@application/offers/offer-management-service";
import { DashboardQueryService } from "@application/portal/dashboard-query-service";
import { OperationalQueryService } from "@application/portal/operational-query-service";

import type { AuthenticatedPrincipal } from "@domain/task-7-2";

import {
  ConcurrencyConflictError,
  createPartnerDatabaseClient,
  createTenantContext,
  PrismaDashboardQueryGateway,
  PrismaDeviceManagementGateway,
  PrismaLedgerRepository,
  PrismaMemberManagementGateway,
  PrismaNumberManagementGateway,
  PrismaOfferManagementGateway,
  PrismaOperationalQueryGateway,
  PrismaUnitOfWork,
  type PartnerDatabaseClient,
  type TenantContext,
} from "@infrastructure/database";
import { Argon2idPasswordHasher } from "@infrastructure/auth/argon2-password-hasher";
import { CryptoDeviceCredentialFactory } from "@infrastructure/auth/crypto-device-credential";
import { CryptoIdGenerator } from "@infrastructure/auth/system-clock";

import {
  createDisposableTestDatabase,
  type DisposableTestDatabase,
} from "./disposable-database";

/**
 * Portal gateways persistence integration tests.
 *
 * These wire the *production* portal write gateways
 * ({@link PrismaNumberManagementGateway}, {@link PrismaOfferManagementGateway},
 * {@link PrismaMemberManagementGateway}, {@link PrismaDeviceManagementGateway})
 * behind their real task-8.x application services, plus the real read gateways
 * ({@link PrismaDashboardQueryGateway}, {@link PrismaOperationalQueryGateway}),
 * against a disposable PostgreSQL database — no in-memory fakes. Every command
 * is driven through the real {@link PrismaUnitOfWork} `$transaction` and the real
 * audit repository, then the committed rows/columns/effects are asserted by
 * reading them back through the raw client.
 *
 * The point is to catch runtime bugs that only appear against real Prisma +
 * Postgres and never against the pure/fake unit suites, e.g.:
 *  - the `partner_numbers_active_canonical_check` polymorphic CASE CHECK
 *    (activeCanonicalNumber must equal canonicalNumber while non-disabled, and
 *    be NULL otherwise) rejecting an inconsistent write;
 *  - the `partner_offers_active_dimension_check` slot CHECK + the global unique
 *    `activeDimensionKey`/`activeCanonicalNumber` slots;
 *  - the compare-and-set (P1) status update that must never overwrite a
 *    reserved/busy number;
 *  - the composite `[deviceId, partnerId]` / `[offerId, partnerId]` foreign keys
 *    and the `ON DELETE RESTRICT` behaviour surfaced as `offer_in_use`;
 *  - tenant-scoped aggregate reads returning the right per-tenant counts.
 */
const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const adminUrl = process.env.PARTNER_TEST_DATABASE_ADMIN_URL ?? "";
const hasPostgres = adminUrl.length > 0;

/** Deterministic anchor well after the seeded config's `activeFrom`. */
const BASE_EPOCH_MS = Date.UTC(2026, 7, 1, 12, 0, 0);
const HOUR_MS = 60 * 60 * 1000;

/** A test-controllable clock satisfying the application `Clock` port. */
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
}

async function deployFromEmpty(connectionString: string): Promise<void> {
  await execFileAsync(process.execPath, ["scripts/migrate-from-empty.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, PARTNER_MIGRATION_DATABASE_URL: connectionString },
    maxBuffer: 10 * 1024 * 1024,
  });
}

/** The immutable MVP platform config (mirrors prisma/seed.sql + task-8-5). */
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

/** The production portal services, all wired on the same real unit of work. */
interface PortalServices {
  readonly numbers: NumberManagementService;
  readonly offers: OfferManagementService;
  readonly members: MemberManagementService;
  readonly devices: DeviceManagementService;
  readonly dashboard: DashboardQueryService;
  readonly operational: OperationalQueryService;
}

function wireServices(client: PartnerDatabaseClient, clock: MutableClock): PortalServices {
  const unitOfWork = new PrismaUnitOfWork(client);
  const idGenerator = new CryptoIdGenerator();
  return {
    numbers: new NumberManagementService({
      gateway: new PrismaNumberManagementGateway(unitOfWork),
      clock,
      idGenerator,
    }),
    offers: new OfferManagementService({
      gateway: new PrismaOfferManagementGateway(unitOfWork),
      clock,
      idGenerator,
    }),
    members: new MemberManagementService({
      gateway: new PrismaMemberManagementGateway(unitOfWork),
      passwordHasher: new Argon2idPasswordHasher(),
      secretGenerator: { generate: () => randomBytes(32).toString("base64url") },
      clock,
      idGenerator,
    }),
    devices: new DeviceManagementService({
      gateway: new PrismaDeviceManagementGateway(unitOfWork),
      credentialFactory: new CryptoDeviceCredentialFactory("integration-test-pepper"),
      clock,
      idGenerator,
      // Non-production so simulator creation is always allowed by the policy.
      environment: "test",
    }),
    dashboard: new DashboardQueryService({
      gateway: new PrismaDashboardQueryGateway(client),
      balances: new PrismaLedgerRepository(client),
    }),
    operational: new OperationalQueryService({
      gateway: new PrismaOperationalQueryGateway(client),
    }),
  };
}

// ---------------------------------------------------------------------------
// Fixture builders (raw client), created in FK dependency order.
// ---------------------------------------------------------------------------

interface SeededPartner {
  readonly partnerId: string;
  readonly ownerMemberId: string;
  readonly tenant: TenantContext;
  readonly caller: ReturnType<typeof toSessionContext>;
}

/** An approved partner (simulator-allowlisted) with an active OWNER member. */
async function createApprovedPartner(client: PartnerDatabaseClient): Promise<SeededPartner> {
  const partnerId = randomUUID();
  await client.partner.create({
    data: {
      id: partnerId,
      legalName: "Portal Integration Legal",
      displayName: "Portal Integration Partner",
      status: "APPROVED",
      simulatorAllowed: true,
    },
  });
  const ownerMemberId = randomUUID();
  await client.partnerMember.create({
    data: {
      id: ownerMemberId,
      partnerId,
      emailNormalized: `owner-${ownerMemberId}@example.test`,
      passwordHash: "x".repeat(60),
      role: "OWNER",
      status: "ACTIVE",
    },
  });
  const tenant = createTenantContext(partnerId);
  const principal: AuthenticatedPrincipal = {
    memberId: ownerMemberId,
    partnerId,
    role: "owner",
    securityVersion: 1,
  };
  return { partnerId, ownerMemberId, tenant, caller: toSessionContext(principal) };
}

/** A fresh, unique canonical Indonesian E.164 number ("+628..."), <= 20 chars. */
function uniqueCanonicalNumber(): string {
  // Canonical rule: `+628` then a NON-ZERO digit, then 8 more. Drawing the
  // first digit from 0-9 produced `+6280…` roughly one run in ten, which the
  // domain rightly rejects — a self-inflicted flake, not a product bug.
  let digits = String(randomInt(1, 10));
  for (let i = 0; i < 8; i += 1) digits += String(randomInt(0, 10));
  return `+628${digits}`;
}

type DeviceStatus = "ONLINE" | "OFFLINE" | "DISABLED";

async function createDevice(
  client: PartnerDatabaseClient,
  partnerId: string,
  options: { status?: DeviceStatus; label?: string; smsCapable?: boolean; slots?: number } = {},
): Promise<string> {
  const id = randomUUID();
  await client.partnerDevice.create({
    data: {
      id,
      partnerId,
      type: "SIMULATOR",
      label: options.label ?? "Sim",
      effectiveStatus: options.status ?? "ONLINE",
      lastSeenAt: new Date(BASE_EPOCH_MS),
      capabilitiesJson: {
        sms: options.smsCapable ?? true,
        notification: false,
        resend: false,
        operator: null,
        slots: options.slots ?? 1,
      },
    },
  });
  return id;
}

type NumberStatusDb = "OFFLINE" | "AVAILABLE" | "RESERVED" | "BUSY" | "DISABLED";

async function createNumber(
  client: PartnerDatabaseClient,
  partnerId: string,
  deviceId: string,
  options: { status?: NumberStatusDb; enabled?: boolean; canonical?: string } = {},
): Promise<{ numberId: string; canonicalNumber: string }> {
  const numberId = randomUUID();
  const canonicalNumber = options.canonical ?? uniqueCanonicalNumber();
  const status = options.status ?? "AVAILABLE";
  const enabled = options.enabled ?? true;
  const active = enabled && status !== "DISABLED";
  await client.partnerNumber.create({
    data: {
      id: numberId,
      partnerId,
      deviceId,
      canonicalNumber,
      activeCanonicalNumber: active ? canonicalNumber : null,
      countryCode: "ID",
      operatorCode: "any",
      status,
      enabled,
    },
  });
  return { numberId, canonicalNumber };
}

async function createOffer(
  client: PartnerDatabaseClient,
  partnerId: string,
  options: { status?: "ACTIVE" | "INACTIVE"; basePriceIdr?: number } = {},
): Promise<string> {
  const id = randomUUID();
  const status = options.status ?? "ACTIVE";
  await client.partnerOffer.create({
    data: {
      id,
      partnerId,
      serviceCode: "wa",
      countryCode: "ID",
      operatorCode: "any",
      basePriceIdr: options.basePriceIdr ?? 1_000,
      status,
      configVersion: 1,
      activeDimensionKey: status === "ACTIVE" ? `${partnerId}:wa:ID:any` : null,
    },
  });
  return id;
}

type OrderStatusDb =
  | "CREATED"
  | "RESERVED"
  | "WAITING_SMS"
  | "SUCCESS"
  | "CANCELLED"
  | "TIMEOUT"
  | "FAILED";

async function createOrder(
  client: PartnerDatabaseClient,
  args: {
    partnerId: string;
    numberId: string;
    offerId: string;
    status: OrderStatusDb;
    bindNumber?: boolean;
    withSnapshot?: boolean;
    canonicalNumber?: string;
  },
): Promise<string> {
  const orderId = randomUUID();
  await client.partnerOrder.create({
    data: {
      id: orderId,
      buyerOrderRef: `buyer-${orderId}`,
      buyerAccountRef: `acct-${randomUUID()}`,
      partnerId: args.partnerId,
      numberId: args.numberId,
      offerId: args.offerId,
      status: args.status,
      createdAt: new Date(BASE_EPOCH_MS),
      expiresAt: new Date(BASE_EPOCH_MS + HOUR_MS),
      version: 1,
    },
  });
  if (args.withSnapshot) {
    await client.orderSnapshot.create({
      data: {
        orderId,
        serviceCode: "wa",
        countryCode: "ID",
        operatorCode: "any",
        canonicalNumber: args.canonicalNumber ?? uniqueCanonicalNumber(),
        basePriceIdr: 1_000,
        retailPriceIdr: 1_400,
        payoutIdr: 1_000,
        platformMarginIdr: 400,
        currency: "IDR",
        configVersion: 1,
      },
    });
  }
  if (args.bindNumber) {
    await client.partnerNumber.update({
      where: { id: args.numberId },
      data: { currentOrderId: orderId },
    });
  }
  return orderId;
}

/**
 * Seed a financially-consistent payout backed by a real Earning + whole-earning
 * allocation, satisfying the deferred `partner_payouts_financial_consistency`
 * and `partner_earnings_match_snapshot` constraint triggers. The payout + its
 * allocation are committed in a single transaction (the triggers fire at commit
 * and must see the balanced totals together). When `paid` is set the payout is
 * then transitioned to PAID with the evidence the `partner_payouts_paid_check`
 * demands. Returns the payout id.
 */
async function seedValidPayout(
  client: PartnerDatabaseClient,
  args: {
    partnerId: string;
    deviceId: string;
    offerId: string;
    destinationId: string;
    memberId: string;
    adminId: string;
    amount: number;
    paid: boolean;
  },
): Promise<string> {
  const { numberId, canonicalNumber } = await createNumber(client, args.partnerId, args.deviceId, {
    status: "AVAILABLE",
  });
  const orderId = await createOrder(client, {
    partnerId: args.partnerId,
    numberId,
    offerId: args.offerId,
    status: "SUCCESS",
  });
  // The snapshot payout must equal the Earning amount (partner_earnings_match_
  // snapshot) and satisfy the snapshot financial CHECK (payout = base, retail =
  // payout + margin), so it is built from `amount` rather than the fixed helper.
  await client.orderSnapshot.create({
    data: {
      orderId,
      serviceCode: "wa",
      countryCode: "ID",
      operatorCode: "any",
      canonicalNumber,
      basePriceIdr: args.amount,
      retailPriceIdr: args.amount + 400,
      payoutIdr: args.amount,
      platformMarginIdr: 400,
      currency: "IDR",
      configVersion: 1,
    },
  });
  const earningId = randomUUID();
  await client.partnerEarning.create({
    data: {
      id: earningId,
      partnerId: args.partnerId,
      orderId,
      amountIdr: args.amount,
      status: "AVAILABLE",
      availableAt: new Date(BASE_EPOCH_MS - HOUR_MS),
    },
  });
  const payoutId = randomUUID();
  await client.$transaction(async (tx) => {
    await tx.partnerPayout.create({
      data: {
        id: payoutId,
        partnerId: args.partnerId,
        destinationId: args.destinationId,
        destinationSnapshotJsonEncrypted: Buffer.from([9, 9]),
        amountIdr: args.amount,
        status: "REQUESTED",
        createdByMemberId: args.memberId,
      },
    });
    await tx.payoutAllocation.create({
      data: {
        id: randomUUID(),
        partnerId: args.partnerId,
        payoutId,
        earningId,
        amountIdr: args.amount,
      },
    });
  });
  if (args.paid) {
    // Allocations are immutable once past `requested`, so the transition to PAID
    // only stamps the payout evidence; the balanced allocation stays as-is.
    await client.partnerPayout.update({
      where: { id: payoutId },
      data: {
        status: "PAID",
        paidAt: new Date(BASE_EPOCH_MS),
        processedByAdminId: args.adminId,
        paymentReference: `ref-${randomUUID()}`,
      },
    });
  }
  return payoutId;
}

// ---------------------------------------------------------------------------
describe.runIf(hasPostgres)("Portal gateways persistence integration", () => {
  let database: DisposableTestDatabase;
  let client: PartnerDatabaseClient;
  let services: PortalServices;
  const clock = new MutableClock(BASE_EPOCH_MS);

  beforeAll(async () => {
    database = await createDisposableTestDatabase(adminUrl);
    await deployFromEmpty(database.connectionString);
    client = createPartnerDatabaseClient({ databaseUrl: database.connectionString });
    await client.$connect();
    await client.platformConfig.create({ data: platformConfigData(1, "mvp-active") });
    services = wireServices(client, clock);
  }, 120_000);

  afterAll(async () => {
    await client?.$disconnect();
    await database?.dispose();
  }, 30_000);

  // -------------------------------------------------------------------------
  // Number lifecycle (register / disable / re-enable / move) + the P1
  // compare-and-set guard, all asserted against the committed rows and the
  // polymorphic `partner_numbers_active_canonical_check` CHECK constraint.
  // -------------------------------------------------------------------------
  describe("Number management writes", () => {
    it("registers a number, persisting the row, its state history, and an audit event", async () => {
      clock.set(BASE_EPOCH_MS);
      const partner = await createApprovedPartner(client);
      const deviceId = await createDevice(client, partner.partnerId);
      const canonical = uniqueCanonicalNumber();

      const result = await services.numbers.registerNumber({
        caller: partner.caller,
        deviceId,
        rawNumber: canonical,
        requestId: randomUUID(),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      const numberId = result.number.id;

      // A fresh number starts offline + enabled and claims the active-canonical
      // slot: the CHECK requires activeCanonicalNumber === canonicalNumber here.
      const row = await client.partnerNumber.findUniqueOrThrow({ where: { id: numberId } });
      expect(row.status).toBe("OFFLINE");
      expect(row.enabled).toBe(true);
      expect(row.deviceId).toBe(deviceId);
      expect(row.canonicalNumber).toBe(canonical);
      expect(row.activeCanonicalNumber).toBe(canonical);
      expect(row.countryCode).toBe("ID");
      expect(row.operatorCode).toBe("any");

      const history = await client.numberStateHistory.findMany({ where: { numberId } });
      expect(history).toHaveLength(1);
      expect(history[0].fromStatus).toBeNull();
      expect(history[0].toStatus).toBe("OFFLINE");
      expect(history[0].reason).toBe("registered");

      const audits = await client.auditEvent.findMany({
        where: { partnerId: partner.partnerId, targetId: numberId, action: "number.changed" },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].result).toBe("SUCCEEDED");
    });

    it("rejects a cross-tenant duplicate active canonical and keeps a single active slot", async () => {
      clock.set(BASE_EPOCH_MS);
      const canonical = uniqueCanonicalNumber();
      const first = await createApprovedPartner(client);
      const firstDevice = await createDevice(client, first.partnerId);
      const second = await createApprovedPartner(client);
      const secondDevice = await createDevice(client, second.partnerId);

      const ok = await services.numbers.registerNumber({
        caller: first.caller,
        deviceId: firstDevice,
        rawNumber: canonical,
        requestId: randomUUID(),
      });
      expect(ok.ok).toBe(true);

      // A different tenant claiming the same active canonical hits the global
      // unique slot -> ActiveNumberConflictError -> duplicate_active_number.
      const conflict = await services.numbers.registerNumber({
        caller: second.caller,
        deviceId: secondDevice,
        rawNumber: canonical,
        requestId: randomUUID(),
      });
      expect(conflict.ok).toBe(false);
      if (conflict.ok) throw new Error("unreachable");
      expect(conflict.reason).toBe("duplicate_active_number");

      const activeHolders = await client.partnerNumber.findMany({
        where: { activeCanonicalNumber: canonical },
      });
      expect(activeHolders).toHaveLength(1);
      expect(activeHolders[0].partnerId).toBe(first.partnerId);
    });

    it("disables an idle available number, frees the canonical slot, and appends history", async () => {
      clock.set(BASE_EPOCH_MS);
      const partner = await createApprovedPartner(client);
      const deviceId = await createDevice(client, partner.partnerId);
      const { numberId, canonicalNumber } = await createNumber(client, partner.partnerId, deviceId, {
        status: "AVAILABLE",
      });

      const result = await services.numbers.disableNumber({
        caller: partner.caller,
        numberId,
        requestId: randomUUID(),
      });
      expect(result.ok).toBe(true);

      // enabled=false -> the CHECK's ELSE branch demands activeCanonicalNumber IS NULL.
      const row = await client.partnerNumber.findUniqueOrThrow({ where: { id: numberId } });
      expect(row.status).toBe("DISABLED");
      expect(row.enabled).toBe(false);
      expect(row.activeCanonicalNumber).toBeNull();
      // The base canonical is retained for re-enable.
      expect(row.canonicalNumber).toBe(canonicalNumber);

      const history = await client.numberStateHistory.findMany({
        where: { numberId, toStatus: "DISABLED" },
      });
      expect(history).toHaveLength(1);
      expect(history[0].fromStatus).toBe("AVAILABLE");

      // Freeing the slot lets another tenant claim the same canonical.
      const other = await createApprovedPartner(client);
      const otherDevice = await createDevice(client, other.partnerId);
      const reclaim = await services.numbers.registerNumber({
        caller: other.caller,
        deviceId: otherDevice,
        rawNumber: canonicalNumber,
        requestId: randomUUID(),
      });
      expect(reclaim.ok).toBe(true);
    });

    it("re-enables a disabled number back to offline and reclaims the canonical slot", async () => {
      clock.set(BASE_EPOCH_MS);
      const partner = await createApprovedPartner(client);
      const deviceId = await createDevice(client, partner.partnerId);
      const { numberId, canonicalNumber } = await createNumber(client, partner.partnerId, deviceId, {
        status: "DISABLED",
        enabled: false,
      });

      const result = await services.numbers.reEnableNumber({
        caller: partner.caller,
        numberId,
        requestId: randomUUID(),
      });
      expect(result.ok).toBe(true);

      const row = await client.partnerNumber.findUniqueOrThrow({ where: { id: numberId } });
      expect(row.status).toBe("OFFLINE");
      expect(row.enabled).toBe(true);
      // Non-disabled again -> the CHECK requires the slot to be reclaimed.
      expect(row.activeCanonicalNumber).toBe(canonicalNumber);
    });

    it("moves a number to another device without a status change or new state history", async () => {
      clock.set(BASE_EPOCH_MS);
      const partner = await createApprovedPartner(client);
      const fromDevice = await createDevice(client, partner.partnerId, { label: "From" });
      const toDevice = await createDevice(client, partner.partnerId, { label: "To" });
      const { numberId } = await createNumber(client, partner.partnerId, fromDevice, {
        status: "AVAILABLE",
      });

      const result = await services.numbers.moveNumberToDevice({
        caller: partner.caller,
        numberId,
        targetDeviceId: toDevice,
        requestId: randomUUID(),
      });
      expect(result.ok).toBe(true);

      // The composite [deviceId, partnerId] FK re-homes the number; status stays.
      const row = await client.partnerNumber.findUniqueOrThrow({ where: { id: numberId } });
      expect(row.deviceId).toBe(toDevice);
      expect(row.status).toBe("AVAILABLE");

      // A move is not a status transition, so no state-history row is written.
      const history = await client.numberStateHistory.findMany({ where: { numberId } });
      expect(history).toHaveLength(0);

      const audits = await client.auditEvent.findMany({
        where: { targetId: numberId, action: "number.changed" },
      });
      expect(audits).toHaveLength(1);
      const metadata = audits[0].safeMetadataJson as Record<string, unknown> | null;
      expect(metadata?.change).toBe("moved");
    });

    it("guards a busy number: disable is refused as state_guarded and the row is untouched", async () => {
      clock.set(BASE_EPOCH_MS);
      const partner = await createApprovedPartner(client);
      const deviceId = await createDevice(client, partner.partnerId);
      const offerId = await createOffer(client, partner.partnerId);
      const { numberId } = await createNumber(client, partner.partnerId, deviceId, {
        status: "BUSY",
      });
      await createOrder(client, {
        partnerId: partner.partnerId,
        numberId,
        offerId,
        status: "WAITING_SMS",
        bindNumber: true,
      });

      const result = await services.numbers.disableNumber({
        caller: partner.caller,
        numberId,
        requestId: randomUUID(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("state_guarded");

      const row = await client.partnerNumber.findUniqueOrThrow({ where: { id: numberId } });
      expect(row.status).toBe("BUSY");
      expect(row.enabled).toBe(true);
      expect(row.currentOrderId).not.toBeNull();
    });

    it("updateNumberStatus compare-and-set refuses to overwrite a reserved number (P1 fix)", async () => {
      clock.set(BASE_EPOCH_MS);
      const partner = await createApprovedPartner(client);
      const deviceId = await createDevice(client, partner.partnerId);
      const { numberId, canonicalNumber } = await createNumber(
        client,
        partner.partnerId,
        deviceId,
        { status: "RESERVED" },
      );

      // Drive the gateway transaction directly with a STALE expectedStatus
      // ("available") while the row is actually RESERVED. The CAS predicate pins
      // status = expectedStatus, so it matches zero rows and the adapter raises a
      // ConcurrencyConflictError instead of clobbering the live reservation.
      const gateway = new PrismaNumberManagementGateway(new PrismaUnitOfWork(client));
      await expect(
        gateway.runInTenant(partner.tenant, (tx) =>
          tx.updateNumberStatus(numberId, {
            expectedStatus: "available",
            status: "disabled",
            enabled: false,
            activeCanonicalNumber: null,
          }),
        ),
      ).rejects.toBeInstanceOf(ConcurrencyConflictError);

      // The reserved state — and its active-canonical slot — is preserved.
      const row = await client.partnerNumber.findUniqueOrThrow({ where: { id: numberId } });
      expect(row.status).toBe("RESERVED");
      expect(row.enabled).toBe(true);
      expect(row.activeCanonicalNumber).toBe(canonicalNumber);
    });
  });

  // -------------------------------------------------------------------------
  // Offer lifecycle (create / update price / deactivate / activate / delete),
  // asserting the active-dimension slot CHECK + the global unique slot + the
  // FK-restrict `offer_in_use` on delete.
  // -------------------------------------------------------------------------
  describe("Offer management writes", () => {
    it("creates an active offer with the computed active-dimension slot and an audit", async () => {
      clock.set(BASE_EPOCH_MS);
      const partner = await createApprovedPartner(client);

      const result = await services.offers.createOffer({
        caller: partner.caller,
        basePriceIdr: 1_000,
        requestId: randomUUID(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      const offerId = result.offer.id;

      const row = await client.partnerOffer.findUniqueOrThrow({ where: { id: offerId } });
      expect(row.status).toBe("ACTIVE");
      expect(row.basePriceIdr).toBe(1_000);
      // The CHECK requires this exact slot value while active.
      expect(row.activeDimensionKey).toBe(`${partner.partnerId}:wa:ID:any`);
      expect(row.configVersion).toBe(1);

      const audits = await client.auditEvent.findMany({
        where: { targetId: offerId, action: "offer.changed" },
      });
      expect(audits).toHaveLength(1);
    });

    it("rejects a second active offer on the same catalog dimension (duplicate_active_offer)", async () => {
      clock.set(BASE_EPOCH_MS);
      const partner = await createApprovedPartner(client);

      const first = await services.offers.createOffer({
        caller: partner.caller,
        basePriceIdr: 1_000,
        requestId: randomUUID(),
      });
      expect(first.ok).toBe(true);

      const second = await services.offers.createOffer({
        caller: partner.caller,
        basePriceIdr: 2_000,
        requestId: randomUUID(),
      });
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error("unreachable");
      expect(second.reason).toBe("duplicate_active_offer");

      const active = await client.partnerOffer.findMany({
        where: { partnerId: partner.partnerId, status: "ACTIVE" },
      });
      expect(active).toHaveLength(1);
    });

    it("updates an offer base price and re-snapshots the config version", async () => {
      clock.set(BASE_EPOCH_MS);
      const partner = await createApprovedPartner(client);
      const created = await services.offers.createOffer({
        caller: partner.caller,
        basePriceIdr: 1_000,
        requestId: randomUUID(),
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("unreachable");

      const updated = await services.offers.updateOfferBasePrice({
        caller: partner.caller,
        offerId: created.offer.id,
        basePriceIdr: 2_500,
        requestId: randomUUID(),
      });
      expect(updated.ok).toBe(true);

      const row = await client.partnerOffer.findUniqueOrThrow({ where: { id: created.offer.id } });
      expect(row.basePriceIdr).toBe(2_500);
      expect(row.configVersion).toBe(1);
      // Still active with an intact slot after the price change.
      expect(row.activeDimensionKey).toBe(`${partner.partnerId}:wa:ID:any`);
    });

    it("deactivates then reactivates an offer, toggling the active-dimension slot", async () => {
      clock.set(BASE_EPOCH_MS);
      const partner = await createApprovedPartner(client);
      const created = await services.offers.createOffer({
        caller: partner.caller,
        basePriceIdr: 1_000,
        requestId: randomUUID(),
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("unreachable");
      const offerId = created.offer.id;

      const deactivated = await services.offers.deactivateOffer({
        caller: partner.caller,
        offerId,
        requestId: randomUUID(),
      });
      expect(deactivated.ok).toBe(true);
      // status=inactive -> the CHECK's ELSE branch demands a NULL slot.
      const inactiveRow = await client.partnerOffer.findUniqueOrThrow({ where: { id: offerId } });
      expect(inactiveRow.status).toBe("INACTIVE");
      expect(inactiveRow.activeDimensionKey).toBeNull();

      const reactivated = await services.offers.activateOffer({
        caller: partner.caller,
        offerId,
        requestId: randomUUID(),
      });
      expect(reactivated.ok).toBe(true);
      const activeRow = await client.partnerOffer.findUniqueOrThrow({ where: { id: offerId } });
      expect(activeRow.status).toBe("ACTIVE");
      expect(activeRow.activeDimensionKey).toBe(`${partner.partnerId}:wa:ID:any`);
    });

    it("refuses to delete an offer referenced by an order, then deletes an unreferenced one", async () => {
      clock.set(BASE_EPOCH_MS);
      const partner = await createApprovedPartner(client);
      const deviceId = await createDevice(client, partner.partnerId);
      const { numberId } = await createNumber(client, partner.partnerId, deviceId, {
        status: "AVAILABLE",
      });

      const referenced = await services.offers.createOffer({
        caller: partner.caller,
        basePriceIdr: 1_000,
        requestId: randomUUID(),
      });
      expect(referenced.ok).toBe(true);
      if (!referenced.ok) throw new Error("unreachable");
      await createOrder(client, {
        partnerId: partner.partnerId,
        numberId,
        offerId: referenced.offer.id,
        status: "SUCCESS",
      });

      // The [offerId, partnerId] FK is ON DELETE RESTRICT -> P2003 -> offer_in_use.
      const blocked = await services.offers.deleteOffer({
        caller: partner.caller,
        offerId: referenced.offer.id,
        requestId: randomUUID(),
      });
      expect(blocked.ok).toBe(false);
      if (blocked.ok) throw new Error("unreachable");
      expect(blocked.reason).toBe("offer_in_use");
      expect(
        await client.partnerOffer.findUnique({ where: { id: referenced.offer.id } }),
      ).not.toBeNull();

      // An unreferenced offer deletes cleanly. (Deactivate first to free the
      // active-dimension slot so this second offer can even be created.)
      await services.offers.deactivateOffer({
        caller: partner.caller,
        offerId: referenced.offer.id,
        requestId: randomUUID(),
      });
      const disposable = await services.offers.createOffer({
        caller: partner.caller,
        basePriceIdr: 1_500,
        requestId: randomUUID(),
      });
      expect(disposable.ok).toBe(true);
      if (!disposable.ok) throw new Error("unreachable");
      const removed = await services.offers.deleteOffer({
        caller: partner.caller,
        offerId: disposable.offer.id,
        requestId: randomUUID(),
      });
      expect(removed.ok).toBe(true);
      expect(
        await client.partnerOffer.findUnique({ where: { id: disposable.offer.id } }),
      ).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Member lifecycle (invite / update / revoke) with the global email
  // uniqueness probe and the tenant-scoped update.
  // -------------------------------------------------------------------------
  describe("Member management writes", () => {
    it("invites a pending member with an audit and rejects a duplicate email", async () => {
      clock.set(BASE_EPOCH_MS);
      const partner = await createApprovedPartner(client);
      const email = `invitee-${randomUUID()}@example.test`;

      const invited = await services.members.invite({
        caller: partner.caller,
        email,
        role: "member",
        requestId: randomUUID(),
      });
      expect(invited.ok).toBe(true);
      if (!invited.ok) throw new Error("unreachable");

      const row = await client.partnerMember.findUniqueOrThrow({ where: { id: invited.member.id } });
      expect(row.partnerId).toBe(partner.partnerId);
      expect(row.role).toBe("MEMBER");
      expect(row.status).toBe("PENDING_VERIFICATION");
      expect(row.emailNormalized).toBe(email.toLowerCase());
      // An Argon2id hash of the placeholder secret was persisted, never blank.
      expect(row.passwordHash.startsWith("$argon2id$")).toBe(true);

      const audits = await client.auditEvent.findMany({
        where: { targetId: invited.member.id, action: "member.invited" },
      });
      expect(audits).toHaveLength(1);

      // The email is globally unique; a second invite (even to another tenant)
      // is rejected before a second row can be written.
      const other = await createApprovedPartner(client);
      const dup = await services.members.invite({
        caller: other.caller,
        email,
        role: "member",
        requestId: randomUUID(),
      });
      expect(dup.ok).toBe(false);
      if (dup.ok) throw new Error("unreachable");
      expect(dup.reason).toBe("email_taken");
      expect(await client.partnerMember.count({ where: { emailNormalized: email.toLowerCase() } })).toBe(
        1,
      );
    });

    it("updates a member's role/status and revokes (disables) a member", async () => {
      clock.set(BASE_EPOCH_MS);
      const partner = await createApprovedPartner(client);
      const invited = await services.members.invite({
        caller: partner.caller,
        email: `member-${randomUUID()}@example.test`,
        role: "member",
        requestId: randomUUID(),
      });
      expect(invited.ok).toBe(true);
      if (!invited.ok) throw new Error("unreachable");
      const memberId = invited.member.id;

      const updated = await services.members.update({
        caller: partner.caller,
        memberId,
        role: "owner",
        status: "active",
        requestId: randomUUID(),
      });
      expect(updated.ok).toBe(true);
      const afterUpdate = await client.partnerMember.findUniqueOrThrow({ where: { id: memberId } });
      expect(afterUpdate.role).toBe("OWNER");
      expect(afterUpdate.status).toBe("ACTIVE");

      const revoked = await services.members.revoke({
        caller: partner.caller,
        memberId,
        requestId: randomUUID(),
      });
      expect(revoked.ok).toBe(true);
      const afterRevoke = await client.partnerMember.findUniqueOrThrow({ where: { id: memberId } });
      expect(afterRevoke.status).toBe("DISABLED");

      const audits = await client.auditEvent.findMany({
        where: { targetId: memberId, action: { in: ["member.role_changed", "member.revoked"] } },
      });
      expect(audits).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Device lifecycle (create + first credential / disable / re-enable /
  // rotate / revoke) across the composite [deviceId, partnerId] credential FK.
  // -------------------------------------------------------------------------
  describe("Device management writes", () => {
    it("creates a simulator device with one active credential and two audit events", async () => {
      clock.set(BASE_EPOCH_MS);
      const partner = await createApprovedPartner(client);

      const result = await services.devices.createDevice({
        caller: partner.caller,
        type: "simulator",
        label: "Agent One",
        capabilities: { sms: true, notification: false, resend: false, operator: null, slots: 1 },
        requestId: randomUUID(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.credential).toBeDefined();
      const deviceId = result.device.id;

      const row = await client.partnerDevice.findUniqueOrThrow({ where: { id: deviceId } });
      expect(row.effectiveStatus).toBe("OFFLINE");
      expect(row.label).toBe("Agent One");
      expect(row.type).toBe("SIMULATOR");

      const credentials = await client.deviceCredential.findMany({ where: { deviceId } });
      expect(credentials).toHaveLength(1);
      expect(credentials[0].status).toBe("ACTIVE");
      expect(credentials[0].partnerId).toBe(partner.partnerId);
      // The one-time agent token embeds this credential's public id; the secret
      // itself is never stored (only its 64-char SHA-256 hash).
      expect(result.credential?.agentToken.startsWith(`${credentials[0].publicId}.`)).toBe(true);
      expect(credentials[0].secretHash).toHaveLength(64);

      const audits = await client.auditEvent.findMany({ where: { partnerId: partner.partnerId } });
      const actions = audits.map((a) => a.action);
      expect(actions).toContain("device.changed");
      expect(actions).toContain("credential.changed");
    });

    it("disables then re-enables a device, stamping and clearing disabledAt", async () => {
      clock.set(BASE_EPOCH_MS);
      const partner = await createApprovedPartner(client);
      const created = await services.devices.createDevice({
        caller: partner.caller,
        type: "simulator",
        label: "Agent Two",
        capabilities: { sms: true, notification: false, resend: false, operator: null, slots: 1 },
        requestId: randomUUID(),
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("unreachable");
      const deviceId = created.device.id;

      const disabled = await services.devices.disableDevice({
        caller: partner.caller,
        deviceId,
        requestId: randomUUID(),
      });
      expect(disabled.ok).toBe(true);
      const disabledRow = await client.partnerDevice.findUniqueOrThrow({ where: { id: deviceId } });
      expect(disabledRow.effectiveStatus).toBe("DISABLED");
      expect(disabledRow.disabledAt).not.toBeNull();
      expect(disabledRow.disabledAt?.getTime()).toBe(BASE_EPOCH_MS);

      const reenabled = await services.devices.reEnableDevice({
        caller: partner.caller,
        deviceId,
        requestId: randomUUID(),
      });
      expect(reenabled.ok).toBe(true);
      const reenabledRow = await client.partnerDevice.findUniqueOrThrow({ where: { id: deviceId } });
      expect(reenabledRow.effectiveStatus).toBe("OFFLINE");
      expect(reenabledRow.disabledAt).toBeNull();
    });

    it("rotates a credential (old revoked, new active) and later revokes all active credentials", async () => {
      clock.set(BASE_EPOCH_MS);
      const partner = await createApprovedPartner(client);
      const created = await services.devices.createDevice({
        caller: partner.caller,
        type: "simulator",
        label: "Agent Three",
        capabilities: { sms: true, notification: false, resend: false, operator: null, slots: 1 },
        requestId: randomUUID(),
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("unreachable");
      const deviceId = created.device.id;
      const firstCredentialId = created.credential?.credentialId;
      expect(firstCredentialId).toBeDefined();

      const rotated = await services.devices.rotateCredential({
        caller: partner.caller,
        deviceId,
        requestId: randomUUID(),
      });
      expect(rotated.ok).toBe(true);
      if (!rotated.ok) throw new Error("unreachable");

      // Exactly one active credential (the new one); the original is revoked.
      const afterRotate = await client.deviceCredential.findMany({ where: { deviceId } });
      expect(afterRotate).toHaveLength(2);
      const active = afterRotate.filter((c) => c.status === "ACTIVE");
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(rotated.credential?.credentialId);
      const original = afterRotate.find((c) => c.id === firstCredentialId);
      expect(original?.status).toBe("REVOKED");
      expect(original?.revokedAt).not.toBeNull();

      // Revoking again disables the remaining active credential.
      const revoked = await services.devices.revokeCredential({
        caller: partner.caller,
        deviceId,
        requestId: randomUUID(),
      });
      expect(revoked.ok).toBe(true);
      const remainingActive = await client.deviceCredential.count({
        where: { deviceId, status: "ACTIVE" },
      });
      expect(remainingActive).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Read models: the dashboard aggregate + the operational lists, proving the
  // per-tenant counts/joins are correct and never leak across tenants.
  // -------------------------------------------------------------------------
  describe("Dashboard and operational reads", () => {
    it("aggregates dashboard counts for the tenant only", async () => {
      clock.set(BASE_EPOCH_MS);
      const partner = await createApprovedPartner(client);

      // Devices: 2 online, 1 offline -> devicesOnline=2, devicesTotal=3.
      const onlineA = await createDevice(client, partner.partnerId, { status: "ONLINE" });
      await createDevice(client, partner.partnerId, { status: "ONLINE" });
      await createDevice(client, partner.partnerId, { status: "OFFLINE" });

      // Numbers: 2 available+enabled, 1 disabled (plus the success number below
      // and one AVAILABLE number per seeded payout -> 5 available in total).
      await createNumber(client, partner.partnerId, onlineA, { status: "AVAILABLE" });
      await createNumber(client, partner.partnerId, onlineA, { status: "AVAILABLE" });
      await createNumber(client, partner.partnerId, onlineA, {
        status: "DISABLED",
        enabled: false,
      });

      const offerId = await createOffer(client, partner.partnerId, { status: "ACTIVE" });
      const reservedNumber = await createNumber(client, partner.partnerId, onlineA, {
        status: "RESERVED",
      });
      const waitingNumber = await createNumber(client, partner.partnerId, onlineA, {
        status: "BUSY",
      });
      const successNumber = await createNumber(client, partner.partnerId, onlineA, {
        status: "AVAILABLE",
      });
      // Orders: 1 reserved + 1 waiting (active=2), 1 success here; each seeded
      // payout adds one more SUCCESS order -> total=5, success=3.
      await createOrder(client, {
        partnerId: partner.partnerId,
        numberId: reservedNumber.numberId,
        offerId,
        status: "RESERVED",
      });
      await createOrder(client, {
        partnerId: partner.partnerId,
        numberId: waitingNumber.numberId,
        offerId,
        status: "WAITING_SMS",
      });
      await createOrder(client, {
        partnerId: partner.partnerId,
        numberId: successNumber.numberId,
        offerId,
        status: "SUCCESS",
      });

      // Payouts: 1 requested (open), 1 paid — each backed by a real, balanced
      // Earning + allocation so the deferred financial-consistency triggers pass.
      const destinationId = randomUUID();
      await client.payoutDestination.create({
        data: {
          id: destinationId,
          partnerId: partner.partnerId,
          bankCode: "BCA",
          accountNumberCiphertext: Buffer.from([1, 2, 3, 4]),
          keyVersion: 1,
          accountNumberLast4: "1234",
          accountHolderName: "Holder",
        },
      });
      const adminId = randomUUID();
      await client.partnerAdmin.create({
        data: {
          id: adminId,
          emailNormalized: `admin-${adminId}@example.test`,
          passwordHash: "x".repeat(60),
        },
      });
      await seedValidPayout(client, {
        partnerId: partner.partnerId,
        deviceId: onlineA,
        offerId,
        destinationId,
        memberId: partner.ownerMemberId,
        adminId,
        amount: 1_000,
        paid: false,
      });
      await seedValidPayout(client, {
        partnerId: partner.partnerId,
        deviceId: onlineA,
        offerId,
        destinationId,
        memberId: partner.ownerMemberId,
        adminId,
        amount: 2_000,
        paid: true,
      });

      // A second, unrelated tenant whose rows must never bleed into the counts.
      const other = await createApprovedPartner(client);
      const otherDevice = await createDevice(client, other.partnerId, { status: "ONLINE" });
      await createNumber(client, other.partnerId, otherDevice, { status: "AVAILABLE" });

      const outcome = await services.dashboard.load(partner.tenant);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("unreachable");
      const view = outcome.view;
      expect(view.partner.status).toBe("approved");
      expect(view.devices).toEqual({ online: 2, total: 3 });
      expect(view.numbersAvailable).toBe(5);
      expect(view.orders).toEqual({ active: 2, total: 5, success: 3 });
      expect(view.payout.openCount).toBe(1);
      expect(view.payout.paidCount).toBe(1);
      // No ledger entries were seeded, so the money buckets are all zero.
      expect(view.earnings).toEqual({ pendingIdr: 0, availableIdr: 0 });
    });

    it("projects operational numbers/devices/offers/orders scoped to the tenant", async () => {
      clock.set(BASE_EPOCH_MS);
      const partner = await createApprovedPartner(client);
      const device = await createDevice(client, partner.partnerId, {
        status: "ONLINE",
        label: "Ops Device",
        slots: 2,
      });
      const offerId = await createOffer(client, partner.partnerId, {
        status: "ACTIVE",
        basePriceIdr: 1_000,
      });
      const boundNumber = await createNumber(client, partner.partnerId, device, {
        status: "BUSY",
      });
      const idleNumber = await createNumber(client, partner.partnerId, device, {
        status: "AVAILABLE",
      });
      const activeOrderId = await createOrder(client, {
        partnerId: partner.partnerId,
        numberId: boundNumber.numberId,
        offerId,
        status: "WAITING_SMS",
        bindNumber: true,
      });
      await createOrder(client, {
        partnerId: partner.partnerId,
        numberId: idleNumber.numberId,
        offerId,
        status: "SUCCESS",
        withSnapshot: true,
        canonicalNumber: idleNumber.canonicalNumber,
      });

      // A device credential so listDevices reports an active credential count.
      await client.deviceCredential.create({
        data: {
          id: randomUUID(),
          partnerId: partner.partnerId,
          deviceId: device,
          publicId: `pub-${randomUUID()}`,
          secretHash: "a".repeat(64),
          status: "ACTIVE",
        },
      });

      // A foreign tenant with its own supply that must never appear.
      const other = await createApprovedPartner(client);
      const otherDevice = await createDevice(client, other.partnerId);
      await createNumber(client, other.partnerId, otherDevice, { status: "AVAILABLE" });

      const { numbers, devices } = await services.operational.numbers(partner.tenant);
      expect(numbers).toHaveLength(2);
      const bound = numbers.find((n) => n.id === boundNumber.numberId);
      expect(bound?.deviceLabel).toBe("Ops Device");
      expect(bound?.status).toBe("busy");
      expect(bound?.hasActiveOrder).toBe(true);
      const idle = numbers.find((n) => n.id === idleNumber.numberId);
      expect(idle?.hasActiveOrder).toBe(false);
      expect(devices).toHaveLength(1);

      const deviceList = await services.operational.devices(partner.tenant);
      expect(deviceList).toHaveLength(1);
      expect(deviceList[0].numberCount).toBe(2);
      expect(deviceList[0].activeCredentialCount).toBe(1);
      expect(deviceList[0].slots).toBe(2);
      expect(deviceList[0].smsCapable).toBe(true);

      const { offers, config } = await services.operational.offers(partner.tenant);
      expect(offers).toHaveLength(1);
      expect(offers[0].status).toBe("active");
      // Retail is recomputed authoritatively from the active config, not stored.
      expect(offers[0].retailPriceIdr).not.toBeNull();
      expect(offers[0].payoutIdr).toBe(1_000);
      expect(config?.version).toBe(1);

      const active = await services.operational.activeOrders(partner.tenant);
      expect(active.map((o) => o.id)).toEqual([activeOrderId]);
      const history = await services.operational.orderHistory(partner.tenant);
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe("success");
      // The success order's snapshot pricing is projected through.
      expect(history[0].payoutIdr).toBe(1_000);
      expect(history[0].retailPriceIdr).toBe(1_400);

      const members = await services.operational.members(partner.tenant);
      // Only the seeded OWNER of this tenant.
      expect(members).toHaveLength(1);
      expect(members[0].role).toBe("owner");
    });
  });
});
