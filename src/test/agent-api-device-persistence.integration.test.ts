import { execFile } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgentApiAuthenticator, type AgentApiAuthRequest, type AgentEndpoint } from "@application/agent-api";
import { RecordHeartbeatService } from "@application/heartbeat";
import { IdempotencyEngine } from "@application/internal-api";
import { AgentNumberService, AGENT_NUMBER_REGISTER_SCOPE } from "@application/numbers";
import {
  ConcurrencyConflictError,
  createPartnerDatabaseClient,
  createTenantContext,
  PrismaAgentDeviceCredentialGateway,
  PrismaAgentNumberGateway,
  PrismaHeartbeatGateway,
  PrismaIdempotencyStore,
  PrismaIdempotencyTransactionRunner,
  PrismaReplayNonceGateway,
  PrismaUnitOfWork,
  type PartnerDatabaseClient,
  type PartnerTransactionClient,
} from "@infrastructure/database";
import { CryptoDeviceCredentialFactory } from "@infrastructure/auth/crypto-device-credential";
import { InMemoryRateLimitStore } from "@infrastructure/auth/in-memory-rate-limit-store";
import { CryptoIdGenerator, SystemClock } from "@infrastructure/auth/system-clock";

import {
  createDisposableTestDatabase,
  type DisposableTestDatabase,
} from "./disposable-database";

/**
 * Agent API device-surface persistence integration tests (spec gap 11.5).
 *
 * These drive the *production* Agent API device path end-to-end against a real
 * disposable PostgreSQL database — no in-memory fakes for the storage seam:
 *
 *  - Device credential verification through the real {@link AgentApiAuthenticator}
 *    wired to {@link PrismaAgentDeviceCredentialGateway} (the credential ⋈ device
 *    ⋈ partner join) + the real {@link CryptoDeviceCredentialFactory} secret
 *    hasher + {@link PrismaReplayNonceGateway} (the atomic nonce claim): a correct
 *    secret authenticates, a wrong secret / revoked credential collapse to a
 *    generic auth failure, a disabled device / non-approved partner surface as
 *    FORBIDDEN, and a replayed nonce loses the race on the real unique index.
 *  - Device number registration through the real {@link AgentNumberService}
 *    (real {@link IdempotencyEngine} + {@link PrismaAgentNumberGateway}): the
 *    `partner_numbers` row, its `number_state_history` entry, the audit event, and
 *    the idempotency record all commit atomically; a same-key replay returns the
 *    first result verbatim and a different payload under the same key is a
 *    deterministic conflict — all against the composite device foreign key and
 *    the `partner_numbers_active_canonical_check` CHECK.
 *  - Heartbeat liveness + idle-number recovery through the real
 *    {@link RecordHeartbeatService} + {@link PrismaHeartbeatGateway}: a beat moves
 *    the device `offline → online`, stamps `lastSeenAt` monotonically, inserts a
 *    heartbeat sample, and recovers an eligible idle number `offline → available`;
 *    a `reserved` number is never touched.
 *  - The status-compare-and-set path from the P1 fix (agent-number +
 *    heartbeat reconcile): a stale `expectedStatus`/`fromStatus` matches zero rows
 *    on the real predicate, so a concurrently-reserved number is never clobbered.
 *
 * The CAS status path (P1) had no integration coverage; these prove the
 * compare-and-set genuinely prevents the clobber against Postgres.
 */
const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const adminUrl = process.env.PARTNER_TEST_DATABASE_ADMIN_URL ?? "";
const hasPostgres = adminUrl.length > 0;

/** A deterministic test pepper shared by issuance + verification. */
const DEVICE_PEPPER = "integration-test-device-credential-pepper";
const credentialFactory = new CryptoDeviceCredentialFactory(DEVICE_PEPPER);

async function deployFromEmpty(connectionString: string): Promise<void> {
  await execFileAsync(process.execPath, ["scripts/migrate-from-empty.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, PARTNER_MIGRATION_DATABASE_URL: connectionString },
    maxBuffer: 10 * 1024 * 1024,
  });
}

