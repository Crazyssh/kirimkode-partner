import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedPrincipal } from "@domain/task-7-2";
import { AGENT_API_HEADERS } from "@domain/task-11-1/agent-api-auth";

import { DeviceManagementService } from "@application/devices/device-management-service";
import { RecordHeartbeatService } from "@application/heartbeat/record-heartbeat-service";
import { NumberManagementService } from "@application/numbers/number-management-service";
import { OfferManagementService } from "@application/offers/offer-management-service";
import { InventoryQueryService } from "@application/offers/inventory-query-service";
import {
  AgentApiAuthenticator,
  type AgentApiAuthRequest,
  type AgentEndpoint,
} from "@application/agent-api/agent-api-authenticator";
import { toSessionContext, type SessionContext } from "@application/authorization/session-context";

import {
  createPartnerDatabaseClient,
  PrismaAgentDeviceCredentialGateway,
  PrismaDeviceManagementGateway,
  PrismaHeartbeatGateway,
  PrismaInventoryQueryGateway,
  PrismaNumberManagementGateway,
  PrismaOfferManagementGateway,
  PrismaReplayNonceGateway,
  PrismaUnitOfWork,
  type PartnerDatabaseClient,
} from "@infrastructure/database";
import { CryptoDeviceCredentialFactory } from "@infrastructure/auth/crypto-device-credential";
import { InMemoryRateLimitStore } from "@infrastructure/auth/in-memory-rate-limit-store";

import {
  createDisposableTestDatabase,
  type DisposableTestDatabase,
} from "./disposable-database";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const adminUrl = process.env.PARTNER_TEST_DATABASE_ADMIN_URL ?? "";
const hasPostgres = adminUrl.length > 0;

/** A process-wide credential pepper for the crypto agent-secret derivation. */
const CREDENTIAL_PEPPER = "test-device-credential-pepper-8-5-integration";
/** Deterministic anchor well after the seeded config's `activeFrom`. */
const BASE_EPOCH_MS = Date.UTC(2026, 7, 1, 12, 0, 0);
/** The single MVP catalog the seeded config serves. */
const MVP_FILTER = { serviceCode: "wa", countryCode: "ID", operatorCode: "any" } as const;

const VALID_CAPABILITIES = {
  sms: true,
  notification: false,
  resend: false,
  operator: null,
  slots: 1,
} as const;

/** A test-controllable clock satisfying the application `Clock` port. */
class MutableClock {
  private current: number;

  constructor(startEpochMs: number) {
    this.current = startEpochMs;
  }

  nowEpochMs(): number {
    return this.current;
  }

  nowDate(): Date {
    return new Date(this.current);
  }

  set(epochMs: number): void {
    this.current = epochMs;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/** UUID id generator port. */
const idGenerator = { uuid: () => randomUUID() };

/** A monotonically-unique 32-hex-char nonce for Agent API replay headers. */
let nonceCounter = 0;
function nextNonce(): string {
  nonceCounter += 1;
  return nonceCounter.toString(16).padStart(32, "0");
}

/**
 * A freshly wired set of inventory/pricing services bound to the shared
 * disposable database. Each command runs through the same task 7.1 unit of work
 * + tenant-scoped Prisma gateways used in production, so these tests exercise
 * the real persistence layer (transactions, constraints, triggers, tenant
 * scoping) rather than in-memory fakes.
 */
function createServices(client: PartnerDatabaseClient) {
  const clock = new MutableClock(BASE_EPOCH_MS);
  const unitOfWork = new PrismaUnitOfWork(client);
  const credentialFactory = new CryptoDeviceCredentialFactory(CREDENTIAL_PEPPER);
  const rateLimitStore = new InMemoryRateLimitStore(() => clock.nowEpochMs());

  const devices = new DeviceManagementService({
    gateway: new PrismaDeviceManagementGateway(unitOfWork),
    credentialFactory,
    clock,
    idGenerator,
    environment: "test",
  });
  const heartbeat = new RecordHeartbeatService({
    gateway: new PrismaHeartbeatGateway(unitOfWork),
    clock,
    idGenerator,
  });
  const numbers = new NumberManagementService({
    gateway: new PrismaNumberManagementGateway(unitOfWork),
    clock,
    idGenerator,
  });
  const offers = new OfferManagementService({
    gateway: new PrismaOfferManagementGateway(unitOfWork),
    clock,
    idGenerator,
  });
  const inventory = new InventoryQueryService({
    gateway: new PrismaInventoryQueryGateway(client),
    clock,
  });
  // The Agent API guard used to prove rotated/revoked credentials are refused.
  const authenticator = new AgentApiAuthenticator({
    credentials: new PrismaAgentDeviceCredentialGateway(client),
    secretVerifier: credentialFactory,
    nonces: new PrismaReplayNonceGateway(client),
    rateLimitStore,
    clock,
    enforceHttps: false,
  });

  return { clock, devices, heartbeat, numbers, offers, inventory, authenticator, credentialFactory };
}

type Services = ReturnType<typeof createServices>;

async function deployFromEmpty(connectionString: string): Promise<void> {
  await execFileAsync(process.execPath, ["scripts/migrate-from-empty.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, PARTNER_MIGRATION_DATABASE_URL: connectionString },
    maxBuffer: 10 * 1024 * 1024,
  });
}

// ---------------------------------------------------------------------------
// Test-data helpers (raw client for seeding fixtures the commands read).
// ---------------------------------------------------------------------------

/** The immutable MVP platform config values (mirrors prisma/seed.sql). */
function platformConfigData(
  version: number,
  activeKey: string,
  overrides: Partial<{ markupBps: number; minBasePriceIdr: number; maxBasePriceIdr: number }> = {},
) {
  return {
    id: randomUUID(),
    version,
    serviceCode: "wa",
    countryCode: "ID",
    operatorCode: "any",
    currency: "IDR",
    minBasePriceIdr: overrides.minBasePriceIdr ?? 500,
    maxBasePriceIdr: overrides.maxBasePriceIdr ?? 5_000,
    fixedFeeIdr: 250,
    markupBps: overrides.markupBps ?? 1_500,
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

async function createApprovedPartner(client: PartnerDatabaseClient): Promise<string> {
  const id = randomUUID();
  await client.partner.create({
    data: {
      id,
      legalName: "Integration Legal Name",
      displayName: "Integration Partner",
      status: "APPROVED",
      simulatorAllowed: true,
    },
  });
  return id;
}

/** A trusted owner session context for a partner (never client-supplied). */
function ownerContext(partnerId: string): SessionContext {
  const principal: AuthenticatedPrincipal = {
    memberId: randomUUID(),
    partnerId,
    role: "owner",
    securityVersion: 1,
  };
  return toSessionContext(principal);
}

/** A fresh, valid, unique raw Indonesian mobile number ("08..." national form). */
function uniqueRawNumber(): string {
  let national = `8${randomInt(1, 10)}`;
  for (let i = 0; i < 9; i += 1) national += String(randomInt(0, 10));
  return `0${national}`;
}

/** Register an approved partner + one simulator device, returning ids + creds. */
async function seedPartnerWithDevice(services: Services, client: PartnerDatabaseClient) {
  const partnerId = await createApprovedPartner(client);
  const caller = ownerContext(partnerId);
  const created = await services.devices.createDevice({
    caller,
    type: "simulator",
    label: "Sim",
    capabilities: VALID_CAPABILITIES,
    requestId: randomUUID(),
  });
  if (!created.ok || !created.credential) throw new Error("device creation failed");
  return {
    partnerId,
    caller,
    deviceId: created.device.id,
    credential: created.credential,
  };
}

/** Build an Agent API auth request for a device credential token. */
function agentRequest(
  services: Services,
  agentToken: string,
  endpoint: AgentEndpoint = "heartbeat",
): AgentApiAuthRequest {
  const headers = new Headers();
  headers.set(AGENT_API_HEADERS.authorization, `Device ${agentToken}`);
  headers.set(AGENT_API_HEADERS.timestamp, String(Math.floor(services.clock.nowEpochMs() / 1000)));
  headers.set(AGENT_API_HEADERS.nonce, nextNonce());
  return {
    endpoint,
    headers,
    rawBody: "",
    secure: true,
    clientIp: "203.0.113.50",
  };
}

// ---------------------------------------------------------------------------
// **Validates: Requirements 5.5, 6.1, 6.3, 7.2, 7.4, 8.2, 8.5, 9.4**
// ---------------------------------------------------------------------------
describe.runIf(hasPostgres)("Inventory and pricing persistence integration (task 8.5)", () => {
  let database: DisposableTestDatabase;
  let client: PartnerDatabaseClient;
  let services: Services;

  beforeAll(async () => {
    database = await createDisposableTestDatabase(adminUrl);
    await deployFromEmpty(database.connectionString);
    client = createPartnerDatabaseClient({ databaseUrl: database.connectionString });
    await client.$connect();
    // The migration deploys the schema but not the immutable config seed.
    await client.platformConfig.create({ data: platformConfigData(1, "mvp-active") });
  }, 120_000);

  afterAll(async () => {
    await client?.$disconnect();
    await database?.dispose();
  }, 30_000);

  beforeEach(() => {
    services = createServices(client);
  });

  // Requirement 5.5: rotating/revoking a credential invalidates the previous
  // one immediately (grace period zero), so the Agent API refuses old secrets.
  describe("Credential rotate/revoke (Requirement 5.5)", () => {
    it("refuses the previous credential at the Agent API after a rotation", async () => {
      const { deviceId, caller, credential: first } = await seedPartnerWithDevice(services, client);

      // The freshly issued credential authenticates.
      const before = await services.authenticator.authenticate(agentRequest(services, first.agentToken));
      expect(before.ok).toBe(true);
      if (before.ok) expect(before.principal.deviceId).toBe(deviceId);

      const rotated = await services.devices.rotateCredential({
        caller,
        deviceId,
        requestId: randomUUID(),
      });
      expect(rotated.ok).toBe(true);
      if (!rotated.ok || !rotated.credential) throw new Error("rotation failed");

      // Old secret is now refused (revoked); the new secret authenticates.
      const oldRejected = await services.authenticator.authenticate(
        agentRequest(services, first.agentToken),
      );
      expect(oldRejected.ok).toBe(false);
      if (!oldRejected.ok) expect(oldRejected.error.code).toBe("AUTHENTICATION_FAILED");

      const newAccepted = await services.authenticator.authenticate(
        agentRequest(services, rotated.credential.agentToken),
      );
      expect(newAccepted.ok).toBe(true);

      // Persistence: the previous credential is REVOKED and exactly one ACTIVE
      // credential remains for the device.
      const rows = await client.deviceCredential.findMany({ where: { deviceId } });
      expect(rows).toHaveLength(2);
      const active = rows.filter((row) => row.status === "ACTIVE");
      expect(active).toHaveLength(1);
      expect(active[0].publicId).toBe(rotated.credential.publicId);
      const revoked = rows.find((row) => row.publicId === first.publicId);
      expect(revoked?.status).toBe("REVOKED");
      expect(revoked?.revokedAt).not.toBeNull();
    });

    it("refuses a credential at the Agent API after an explicit revoke", async () => {
      const { deviceId, caller, credential } = await seedPartnerWithDevice(services, client);

      const revoke = await services.devices.revokeCredential({
        caller,
        deviceId,
        requestId: randomUUID(),
      });
      expect(revoke.ok).toBe(true);

      const rejected = await services.authenticator.authenticate(
        agentRequest(services, credential.agentToken),
      );
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error.code).toBe("AUTHENTICATION_FAILED");

      // No active credential remains, and no replacement was issued.
      const active = await client.deviceCredential.count({
        where: { deviceId, status: "ACTIVE" },
      });
      expect(active).toBe(0);
    });
  });

  // Requirements 6.1/6.3: a valid heartbeat brings the device online, advances
  // lastSeenAt monotonically, and recovers idle numbers; an offline/stale
  // device excludes its numbers from available inventory.
  describe("Heartbeat recovery and effective availability (Requirements 6.1, 6.3)", () => {
    async function seedSupply() {
      const { partnerId, caller, deviceId } = await seedPartnerWithDevice(services, client);
      const offer = await services.offers.createOffer({
        caller,
        basePriceIdr: 1_000,
        requestId: randomUUID(),
      });
      if (!offer.ok) throw new Error("offer creation failed");
      const number = await services.numbers.registerNumber({
        caller,
        deviceId,
        rawNumber: uniqueRawNumber(),
        requestId: randomUUID(),
      });
      if (!number.ok) throw new Error("number registration failed");
      return { partnerId, caller, deviceId, numberId: number.number.id };
    }

    it("excludes an offline device's numbers from inventory (stockout), then recovers on heartbeat", async () => {
      const { caller, deviceId, numberId } = await seedSupply();

      // Device has never sent a heartbeat -> offline -> not eligible.
      const beforeBeat = await services.inventory.queryInventory({ filter: MVP_FILTER });
      expect(beforeBeat.ok).toBe(true);
      if (beforeBeat.ok) expect(beforeBeat.quote.available).toBe(false);

      // A valid heartbeat brings the device online and recovers the idle number.
      const recovered = await services.heartbeat.recordHeartbeat({
        tenant: caller.tenant,
        deviceId,
        receivedAtServer: services.clock.nowDate(),
        metadata: { agentVersion: "1.2.3", signal: -70 },
      });
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) return;
      expect(recovered.device.status).toBe("online");
      expect(recovered.recoveredNumberIds).toContain(numberId);

      // Persistence: device is ONLINE with lastSeenAt set; number is AVAILABLE
      // and its recovery is recorded in the state history.
      const device = await client.partnerDevice.findUniqueOrThrow({ where: { id: deviceId } });
      expect(device.effectiveStatus).toBe("ONLINE");
      expect(device.lastSeenAt?.getTime()).toBe(services.clock.nowEpochMs());
      const number = await client.partnerNumber.findUniqueOrThrow({ where: { id: numberId } });
      expect(number.status).toBe("AVAILABLE");
      const history = await client.numberStateHistory.findMany({ where: { numberId } });
      expect(history.some((entry) => entry.toStatus === "AVAILABLE")).toBe(true);

      // Now the number is discoverable at the authoritative retail price.
      const afterBeat = await services.inventory.queryInventory({ filter: MVP_FILTER });
      expect(afterBeat.ok).toBe(true);
      if (afterBeat.ok) {
        expect(afterBeat.quote.available).toBe(true);
        expect(afterBeat.quote.retailPriceIdr).toBe(1_400);
        expect(afterBeat.quote.quoteVersion).toBe(1);
      }

      // Once the heartbeat goes stale (> 90s), the number is excluded again
      // even though the persisted status is still AVAILABLE (Requirement 6.3).
      services.clock.advance(91_000);
      const stale = await services.inventory.queryInventory({ filter: MVP_FILTER });
      expect(stale.ok).toBe(true);
      if (stale.ok) expect(stale.quote.available).toBe(false);
    });

    it("advances lastSeenAt monotonically and never moves it backwards", async () => {
      const { caller, deviceId } = await seedSupply();

      const first = await services.heartbeat.recordHeartbeat({
        tenant: caller.tenant,
        deviceId,
        receivedAtServer: services.clock.nowDate(),
      });
      expect(first.ok).toBe(true);
      const firstSeen = first.ok ? first.device.lastSeenAtEpochMs : 0;

      // A heartbeat that arrives with an earlier server time must not rewind
      // lastSeenAt (server time is authoritative and monotonic).
      const stale = await services.heartbeat.recordHeartbeat({
        tenant: caller.tenant,
        deviceId,
        receivedAtServer: new Date(firstSeen - 60_000),
      });
      expect(stale.ok).toBe(true);
      if (stale.ok) expect(stale.device.lastSeenAtEpochMs).toBe(firstSeen);
    });

    it("rejects a heartbeat from a disabled device fail-closed", async () => {
      const { caller, deviceId } = await seedPartnerWithDevice(services, client);
      const disabled = await services.devices.disableDevice({
        caller,
        deviceId,
        requestId: randomUUID(),
      });
      expect(disabled.ok).toBe(true);

      const beat = await services.heartbeat.recordHeartbeat({
        tenant: caller.tenant,
        deviceId,
        receivedAtServer: services.clock.nowDate(),
      });
      expect(beat.ok).toBe(false);
      if (!beat.ok) expect(beat.reason).toBe("device_disabled");
      // The device stays disabled — no state was mutated.
      const device = await client.partnerDevice.findUniqueOrThrow({ where: { id: deviceId } });
      expect(device.effectiveStatus).toBe("DISABLED");
    });
  });

  // Requirement 7.2: numbers are normalized to canonical form and an active
  // duplicate (same tenant OR globally for the MVP) is rejected.
  describe("Duplicate active number rejection (Requirement 7.2)", () => {
    it("rejects a same-tenant active duplicate regardless of input formatting", async () => {
      const { caller, deviceId } = await seedPartnerWithDevice(services, client);
      const raw = uniqueRawNumber();

      const first = await services.numbers.registerNumber({
        caller,
        deviceId,
        rawNumber: raw,
        requestId: randomUUID(),
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const canonical = first.number.canonicalNumber;
      expect(canonical.startsWith("+62")).toBe(true);

      // Same number, differently formatted -> normalizes to the same canonical.
      const national = canonical.slice(3); // strip +62
      const formatted = `+62 ${national.slice(0, 3)}-${national.slice(3)}`;
      const dup = await services.numbers.registerNumber({
        caller,
        deviceId,
        rawNumber: formatted,
        requestId: randomUUID(),
      });
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.reason).toBe("duplicate_active_number");

      // Exactly one number persisted for the canonical slot.
      const count = await client.partnerNumber.count({
        where: { activeCanonicalNumber: canonical },
      });
      expect(count).toBe(1);
    });

    it("rejects an active duplicate across tenants via the global unique slot", async () => {
      const raw = uniqueRawNumber();
      const tenantA = await seedPartnerWithDevice(services, client);
      const tenantB = await seedPartnerWithDevice(services, client);

      const a = await services.numbers.registerNumber({
        caller: tenantA.caller,
        deviceId: tenantA.deviceId,
        rawNumber: raw,
        requestId: randomUUID(),
      });
      expect(a.ok).toBe(true);

      const b = await services.numbers.registerNumber({
        caller: tenantB.caller,
        deviceId: tenantB.deviceId,
        rawNumber: raw,
        requestId: randomUUID(),
      });
      expect(b.ok).toBe(false);
      if (!b.ok) expect(b.reason).toBe("duplicate_active_number");
    });
  });

  // Requirement 7.4: a reserved/busy number cannot be moved to another device
  // or deleted until the order finishes or is legitimately released.
  describe("Number state guard while reserved/busy (Requirement 7.4)", () => {
    async function seedReservedNumber(status: "RESERVED" | "BUSY") {
      const { partnerId, caller, deviceId } = await seedPartnerWithDevice(services, client);
      const registered = await services.numbers.registerNumber({
        caller,
        deviceId,
        rawNumber: uniqueRawNumber(),
        requestId: randomUUID(),
      });
      if (!registered.ok) throw new Error("number registration failed");
      // Drive the number into an in-order state directly (reservation is task 9.3).
      await client.partnerNumber.update({
        where: { id: registered.number.id },
        data: { status },
      });
      // A second device to attempt a move onto.
      const target = await services.devices.createDevice({
        caller,
        type: "simulator",
        label: "Sim 2",
        capabilities: VALID_CAPABILITIES,
        requestId: randomUUID(),
      });
      if (!target.ok) throw new Error("target device creation failed");
      return { partnerId, caller, numberId: registered.number.id, targetDeviceId: target.device.id };
    }

    it("blocks moving a reserved number to another device", async () => {
      const { caller, numberId, targetDeviceId } = await seedReservedNumber("RESERVED");
      const moved = await services.numbers.moveNumberToDevice({
        caller,
        numberId,
        targetDeviceId,
        requestId: randomUUID(),
      });
      expect(moved.ok).toBe(false);
      if (!moved.ok && moved.reason === "state_guarded") {
        expect(moved.status).toBe("reserved");
      } else {
        throw new Error("expected state_guarded");
      }
      // The number was not re-homed.
      const number = await client.partnerNumber.findUniqueOrThrow({ where: { id: numberId } });
      expect(number.deviceId).not.toBe(targetDeviceId);
    });

    it("blocks deleting a busy number", async () => {
      const { caller, numberId } = await seedReservedNumber("BUSY");
      const deleted = await services.numbers.deleteNumber({
        caller,
        numberId,
        requestId: randomUUID(),
      });
      expect(deleted.ok).toBe(false);
      if (!deleted.ok && deleted.reason === "state_guarded") {
        expect(deleted.status).toBe("busy");
      } else {
        throw new Error("expected state_guarded");
      }
      // The number still exists.
      const still = await client.partnerNumber.findUnique({ where: { id: numberId } });
      expect(still).not.toBeNull();
    });
  });

  // Requirement 8.5: pricing rule / base-price changes only apply to new
  // reservations — an existing order's snapshot is immutable.
  describe("Config/offer snapshot immutability (Requirement 8.5)", () => {
    it("leaves an existing order snapshot unchanged when the offer base price changes", async () => {
      const { partnerId, caller, deviceId } = await seedPartnerWithDevice(services, client);
      const offerResult = await services.offers.createOffer({
        caller,
        basePriceIdr: 1_000,
        requestId: randomUUID(),
      });
      if (!offerResult.ok) throw new Error("offer creation failed");
      const offerId = offerResult.offer.id;

      const registered = await services.numbers.registerNumber({
        caller,
        deviceId,
        rawNumber: uniqueRawNumber(),
        requestId: randomUUID(),
      });
      if (!registered.ok) throw new Error("number registration failed");
      const numberId = registered.number.id;

      // A committed order captures its price in an immutable snapshot at reserve
      // time (base 1000 -> retail 1400, payout 1000, margin 400).
      const orderId = randomUUID();
      await client.partnerOrder.create({
        data: {
          id: orderId,
          buyerOrderRef: `buyer-${orderId}`,
          buyerAccountRef: "buyer-acct-1",
          partnerId,
          numberId,
          offerId,
          status: "RESERVED",
          expiresAt: new Date(Date.UTC(2027, 0, 1, 0, 0, 0)),
        },
      });
      await client.orderSnapshot.create({
        data: {
          orderId,
          serviceCode: "wa",
          countryCode: "ID",
          operatorCode: "any",
          canonicalNumber: registered.number.canonicalNumber,
          basePriceIdr: 1_000,
          retailPriceIdr: 1_400,
          payoutIdr: 1_000,
          platformMarginIdr: 400,
          currency: "IDR",
          configVersion: 1,
        },
      });

      // Change the live offer's base price (only affects NEW reservations).
      const updated = await services.offers.updateOfferBasePrice({
        caller,
        offerId,
        basePriceIdr: 2_000,
        requestId: randomUUID(),
      });
      expect(updated.ok).toBe(true);
      if (updated.ok) {
        expect(updated.offer.basePriceIdr).toBe(2_000);
        expect(updated.offer.pricing.payoutIdr).toBe(2_000);
      }

      // The existing snapshot is untouched — the old reservation keeps its price.
      const snapshot = await client.orderSnapshot.findUniqueOrThrow({ where: { orderId } });
      expect(snapshot.basePriceIdr).toBe(1_000);
      expect(snapshot.retailPriceIdr).toBe(1_400);
      expect(snapshot.payoutIdr).toBe(1_000);
      expect(snapshot.configVersion).toBe(1);
    });

    it("enforces order-snapshot immutability at the database layer", async () => {
      const { partnerId, caller, deviceId } = await seedPartnerWithDevice(services, client);
      const offerResult = await services.offers.createOffer({
        caller,
        basePriceIdr: 1_000,
        requestId: randomUUID(),
      });
      if (!offerResult.ok) throw new Error("offer creation failed");
      const registered = await services.numbers.registerNumber({
        caller,
        deviceId,
        rawNumber: uniqueRawNumber(),
        requestId: randomUUID(),
      });
      if (!registered.ok) throw new Error("number registration failed");

      const orderId = randomUUID();
      await client.partnerOrder.create({
        data: {
          id: orderId,
          buyerOrderRef: `buyer-${orderId}`,
          buyerAccountRef: "buyer-acct-2",
          partnerId,
          numberId: registered.number.id,
          offerId: offerResult.offer.id,
          status: "RESERVED",
          expiresAt: new Date(Date.UTC(2027, 0, 1, 0, 0, 0)),
        },
      });
      await client.orderSnapshot.create({
        data: {
          orderId,
          serviceCode: "wa",
          countryCode: "ID",
          operatorCode: "any",
          canonicalNumber: registered.number.canonicalNumber,
          basePriceIdr: 1_000,
          retailPriceIdr: 1_400,
          payoutIdr: 1_000,
          platformMarginIdr: 400,
          currency: "IDR",
          configVersion: 1,
        },
      });

      // Direct UPDATE/DELETE are rejected by the immutability trigger.
      await expect(
        client.$executeRawUnsafe(
          `UPDATE "order_snapshots" SET "basePriceIdr" = 999 WHERE "orderId" = $1`,
          orderId,
        ),
      ).rejects.toThrow();
      await expect(
        client.$executeRawUnsafe(`DELETE FROM "order_snapshots" WHERE "orderId" = $1`, orderId),
      ).rejects.toThrow();
    });

    it("enforces platform-config immutability at the database layer", async () => {
      // The active config version underpins snapshot pricing; it can never be
      // mutated in place (a new version is published instead).
      await expect(
        client.$executeRawUnsafe(`UPDATE "platform_configs" SET "markupBps" = 9999 WHERE "version" = 1`),
      ).rejects.toThrow();
    });
  });

  // Requirement 8.2: the base price is validated against the guardrail
  // (Rp500–Rp5.000) server-side, and retail/payout are authoritative.
  describe("Pricing guardrail boundaries (Requirement 8.2)", () => {
    it("accepts the guardrail boundaries and rejects values just outside them", async () => {
      const partnerId = await createApprovedPartner(client);
      const caller = ownerContext(partnerId);

      // Minimum boundary (500) -> retail 850 (500 + 250 fee + 75 markup -> round 50).
      const atMin = await services.offers.createOffer({
        caller,
        basePriceIdr: 500,
        activate: false,
        requestId: randomUUID(),
      });
      expect(atMin.ok).toBe(true);
      if (atMin.ok) expect(atMin.offer.pricing.retailPriceIdr).toBe(850);

      // Maximum boundary (5000) -> retail 6000 (5000 + 250 + 750).
      const atMax = await services.offers.createOffer({
        caller,
        basePriceIdr: 5_000,
        activate: false,
        requestId: randomUUID(),
      });
      expect(atMax.ok).toBe(true);
      if (atMax.ok) expect(atMax.offer.pricing.retailPriceIdr).toBe(6_000);

      // Just below the minimum and just above the maximum are rejected.
      const belowMin = await services.offers.createOffer({
        caller,
        basePriceIdr: 499,
        activate: false,
        requestId: randomUUID(),
      });
      expect(belowMin.ok).toBe(false);
      if (!belowMin.ok) expect(belowMin.reason).toBe("price_out_of_guardrail");

      const aboveMax = await services.offers.createOffer({
        caller,
        basePriceIdr: 5_001,
        activate: false,
        requestId: randomUUID(),
      });
      expect(aboveMax.ok).toBe(false);
      if (!aboveMax.ok) expect(aboveMax.reason).toBe("price_out_of_guardrail");

      // Only the two in-range offers were persisted.
      const persisted = await client.partnerOffer.count({ where: { partnerId } });
      expect(persisted).toBe(2);
    });
  });

  // Requirement 9.4: when no inventory meets the criteria, a stockout result is
  // returned without creating a partial Partner_Order.
  describe("Stockout without a partial order (Requirement 9.4)", () => {
    it("returns a stockout quote and creates no order when supply is not eligible", async () => {
      // Supply exists (approved partner, active offer, registered number) but the
      // device has never sent a heartbeat, so nothing is eligible.
      const { caller, deviceId } = await seedPartnerWithDevice(services, client);
      const offer = await services.offers.createOffer({
        caller,
        basePriceIdr: 1_000,
        requestId: randomUUID(),
      });
      expect(offer.ok).toBe(true);
      const registered = await services.numbers.registerNumber({
        caller,
        deviceId,
        rawNumber: uniqueRawNumber(),
        requestId: randomUUID(),
      });
      expect(registered.ok).toBe(true);

      const ordersBefore = await client.partnerOrder.count();

      const quote = await services.inventory.queryInventory({ filter: MVP_FILTER });
      expect(quote.ok).toBe(true);
      if (quote.ok) {
        expect(quote.quote.available).toBe(false);
        expect(quote.quote.retailPriceIdr).toBeNull();
        expect(quote.quote.quoteVersion).toBe(1);
      }

      // The query is side-effect free: no partial order was created.
      const ordersAfter = await client.partnerOrder.count();
      expect(ordersAfter).toBe(ordersBefore);
    });

    it("rejects a filter outside the configured catalog", async () => {
      const mismatch = await services.inventory.queryInventory({
        filter: { serviceCode: "sms", countryCode: "ID", operatorCode: "any" },
      });
      expect(mismatch.ok).toBe(false);
      if (!mismatch.ok) expect(mismatch.reason).toBe("catalog_mismatch");
    });
  });
});