/** The immutable MVP platform config (mirrors prisma/seed.sql + task-12-4). */
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

// ---------------------------------------------------------------------------
// Fixture seeding (raw client), in dependency order with scalar FKs set
// directly (mirrors the task-12-4 / task-16-6 conventions).
// ---------------------------------------------------------------------------
type DbPartnerStatus = "PENDING" | "APPROVED" | "SUSPENDED" | "REJECTED";
type DbDeviceStatus = "OFFLINE" | "ONLINE" | "DISABLED";
type DbCredentialStatus = "ACTIVE" | "SUPERSEDED" | "REVOKED";
type DbNumberStatus = "OFFLINE" | "AVAILABLE" | "RESERVED" | "BUSY" | "DISABLED";

async function createPartner(
  client: PartnerDatabaseClient,
  status: DbPartnerStatus = "APPROVED",
): Promise<string> {
  const id = randomUUID();
  await client.partner.create({
    data: {
      id,
      legalName: "Agent Device Legal",
      displayName: "Agent Device Partner",
      status,
      simulatorAllowed: true,
    },
  });
  return id;
}

async function createDevice(
  client: PartnerDatabaseClient,
  partnerId: string,
  options: { readonly status?: DbDeviceStatus; readonly lastSeenAtEpochMs?: number | null } = {},
): Promise<string> {
  const id = randomUUID();
  const status = options.status ?? "ONLINE";
  await client.partnerDevice.create({
    data: {
      id,
      partnerId,
      type: "SIMULATOR",
      label: "Sim",
      effectiveStatus: status,
      // partner_devices_disabled_check: a disabled device must carry disabledAt.
      disabledAt: status === "DISABLED" ? new Date() : null,
      lastSeenAt:
        options.lastSeenAtEpochMs === undefined || options.lastSeenAtEpochMs === null
          ? null
          : new Date(options.lastSeenAtEpochMs),
      capabilitiesJson: { sms: true, notification: false, resend: false, operator: null, slots: 1 },
    },
  });
  return id;
}

interface SeededCredential {
  readonly deviceId: string;
  readonly credentialId: string;
  readonly publicId: string;
  readonly secret: string;
}

/** Seed a device + a real credential row whose hash is derived by the production
 * factory, so verification exercises the exact issuance derivation. */
async function seedDeviceCredential(
  client: PartnerDatabaseClient,
  partnerId: string,
  options: { readonly deviceStatus?: DbDeviceStatus; readonly credentialStatus?: DbCredentialStatus } = {},
): Promise<SeededCredential> {
  const deviceId = await createDevice(client, partnerId, { status: options.deviceStatus ?? "ONLINE" });
  const issued = credentialFactory.issue(deviceId);
  const credentialId = randomUUID();
  const credentialStatus = options.credentialStatus ?? "ACTIVE";
  await client.deviceCredential.create({
    data: {
      id: credentialId,
      partnerId,
      deviceId,
      publicId: issued.publicId,
      secretHash: issued.secretHash,
      status: credentialStatus,
      revokedAt: credentialStatus === "REVOKED" ? new Date() : null,
    },
  });
  return { deviceId, credentialId, publicId: issued.publicId, secret: issued.secret };
}

async function createActiveOffer(client: PartnerDatabaseClient, partnerId: string): Promise<string> {
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
  let digits = "";
  for (let i = 0; i < 9; i += 1) digits += String(randomInt(0, 10));
  return `+628${digits}`;
}

async function createNumber(
  client: PartnerDatabaseClient,
  partnerId: string,
  deviceId: string,
  options: { readonly status?: DbNumberStatus; readonly enabled?: boolean; readonly currentOrderId?: string | null } = {},
): Promise<{ numberId: string; canonicalNumber: string }> {
  const numberId = randomUUID();
  const canonicalNumber = uniqueCanonicalNumber();
  const status = options.status ?? "AVAILABLE";
  const enabled = options.enabled ?? true;
  const active = enabled && status !== "DISABLED";
  await client.partnerNumber.create({
    data: {
      id: numberId,
      partnerId,
      deviceId,
      canonicalNumber,
      // Satisfy partner_numbers_active_canonical_check: an enabled, non-disabled
      // number must carry activeCanonicalNumber === canonicalNumber.
      activeCanonicalNumber: active ? canonicalNumber : null,
      countryCode: "ID",
      operatorCode: "any",
      status,
      enabled,
      currentOrderId: options.currentOrderId ?? null,
    },
  });
  return { numberId, canonicalNumber };
}

/** A minimal active RESERVED order bound to a number (mirrors a live reservation). */
async function createReservedOrder(
  client: PartnerDatabaseClient,
  args: { readonly partnerId: string; readonly numberId: string; readonly offerId: string },
): Promise<string> {
  const orderId = randomUUID();
  const now = Date.now();
  await client.partnerOrder.create({
    data: {
      id: orderId,
      buyerOrderRef: `buyer-${orderId}`,
      buyerAccountRef: `acct-${randomUUID()}`,
      partnerId: args.partnerId,
      numberId: args.numberId,
      offerId: args.offerId,
      status: "RESERVED",
      reservedAt: new Date(now - 60_000),
      expiresAt: new Date(now + 20 * 60_000),
      version: 1,
    },
  });
  await client.partnerNumber.update({
    where: { id: args.numberId },
    data: { currentOrderId: orderId },
  });
  return orderId;
}

// ---------------------------------------------------------------------------
// Auth request assembly for the real authenticator.
// ---------------------------------------------------------------------------
interface AuthRequestOptions {
  readonly secret?: string;
  readonly nonce?: string;
  readonly timestampSeconds?: number;
  readonly idempotencyKey?: string;
  readonly clientIp?: string;
}

let ipCounter = 0;
function nextClientIp(): string {
  ipCounter += 1;
  return `10.10.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

function fresh128BitNonce(): string {
  return randomBytes(16).toString("base64url");
}

function buildAuthRequest(
  token: { readonly publicId: string; readonly secret: string },
  endpoint: AgentEndpoint,
  options: AuthRequestOptions = {},
): AgentApiAuthRequest {
  const secret = options.secret ?? token.secret;
  const headers = new Headers({
    authorization: `Device ${token.publicId}.${secret}`,
    "x-agent-timestamp": String(options.timestampSeconds ?? Math.floor(Date.now() / 1000)),
    "x-agent-nonce": options.nonce ?? fresh128BitNonce(),
  });
  if (options.idempotencyKey !== undefined) headers.set("idempotency-key", options.idempotencyKey);
  return {
    endpoint,
    headers,
    rawBody: "",
    secure: true,
    clientIp: options.clientIp ?? nextClientIp(),
  };
}

// ---------------------------------------------------------------------------
describe.runIf(hasPostgres)("Agent API device-surface persistence integration (gap 11.5)", () => {
  let database: DisposableTestDatabase;
  let client: PartnerDatabaseClient;
  let authenticator: AgentApiAuthenticator;
  let numberService: AgentNumberService<PartnerTransactionClient>;
  let heartbeatService: RecordHeartbeatService;
  const clock = new SystemClock();
  const idGenerator = new CryptoIdGenerator();

  beforeAll(async () => {
    database = await createDisposableTestDatabase(adminUrl);
    await deployFromEmpty(database.connectionString);
    client = createPartnerDatabaseClient({ databaseUrl: database.connectionString });
    await client.$connect();
    await client.platformConfig.create({ data: platformConfigData(1, "mvp-active") });

    authenticator = new AgentApiAuthenticator({
      credentials: new PrismaAgentDeviceCredentialGateway(client),
      secretVerifier: credentialFactory,
      nonces: new PrismaReplayNonceGateway(client),
      rateLimitStore: new InMemoryRateLimitStore(),
      clock,
      enforceHttps: false,
    });
    numberService = new AgentNumberService<PartnerTransactionClient>({
      idempotency: new IdempotencyEngine<PartnerTransactionClient>({
        store: new PrismaIdempotencyStore(),
        runner: new PrismaIdempotencyTransactionRunner(client),
        clock,
      }),
      gateway: new PrismaAgentNumberGateway(),
      clock,
      idGenerator,
    });
    heartbeatService = new RecordHeartbeatService({
      gateway: new PrismaHeartbeatGateway(new PrismaUnitOfWork(client)),
      clock,
      idGenerator,
    });
  }, 120_000);

  afterAll(async () => {
    await client?.$disconnect();
    await database?.dispose();
  }, 30_000);

  // -------------------------------------------------------------------------
  // Device credential verification via the real authenticator + Prisma gateways.
  // -------------------------------------------------------------------------
  describe("Device credential verification (correct / wrong / revoked / forbidden)", () => {
    it("authenticates an ACTIVE credential of an approved, non-disabled device", async () => {
      const partnerId = await createPartner(client, "APPROVED");
      const token = await seedDeviceCredential(client, partnerId, { deviceStatus: "ONLINE" });

      const result = await authenticator.authenticate(buildAuthRequest(token, "heartbeat"));

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.principal.partnerId).toBe(partnerId);
      expect(result.principal.deviceId).toBe(token.deviceId);
      expect(result.principal.credentialPublicId).toBe(token.publicId);
      expect(result.principal.idempotencyKey).toBeNull();

      // The nonce claim is the only persistence effect: exactly one row landed.
      const nonces = await client.replayNonce.count({
        where: { principalId: `device:${token.deviceId}` },
      });
      expect(nonces).toBe(1);
    });

    it("rejects a wrong secret with a generic authentication failure", async () => {
      const partnerId = await createPartner(client, "APPROVED");
      const token = await seedDeviceCredential(client, partnerId);
      // A well-formed but wrong secret (matches the parser, fails the hash).
      const wrongSecret = randomBytes(32).toString("base64url");

      const result = await authenticator.authenticate(
        buildAuthRequest(token, "heartbeat", { secret: wrongSecret }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.status).toBe(401);
      // A failed secret verification claims no nonce (rejected before step 9).
      const nonces = await client.replayNonce.count({
        where: { principalId: `device:${token.deviceId}` },
      });
      expect(nonces).toBe(0);
    });

    it("rejects a REVOKED credential (status is not active)", async () => {
      const partnerId = await createPartner(client, "APPROVED");
      const token = await seedDeviceCredential(client, partnerId, { credentialStatus: "REVOKED" });

      const result = await authenticator.authenticate(buildAuthRequest(token, "heartbeat"));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      // A rotated/revoked credential collapses to the generic auth failure.
      expect(result.error.status).toBe(401);
    });

    it("surfaces FORBIDDEN for a disabled device with a valid secret", async () => {
      const partnerId = await createPartner(client, "APPROVED");
      const token = await seedDeviceCredential(client, partnerId, { deviceStatus: "DISABLED" });

      const result = await authenticator.authenticate(buildAuthRequest(token, "heartbeat"));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      // The caller proved the secret, so a fail-closed gate is FORBIDDEN, not 401.
      expect(result.error.status).toBe(403);
    });

    it("surfaces FORBIDDEN for a non-approved partner with a valid secret", async () => {
      const partnerId = await createPartner(client, "SUSPENDED");
      const token = await seedDeviceCredential(client, partnerId, { deviceStatus: "ONLINE" });

      const result = await authenticator.authenticate(buildAuthRequest(token, "heartbeat"));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.status).toBe(403);
    });

    it("rejects a replayed nonce on the real unique index (second claim loses)", async () => {
      const partnerId = await createPartner(client, "APPROVED");
      const token = await seedDeviceCredential(client, partnerId);
      const nonce = fresh128BitNonce();
      const clientIp = nextClientIp();

      const first = await authenticator.authenticate(
        buildAuthRequest(token, "heartbeat", { nonce, clientIp }),
      );
      expect(first.ok).toBe(true);

      const replay = await authenticator.authenticate(
        buildAuthRequest(token, "heartbeat", { nonce, clientIp }),
      );
      expect(replay.ok).toBe(false);
      if (replay.ok) throw new Error("unreachable");
      // REPLAY_REJECTED is a 4xx; the nonce table still holds exactly one row.
      expect(replay.error.status).toBeGreaterThanOrEqual(400);
      const nonces = await client.replayNonce.count({
        where: { principalId: `device:${token.deviceId}` },
      });
      expect(nonces).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Device number registration via the real idempotent AgentNumberService.
  // -------------------------------------------------------------------------
  describe("Device number registration persists atomically and is idempotent", () => {
    it("registers a number with its state-history, audit event, and idempotency record", async () => {
      const partnerId = await createPartner(client, "APPROVED");
      const deviceId = await createDevice(client, partnerId, { status: "ONLINE" });
      const idempotencyKey = randomUUID();
      const rawNumber = uniqueCanonicalNumber();

      const result = await numberService.registerNumber({
        partnerId,
        deviceId,
        idempotencyKey,
        method: "POST",
        path: "/api/agent/v1/numbers/register",
        requestId: randomUUID(),
        rawNumber,
      });

      expect(result.statusCode).toBe(201);
      expect("data" in result.body).toBe(true);
      if (!("data" in result.body)) throw new Error("unreachable");
      const numberId = result.body.data.id;
      expect(result.body.data.status).toBe("offline");
      expect(result.body.data.enabled).toBe(true);
      expect(result.body.data.canonicalNumber).toBe(rawNumber);

      // The persisted number row: offline + enabled, active-canonical slot claimed.
      const row = await client.partnerNumber.findUniqueOrThrow({ where: { id: numberId } });
      expect(row.partnerId).toBe(partnerId);
      expect(row.deviceId).toBe(deviceId);
      expect(row.status).toBe("OFFLINE");
      expect(row.enabled).toBe(true);
      expect(row.canonicalNumber).toBe(rawNumber);
      expect(row.activeCanonicalNumber).toBe(rawNumber);
      expect(row.operatorCode).toBe("any");
      expect(row.countryCode).toBe("ID");

      // Exactly one initial state-history row: null -> offline by the device.
      const history = await client.numberStateHistory.findMany({ where: { numberId } });
      expect(history).toHaveLength(1);
      expect(history[0].fromStatus).toBeNull();
      expect(history[0].toStatus).toBe("OFFLINE");
      expect(history[0].actorType).toBe("DEVICE");

      // An audit event for the registration, scoped to the tenant + number.
      const audits = await client.auditEvent.findMany({
        where: { partnerId, targetId: numberId, action: "number.changed" },
      });
      expect(audits).toHaveLength(1);

      // The idempotency record committed in the same transaction (COMPLETED, 201).
      const record = await client.idempotencyRecord.findUniqueOrThrow({
        where: {
          scope_principalId_key: {
            scope: AGENT_NUMBER_REGISTER_SCOPE,
            principalId: `device:${deviceId}`,
            key: idempotencyKey,
          },
        },
      });
      expect(record.state).toBe("COMPLETED");
      expect(record.responseStatus).toBe(201);
    });

    it("replays the first result verbatim for the same key + payload (no second row)", async () => {
      const partnerId = await createPartner(client, "APPROVED");
      const deviceId = await createDevice(client, partnerId, { status: "ONLINE" });
      const idempotencyKey = randomUUID();
      const rawNumber = uniqueCanonicalNumber();
      const baseInput = {
        partnerId,
        deviceId,
        idempotencyKey,
        method: "POST",
        path: "/api/agent/v1/numbers/register",
        requestId: randomUUID(),
        rawNumber,
      };

      const first = await numberService.registerNumber(baseInput);
      expect(first.statusCode).toBe(201);
      if (!("data" in first.body)) throw new Error("unreachable");
      const firstId = first.body.data.id;

      const replay = await numberService.registerNumber({ ...baseInput, requestId: randomUUID() });
      expect(replay.statusCode).toBe(201);
      if (!("data" in replay.body)) throw new Error("unreachable");
      expect(replay.body.data.id).toBe(firstId);

      // Only one number row exists for the canonical (the replay wrote nothing).
      const rows = await client.partnerNumber.findMany({
        where: { partnerId, canonicalNumber: rawNumber },
      });
      expect(rows).toHaveLength(1);
      const history = await client.numberStateHistory.count({ where: { numberId: firstId } });
      expect(history).toBe(1);
    });

    it("returns a deterministic conflict for a different payload under the same key", async () => {
      const partnerId = await createPartner(client, "APPROVED");
      const deviceId = await createDevice(client, partnerId, { status: "ONLINE" });
      const idempotencyKey = randomUUID();
      const firstNumber = uniqueCanonicalNumber();
      const secondNumber = uniqueCanonicalNumber();

      const first = await numberService.registerNumber({
        partnerId,
        deviceId,
        idempotencyKey,
        method: "POST",
        path: "/api/agent/v1/numbers/register",
        requestId: randomUUID(),
        rawNumber: firstNumber,
      });
      expect(first.statusCode).toBe(201);

      const conflict = await numberService.registerNumber({
        partnerId,
        deviceId,
        idempotencyKey,
        method: "POST",
        path: "/api/agent/v1/numbers/register",
        requestId: randomUUID(),
        rawNumber: secondNumber,
      });
      expect(conflict.statusCode).toBe(409);
      expect("error" in conflict.body).toBe(true);

      // The conflicting second payload persisted no number for its canonical.
      const rows = await client.partnerNumber.count({
        where: { partnerId, canonicalNumber: secondNumber },
      });
      expect(rows).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Heartbeat liveness + idle-number recovery via the real service + gateway.
  // -------------------------------------------------------------------------
  describe("Heartbeat records liveness and recovers idle numbers", () => {
    it("moves the device online, stamps lastSeenAt, inserts a sample, and recovers an idle number", async () => {
      const partnerId = await createPartner(client, "APPROVED");
      const deviceId = await createDevice(client, partnerId, {
        status: "OFFLINE",
        lastSeenAtEpochMs: null,
      });
      await createActiveOffer(client, partnerId);
      const idle = await createNumber(client, partnerId, deviceId, { status: "OFFLINE" });
      // A reserved number on the same device must never be reassigned by a beat.
      const reserved = await createNumber(client, partnerId, deviceId, { status: "RESERVED" });

      const receivedAtServer = new Date();
      const outcome = await heartbeatService.recordHeartbeat({
        tenant: createTenantContext(partnerId),
        deviceId,
        receivedAtServer,
        metadata: { signal: -61, operator: "Telkomsel", agentVersion: "1.4.2" },
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("unreachable");
      expect(outcome.device.status).toBe("online");
      expect(outcome.device.lastSeenAtEpochMs).toBe(receivedAtServer.getTime());
      expect(outcome.recoveredNumberIds).toContain(idle.numberId);
      expect(outcome.recoveredNumberIds).not.toContain(reserved.numberId);

      // Device row: online with the server-authoritative lastSeenAt.
      const device = await client.partnerDevice.findUniqueOrThrow({ where: { id: deviceId } });
      expect(device.effectiveStatus).toBe("ONLINE");
      expect(device.lastSeenAt?.getTime()).toBe(receivedAtServer.getTime());
      expect(device.agentVersion).toBe("1.4.2");

      // The append-only heartbeat sample landed with the validated metadata.
      const samples = await client.deviceHeartbeat.findMany({ where: { deviceId } });
      expect(samples).toHaveLength(1);
      expect(samples[0].signal).toBe(-61);
      expect(samples[0].operator).toBe("Telkomsel");
      expect(samples[0].receivedAt.getTime()).toBe(receivedAtServer.getTime());

      // The idle number recovered offline -> available with a history entry.
      const recovered = await client.partnerNumber.findUniqueOrThrow({ where: { id: idle.numberId } });
      expect(recovered.status).toBe("AVAILABLE");
      const recoverHistory = await client.numberStateHistory.findMany({
        where: { numberId: idle.numberId, toStatus: "AVAILABLE" },
      });
      expect(recoverHistory).toHaveLength(1);
      expect(recoverHistory[0].reason).toBe("heartbeat_recovery");

      // The reserved number was untouched (excluded from idle recovery).
      const stillReserved = await client.partnerNumber.findUniqueOrThrow({
        where: { id: reserved.numberId },
      });
      expect(stillReserved.status).toBe("RESERVED");
    });

    it("keeps lastSeenAt monotonic when an older heartbeat arrives", async () => {
      const partnerId = await createPartner(client, "APPROVED");
      const deviceId = await createDevice(client, partnerId, {
        status: "OFFLINE",
        lastSeenAtEpochMs: null,
      });

      const newer = new Date();
      const fresh = await heartbeatService.recordHeartbeat({
        tenant: createTenantContext(partnerId),
        deviceId,
        receivedAtServer: newer,
      });
      expect(fresh.ok).toBe(true);

      // A stale beat (60s older) must not roll lastSeenAt backwards.
      const older = new Date(newer.getTime() - 60_000);
      const stale = await heartbeatService.recordHeartbeat({
        tenant: createTenantContext(partnerId),
        deviceId,
        receivedAtServer: older,
      });
      expect(stale.ok).toBe(true);
      if (!stale.ok) throw new Error("unreachable");
      expect(stale.device.lastSeenAtEpochMs).toBe(newer.getTime());

      const device = await client.partnerDevice.findUniqueOrThrow({ where: { id: deviceId } });
      expect(device.lastSeenAt?.getTime()).toBe(newer.getTime());
    });

    it("rejects a heartbeat from a disabled device without mutating it (fail-closed)", async () => {
      const partnerId = await createPartner(client, "APPROVED");
      const deviceId = await createDevice(client, partnerId, {
        status: "DISABLED",
        lastSeenAtEpochMs: null,
      });

      const outcome = await heartbeatService.recordHeartbeat({
        tenant: createTenantContext(partnerId),
        deviceId,
        receivedAtServer: new Date(),
      });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("unreachable");
      expect(outcome.reason).toBe("device_disabled");
      const device = await client.partnerDevice.findUniqueOrThrow({ where: { id: deviceId } });
      expect(device.effectiveStatus).toBe("DISABLED");
      expect(device.lastSeenAt).toBeNull();
      const samples = await client.deviceHeartbeat.count({ where: { deviceId } });
      expect(samples).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // The P1 status compare-and-set: a stale expected status must never clobber a
  // concurrently-reserved number. Drives the production CAS predicate directly.
  // -------------------------------------------------------------------------
  describe("Status compare-and-set prevents clobbering a reserved number (P1)", () => {
    it("agent-number applyNumberStatus raises a conflict on a stale expectedStatus", async () => {
      const partnerId = await createPartner(client, "APPROVED");
      const deviceId = await createDevice(client, partnerId, { status: "ONLINE" });
      const offerId = await createActiveOffer(client, partnerId);
      const { numberId, canonicalNumber } = await createNumber(client, partnerId, deviceId, {
        status: "RESERVED",
      });
      const orderId = await createReservedOrder(client, { partnerId, numberId, offerId });

      const gateway = new PrismaAgentNumberGateway();
      // The device read the number as `available` moments ago, but a concurrent
      // order reserved it since. The CAS pins `status = expectedStatus`, so this
      // write must match zero rows and raise a retryable conflict — not overwrite.
      await expect(
        client.$transaction((tx) =>
          gateway.applyNumberStatus(tx, partnerId, numberId, {
            expectedStatus: "available",
            status: "offline",
            enabled: true,
            activeCanonicalNumber: canonicalNumber,
          }),
        ),
      ).rejects.toBeInstanceOf(ConcurrencyConflictError);

      // The reservation stands: status and binding are untouched by the lost write.
      const row = await client.partnerNumber.findUniqueOrThrow({ where: { id: numberId } });
      expect(row.status).toBe("RESERVED");
      expect(row.currentOrderId).toBe(orderId);
    });

    it("heartbeat reconcile applyNumberStatus skips a stale fromStatus without a history write", async () => {
      const partnerId = await createPartner(client, "APPROVED");
      const deviceId = await createDevice(client, partnerId, { status: "ONLINE" });
      const offerId = await createActiveOffer(client, partnerId);
      const { numberId } = await createNumber(client, partnerId, deviceId, { status: "RESERVED" });
      await createReservedOrder(client, { partnerId, numberId, offerId });

      const gateway = new PrismaHeartbeatGateway(new PrismaUnitOfWork(client));
      // Reconcile read the number as `offline` (idle), but it is now RESERVED. The
      // best-effort CAS must skip (return false) and write no history row.
      const applied = await gateway.runInTenant(createTenantContext(partnerId), (tx) =>
        tx.applyNumberStatus({
          numberId,
          fromStatus: "offline",
          toStatus: "available",
          historyId: randomUUID(),
          actorRef: deviceId,
          reason: "heartbeat_recovery",
          occurredAtEpochMs: Date.now(),
        }),
      );

      expect(applied).toBe(false);
      const row = await client.partnerNumber.findUniqueOrThrow({ where: { id: numberId } });
      expect(row.status).toBe("RESERVED");
      const history = await client.numberStateHistory.count({
        where: { numberId, toStatus: "AVAILABLE" },
      });
      expect(history).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Availability toggle through the real idempotent service.
  // -------------------------------------------------------------------------
  describe("Availability toggle disables then re-enables a number", () => {
    it("disables an available number (status disabled, active slot released) and re-enables it", async () => {
      const partnerId = await createPartner(client, "APPROVED");
      const deviceId = await createDevice(client, partnerId, { status: "ONLINE" });
      await createActiveOffer(client, partnerId);
      const { numberId, canonicalNumber } = await createNumber(client, partnerId, deviceId, {
        status: "AVAILABLE",
      });

      const disable = await numberService.setAvailability({
        partnerId,
        deviceId,
        numberId,
        idempotencyKey: randomUUID(),
        method: "POST",
        path: `/api/agent/v1/numbers/${numberId}/availability`,
        requestId: randomUUID(),
        requested: "disabled",
      });
      expect(disable.statusCode).toBe(200);

      const disabled = await client.partnerNumber.findUniqueOrThrow({ where: { id: numberId } });
      expect(disabled.status).toBe("DISABLED");
      expect(disabled.enabled).toBe(false);
      // The global active-canonical slot is released so another number can claim it.
      expect(disabled.activeCanonicalNumber).toBeNull();
      const disableHistory = await client.numberStateHistory.findMany({
        where: { numberId, toStatus: "DISABLED" },
      });
      expect(disableHistory).toHaveLength(1);
      expect(disableHistory[0].fromStatus).toBe("AVAILABLE");

      // Re-enable to `offline`: the number parks and re-claims its active slot.
      const reenable = await numberService.setAvailability({
        partnerId,
        deviceId,
        numberId,
        idempotencyKey: randomUUID(),
        method: "POST",
        path: `/api/agent/v1/numbers/${numberId}/availability`,
        requestId: randomUUID(),
        requested: "offline",
      });
      expect(reenable.statusCode).toBe(200);

      const reenabled = await client.partnerNumber.findUniqueOrThrow({ where: { id: numberId } });
      expect(reenabled.status).toBe("OFFLINE");
      expect(reenabled.enabled).toBe(true);
      expect(reenabled.activeCanonicalNumber).toBe(canonicalNumber);
      const reenableHistory = await client.numberStateHistory.findMany({
        where: { numberId, fromStatus: "DISABLED", toStatus: "OFFLINE" },
      });
      expect(reenableHistory).toHaveLength(1);
    });
  });
});
