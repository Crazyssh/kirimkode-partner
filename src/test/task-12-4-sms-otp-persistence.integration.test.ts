import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  encryptInboundSms,
  SmsIngestionService,
  SmsOwnershipMismatchError,
  type IngestSmsInput,
} from "@application/sms";
import {
  createPartnerDatabaseClient,
  PrismaIdempotencyTransactionRunner,
  PrismaPartnerSmsGateway,
  PrismaPartnerSmsMatchingGateway,
  type PartnerDatabaseClient,
  type PartnerTransactionClient,
} from "@infrastructure/database";
import { SmsOtpCipher } from "@infrastructure/crypto/sms-otp-cipher";
import { CryptoIdGenerator, SystemClock } from "@infrastructure/auth/system-clock";

import {
  createDisposableTestDatabase,
  type DisposableTestDatabase,
} from "./disposable-database";

/**
 * Task 12.4 — end-to-end SMS/OTP persistence integration tests.
 *
 * These exercise the real task 12.2 ingestion pipeline against a disposable
 * PostgreSQL database, wiring the production Prisma gateways
 * ({@link PrismaPartnerSmsGateway}, {@link PrismaPartnerSmsMatchingGateway}), the
 * real `$transaction` runner, and the real AES-256-GCM {@link SmsOtpCipher} — no
 * in-memory fakes. Each behaviour the pure/adapter unit tests pin (domain
 * parser/matcher, cipher, gateway) is re-verified through the whole stack and
 * against the committed rows, so the encryption envelope, the unique
 * constraints, the tenant scoping, the exactly-one matching, and the redaction
 * guarantees hold together on real storage.
 *
 * The listening window is covered here too, because its rules are enforced by the
 * adapter's compare-and-set rather than by the pure matcher: a success keeps its
 * number hold, a repeat SMS inside the open window rewrites the OTP without
 * touching money or the audit trail, and a `completedAt`-stamped order stops
 * matching altogether.
 *
 * Complements the unit suites rather than duplicating them:
 *  - Ciphertext / key version / rotation: `sms-otp-cipher.unit.test.ts`.
 *  - Parser keyword/candidate/Unicode/decoy/ambiguity: `sms-matching-otp.unit.test.ts`.
 *  - Oversized (>4 KiB) body + error redaction at the transport edge:
 *    `agent-sms-endpoint.unit.test.ts` (the ingestion service is size-agnostic;
 *    the endpoint enforces `AGENT_SMS_MAX_BODY_BYTES` before it is called).
 *
 * **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 11.7, 13.7, 19.6**
 */
const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const adminUrl = process.env.PARTNER_TEST_DATABASE_ADMIN_URL ?? "";
const hasPostgres = adminUrl.length > 0;

/** A deterministic test AES key/version for the SMS/OTP envelope. */
const CIPHER_KEY_VERSION = 3;
const cipher = new SmsOtpCipher({
  current: { version: CIPHER_KEY_VERSION, key: Buffer.alloc(32, 0x2a).toString("base64url") },
});

const MVP_PAYOUT_IDR = 1_000;
const OTP = "123456";
const MATCHING_BODY = `Your WhatsApp code is ${OTP}`;
const SENDER = "WhatsAppBusiness";

/** The resend: same shape, different code — what the listening window exists for. */
const REPEAT_OTP = "654123";
const REPEAT_BODY = `Your WhatsApp code is ${REPEAT_OTP}`;

async function deployFromEmpty(connectionString: string): Promise<void> {
  await execFileAsync(process.execPath, ["scripts/migrate-from-empty.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, PARTNER_MIGRATION_DATABASE_URL: connectionString },
    maxBuffer: 10 * 1024 * 1024,
  });
}

/** The immutable MVP platform config the matching pipeline reads (mirrors seed.sql). */
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

function createIngestionService(client: PartnerDatabaseClient): SmsIngestionService<PartnerTransactionClient> {
  return new SmsIngestionService<PartnerTransactionClient>({
    runner: new PrismaIdempotencyTransactionRunner(client),
    smsGateway: new PrismaPartnerSmsGateway(),
    matchingGateway: new PrismaPartnerSmsMatchingGateway(),
    cipher,
    clock: new SystemClock(),
    idGenerator: new CryptoIdGenerator(),
  });
}

/** A fresh, unique canonical Indonesian E.164 number ("+62..."), <= 20 chars. */
function uniqueCanonicalNumber(): string {
  // Canonical rule: `+628` then a NON-ZERO digit, then 8 more. Drawing the
  // first digit from 0-9 produced `+6280…` roughly one run in ten, which the
  // domain rightly rejects — a self-inflicted flake, not a product bug.
  let digits = String(randomInt(1, 10));
  for (let i = 0; i < 8; i += 1) digits += String(randomInt(0, 10));
  return `+628${digits}`;
}

// ---------------------------------------------------------------------------
// Fixture seeding (raw client): an approved partner, an online simulator
// device, an active offer, a number, and — optionally — a `waiting_sms` order.
// ---------------------------------------------------------------------------
async function createApprovedPartner(client: PartnerDatabaseClient): Promise<string> {
  const id = randomUUID();
  await client.partner.create({
    data: {
      id,
      legalName: "SMS Integration Legal",
      displayName: "SMS Integration Partner",
      status: "APPROVED",
      simulatorAllowed: true,
    },
  });
  return id;
}

/** An online simulator device with a fresh heartbeat, so when the listening
 * window is eventually closed the number lands back on `available` rather than
 * `offline`. */
async function createOnlineDevice(client: PartnerDatabaseClient, partnerId: string): Promise<string> {
  const id = randomUUID();
  await client.partnerDevice.create({
    data: {
      id,
      partnerId,
      type: "SIMULATOR",
      label: "Sim",
      effectiveStatus: "ONLINE",
      lastSeenAt: new Date(),
      capabilitiesJson: { sms: true, notification: false, resend: false, operator: null, slots: 1 },
    },
  });
  return id;
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
      basePriceIdr: MVP_PAYOUT_IDR,
      status: "ACTIVE",
      configVersion: 1,
      activeDimensionKey: `${partnerId}:wa:ID:any`,
    },
  });
  return id;
}

interface Supply {
  readonly partnerId: string;
  readonly deviceId: string;
  readonly offerId: string;
  readonly numberId: string;
  readonly canonicalNumber: string;
}

/** Approved partner + online device + active offer + one registered number. */
async function seedSupply(client: PartnerDatabaseClient): Promise<Supply> {
  const partnerId = await createApprovedPartner(client);
  const deviceId = await createOnlineDevice(client, partnerId);
  const offerId = await createActiveOffer(client, partnerId);
  const numberId = randomUUID();
  const canonicalNumber = uniqueCanonicalNumber();
  await client.partnerNumber.create({
    data: {
      id: numberId,
      partnerId,
      deviceId,
      canonicalNumber,
      activeCanonicalNumber: canonicalNumber,
      countryCode: "ID",
      operatorCode: "any",
      status: "BUSY",
      enabled: true,
    },
  });
  return { partnerId, deviceId, offerId, numberId, canonicalNumber };
}

/** Create a `waiting_sms` order on the supply's number whose window contains now. */
async function seedWaitingOrder(
  client: PartnerDatabaseClient,
  supply: Supply,
  options: { readonly bindCurrentOrder?: boolean } = {},
): Promise<string> {
  const orderId = randomUUID();
  const now = Date.now();
  await client.partnerOrder.create({
    data: {
      id: orderId,
      buyerOrderRef: `buyer-${orderId}`,
      buyerAccountRef: `acct-${randomUUID()}`,
      partnerId: supply.partnerId,
      numberId: supply.numberId,
      offerId: supply.offerId,
      status: "WAITING_SMS",
      waitingAt: new Date(now - 60_000),
      reservedAt: new Date(now - 120_000),
      expiresAt: new Date(now + 20 * 60_000),
      version: 1,
    },
  });
  await client.orderSnapshot.create({
    data: {
      orderId,
      serviceCode: "wa",
      countryCode: "ID",
      operatorCode: "any",
      canonicalNumber: supply.canonicalNumber,
      basePriceIdr: MVP_PAYOUT_IDR,
      retailPriceIdr: 1_400,
      payoutIdr: MVP_PAYOUT_IDR,
      platformMarginIdr: 400,
      currency: "IDR",
      configVersion: 1,
    },
  });
  // The success compare-and-set requires the number to be `busy` and bound to
  // this order via `currentOrderId`.
  if (options.bindCurrentOrder !== false) {
    await client.partnerNumber.update({
      where: { id: supply.numberId },
      data: { currentOrderId: orderId, status: "BUSY" },
    });
  }
  return orderId;
}

function ingestInput(supply: Supply, overrides: Partial<IngestSmsInput> = {}): IngestSmsInput {
  return {
    principal: { partnerId: supply.partnerId, deviceId: supply.deviceId },
    numberId: supply.numberId,
    messageId: randomUUID(),
    idempotencyKey: randomUUID(),
    sender: SENDER,
    body: MATCHING_BODY,
    receivedAtDeviceEpochMs: Date.now() - 2_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
describe.runIf(hasPostgres)("SMS/OTP persistence integration (task 12.4)", () => {
  let database: DisposableTestDatabase;
  let client: PartnerDatabaseClient;
  let service: SmsIngestionService<PartnerTransactionClient>;

  beforeAll(async () => {
    database = await createDisposableTestDatabase(adminUrl);
    await deployFromEmpty(database.connectionString);
    client = createPartnerDatabaseClient({ databaseUrl: database.connectionString });
    await client.$connect();
    await client.platformConfig.create({ data: platformConfigData(1, "mvp-active") });
    service = createIngestionService(client);
  }, 120_000);

  afterAll(async () => {
    await client?.$disconnect();
    await database?.dispose();
  }, 30_000);

  // Requirements 11.1, 11.2, 11.4, 11.7, 19.6: exactly one order matches, the
  // `wa` parser extracts a single OTP, the SMS/OTP are stored encrypted (never
  // plaintext), the correct key version is persisted, and the order succeeds
  // with exactly one pending Earning and a zero-sum ledger event.
  describe("Matched success stores encrypted SMS/OTP and never plaintext", () => {
    it("persists ciphertext-only rows, the key version, and the retained number hold", async () => {
      const supply = await seedSupply(client);
      const orderId = await seedWaitingOrder(client, supply);
      const input = ingestInput(supply);

      const result = await service.ingest(input);

      expect(result.status).toBe("matched");
      if (result.status !== "matched") throw new Error("unreachable");
      expect(result.orderId).toBe(orderId);
      // Redaction: the returned view carries no ciphertext / plaintext / OTP.
      expect(Object.keys(result.sms)).not.toContain("bodyCiphertext");
      expect(Object.keys(result.sms)).not.toContain("senderCiphertext");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(OTP);
      expect(serialized).not.toContain("WhatsApp");

      // The persisted SMS row: sender + body are AES-GCM ciphertext (Bytes),
      // never the plaintext, and stamped with the active key version.
      const sms = await client.partnerSms.findUniqueOrThrow({ where: { id: result.sms.id } });
      expect(sms.keyVersion).toBe(CIPHER_KEY_VERSION);
      expect(sms.matchStatus).toBe("MATCHED");
      expect(sms.matchedOrderId).toBe(orderId);
      expect(sms.extractedAt).not.toBeNull();
      const bodyBytes = Buffer.from(sms.bodyCiphertext);
      const senderBytes = Buffer.from(sms.senderCiphertext);
      expect(bodyBytes.toString("utf8")).not.toContain(OTP);
      expect(bodyBytes.toString("utf8")).not.toContain("WhatsApp");
      expect(senderBytes.toString("utf8")).not.toContain(SENDER);
      // Round-trips back to the original plaintext through the same cipher.
      expect(await cipher.decrypt({ ciphertext: bodyBytes, keyVersion: sms.keyVersion })).toBe(
        MATCHING_BODY,
      );
      expect(await cipher.decrypt({ ciphertext: senderBytes, keyVersion: sms.keyVersion })).toBe(
        SENDER,
      );

      // The order stores the encrypted OTP with its key version + fingerprint.
      const order = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe("SUCCESS");
      // A success is a terminal disposition, so `applySuccess` itself stamps
      // `terminalAt` (the waiting order was seeded without one) equal to
      // `succeededAt`. The OTP retention job keys off `terminalAt`, so a missing
      // stamp would strand the decrypted OTP past the 24h window (req 19.5).
      expect(order.succeededAt).not.toBeNull();
      expect(order.terminalAt).not.toBeNull();
      expect(order.terminalAt?.getTime()).toBe(order.succeededAt?.getTime());
      expect(order.otpKeyVersion).toBe(CIPHER_KEY_VERSION);
      expect(order.otpFingerprint).toBe(cipher.fingerprint(OTP));
      const otpBytes = Buffer.from(order.otpCiphertext ?? Buffer.alloc(0));
      expect(otpBytes.length).toBeGreaterThan(0);
      expect(otpBytes.toString("utf8")).not.toContain(OTP);
      expect(await cipher.decrypt({ ciphertext: otpBytes, keyVersion: order.otpKeyVersion ?? 0 })).toBe(
        OTP,
      );

      // Exactly one pending Earning at the snapshot payout.
      const earnings = await client.partnerEarning.findMany({ where: { orderId } });
      expect(earnings).toHaveLength(1);
      expect(earnings[0].amountIdr).toBe(MVP_PAYOUT_IDR);
      expect(earnings[0].status).toBe("PENDING");

      // The zero-sum `order-success` ledger transaction.
      const ledger = await client.ledgerTransaction.findFirstOrThrow({
        where: { eventKey: `order-success:${orderId}` },
        include: { entries: true },
      });
      expect(ledger.entries).toHaveLength(2);
      const sum = ledger.entries.reduce((total, entry) => total + entry.amountIdrSigned, 0);
      expect(sum).toBe(0);

      // The number hold OUTLIVES the success: `completedAt` is unset, so the
      // order is still listening for a repeat code and keeps the number BUSY and
      // bound to itself. Releasing here (as success used to) would put the number
      // back on sale while a resent code for this buyer is still in flight, which
      // is exactly how a repeat OTP gets misdelivered to the next buyer.
      expect(order.completedAt).toBeNull();
      const number = await client.partnerNumber.findUniqueOrThrow({ where: { id: supply.numberId } });
      expect(number.status).toBe("BUSY");
      expect(number.currentOrderId).toBe(orderId);
    });
  });

  // Requirements 11.7, 13.7: while a successful order is still listening (hold
  // not released, window open) a further SMS on its number matches the SAME
  // order and refreshes the OTP only. Once the hold IS released the order stops
  // matching entirely — the pipeline fails closed rather than reviving a closed
  // window. Both halves are asserted against the REAL Prisma gateway, because
  // the compare-and-set that enforces them (`status = SUCCESS AND completedAt IS
  // NULL`) lives in the adapter, not in the pure matcher.
  describe("Repeat OTP inside the listening window refreshes the code only", () => {
    it("rewrites the OTP without a second Earning or a new order transition", async () => {
      const supply = await seedSupply(client);
      const orderId = await seedWaitingOrder(client, supply);

      const first = await service.ingest(ingestInput(supply));
      expect(first.status).toBe("matched");
      const afterFirst = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
      const transitionsAfterFirst = await client.orderTransition.count({ where: { orderId } });
      // The first extract IS a status edge, so it recorded exactly one transition.
      expect(transitionsAfterFirst).toBe(1);

      const repeat = await service.ingest(ingestInput(supply, { body: REPEAT_BODY }));

      expect(repeat.status).toBe("matched");
      if (repeat.status !== "matched") throw new Error("unreachable");
      expect(repeat.orderId).toBe(orderId);
      expect(repeat.mode).toBe("repeat");

      // The stored OTP is the NEWER code: fingerprint and ciphertext both moved,
      // and the envelope is still stamped with the active key version.
      const order = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.otpFingerprint).toBe(cipher.fingerprint(REPEAT_OTP));
      expect(order.otpFingerprint).not.toBe(afterFirst.otpFingerprint);
      expect(Buffer.from(order.otpCiphertext ?? Buffer.alloc(0)).equals(
        Buffer.from(afterFirst.otpCiphertext ?? Buffer.alloc(0)),
      )).toBe(false);
      expect(order.otpKeyVersion).toBe(CIPHER_KEY_VERSION);
      expect(
        await cipher.decrypt({
          ciphertext: Buffer.from(order.otpCiphertext ?? Buffer.alloc(0)),
          keyVersion: order.otpKeyVersion ?? 0,
        }),
      ).toBe(REPEAT_OTP);

      // Status untouched and the hold still open — the order goes on listening.
      expect(order.status).toBe("SUCCESS");
      expect(order.completedAt).toBeNull();
      expect(order.succeededAt?.getTime()).toBe(afterFirst.succeededAt?.getTime());

      // Money is created exactly once per order: no second Earning.
      const earnings = await client.partnerEarning.findMany({ where: { orderId } });
      expect(earnings).toHaveLength(1);
      expect(earnings[0].amountIdr).toBe(MVP_PAYOUT_IDR);

      // The repeat SMS is bound to the same order for audit…
      const sms = await client.partnerSms.findUniqueOrThrow({ where: { id: repeat.sms.id } });
      expect(sms.matchStatus).toBe("MATCHED");
      expect(sms.matchedOrderId).toBe(orderId);
      expect(sms.extractedAt).not.toBeNull();
      // …but NO new `order_transitions` row: that table records status edges, and
      // a repeat deliberately changes no status. A row here would forge a
      // success→success edge in the audit trail.
      expect(await client.orderTransition.count({ where: { orderId } })).toBe(1);
    });

    it("stores a post-completion SMS unmatched and never overwrites the delivered OTP", async () => {
      const supply = await seedSupply(client);
      const orderId = await seedWaitingOrder(client, supply);
      const first = await service.ingest(ingestInput(supply));
      expect(first.status).toBe("matched");

      // Close the window the way buyer completion / the expiry sweep does: stamp
      // `completedAt`. From here the order holds nothing, so it must stop being a
      // matching candidate — otherwise a late resend would keep rewriting an OTP
      // the buyer has already consumed.
      await client.partnerOrder.update({
        where: { id: orderId },
        data: { completedAt: new Date() },
      });
      const beforeLate = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });

      const late = await service.ingest(ingestInput(supply, { body: REPEAT_BODY }));

      expect(late.status).toBe("unmatched");
      if (late.status !== "unmatched") throw new Error("unreachable");
      expect(late.reason).toBe("no_active_order");
      const sms = await client.partnerSms.findUniqueOrThrow({ where: { id: late.sms.id } });
      expect(sms.matchStatus).toBe("UNMATCHED");
      expect(sms.matchedOrderId).toBeNull();
      expect(sms.extractedAt).toBeNull();

      // The delivered OTP is exactly as completion left it.
      const order = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.otpFingerprint).toBe(cipher.fingerprint(OTP));
      expect(order.otpFingerprint).toBe(beforeLate.otpFingerprint);
      expect(Buffer.from(order.otpCiphertext ?? Buffer.alloc(0)).equals(
        Buffer.from(beforeLate.otpCiphertext ?? Buffer.alloc(0)),
      )).toBe(true);
      expect(order.status).toBe("SUCCESS");
      expect(await client.partnerEarning.count({ where: { orderId } })).toBe(1);
    });
  });

  // Requirement 11.3: a replay on `(deviceId, messageId)` or
  // `(deviceId, idempotencyKey)` resolves to `duplicate` on the real unique
  // constraints — never a second row, a second OTP, or a second Earning.
  describe("Duplicate retry is idempotent at the database layer", () => {
    it("resolves a messageId replay to duplicate without a second effect", async () => {
      const supply = await seedSupply(client);
      const orderId = await seedWaitingOrder(client, supply);
      const first = ingestInput(supply);

      const matched = await service.ingest(first);
      expect(matched.status).toBe("matched");

      // Same messageId, different idempotency key -> messageId unique wins.
      const replay = await service.ingest(ingestInput(supply, { messageId: first.messageId }));
      expect(replay).toEqual({ status: "duplicate", matchedBy: "message_id" });

      const rows = await client.partnerSms.findMany({
        where: { deviceId: supply.deviceId, messageId: first.messageId },
      });
      expect(rows).toHaveLength(1);
      const earnings = await client.partnerEarning.count({ where: { orderId } });
      expect(earnings).toBe(1);
    });

    it("resolves an idempotencyKey replay to duplicate", async () => {
      const supply = await seedSupply(client);
      await seedWaitingOrder(client, supply);
      const first = ingestInput(supply);

      await service.ingest(first);
      const replay = await service.ingest(
        ingestInput(supply, { idempotencyKey: first.idempotencyKey }),
      );
      expect(replay).toEqual({ status: "duplicate", matchedBy: "idempotency_key" });

      const rows = await client.partnerSms.count({
        where: { deviceId: supply.deviceId, idempotencyKey: first.idempotencyKey },
      });
      expect(rows).toBe(1);
    });
  });

  // Requirement 11.1: an SMS whose device/number are not owned by the trusted
  // tenant is rejected before anything is persisted (opaque ownership mismatch).
  describe("Cross-tenant ownership is rejected before persistence", () => {
    it("rejects an SMS for another tenant's number and stores nothing", async () => {
      const tenantA = await seedSupply(client);
      const foreignPartnerId = await createApprovedPartner(client);
      const input = ingestInput(tenantA, {
        principal: { partnerId: foreignPartnerId, deviceId: tenantA.deviceId },
      });

      await expect(service.ingest(input)).rejects.toBeInstanceOf(SmsOwnershipMismatchError);

      const rows = await client.partnerSms.count({
        where: { deviceId: tenantA.deviceId, messageId: input.messageId },
      });
      expect(rows).toBe(0);
    });
  });

  // Requirements 11.4, 11.5: zero or multiple matching orders never deliver an
  // OTP; the SMS is stored for audit and no order is mutated.
  describe("No-order and multi-order cardinality never misdeliver", () => {
    it("stores unmatched with no OTP when zero orders are active", async () => {
      const supply = await seedSupply(client);
      const input = ingestInput(supply);

      const result = await service.ingest(input);

      expect(result.status).toBe("unmatched");
      if (result.status !== "unmatched") throw new Error("unreachable");
      expect(result.reason).toBe("no_active_order");
      const sms = await client.partnerSms.findUniqueOrThrow({ where: { id: result.sms.id } });
      expect(sms.matchStatus).toBe("UNMATCHED");
      expect(sms.matchedOrderId).toBeNull();
      expect(sms.extractedAt).toBeNull();
      const earnings = await client.partnerEarning.count({ where: { partnerId: supply.partnerId } });
      expect(earnings).toBe(0);
    });

    it("audits an ambiguous SMS with no OTP; the one-active-per-number invariant precludes a multi-order match", async () => {
      // The `wa` matcher only reports `ambiguous` when more than one `waiting_sms`
      // order shares the SMS's number — a cardinality pinned by the pure-domain
      // suites (`sms-matching-otp.unit.test.ts`, task-5-23 property). Production
      // storage forbids that state: `partner_orders_one_active_per_number` (a
      // partial-unique index on numberId WHERE status IN created/reserved/
      // waiting_sms) rejects a second active order on a number, and the candidate
      // loader is scoped to the SMS's numberId, so the full pipeline can never
      // observe a multi-order match. We assert both halves against real storage:
      // the invariant that makes ambiguity unreachable, then the exact no-OTP
      // disposition the ingestion service applies when a match *is* ambiguous.
      const supply = await seedSupply(client);
      const orderId = await seedWaitingOrder(client, supply);

      // A second active order on the same number is rejected by the invariant —
      // this is precisely why the pipeline can never see two matching candidates.
      await expect(
        seedWaitingOrder(client, supply, { bindCurrentOrder: false }),
      ).rejects.toThrow(/[Uu]nique constraint/);

      // Drive the production ambiguous branch's persistence seam directly — the
      // real encrypted-SMS insert plus `markSmsAudited("ambiguous")` — atomically
      // through the same interactive transaction runner the service uses. This is
      // the identical effect `SmsIngestionService` runs on `match.status ===
      // "ambiguous"`, minus the (unreachable) two-candidate match decision.
      const runner = new PrismaIdempotencyTransactionRunner(client);
      const smsGateway = new PrismaPartnerSmsGateway();
      const matchingGateway = new PrismaPartnerSmsMatchingGateway();
      const nowEpochMs = Date.now();
      const encrypted = encryptInboundSms(cipher, { sender: SENDER, body: MATCHING_BODY });

      const smsId = await runner.run(async (tx) => {
        const insert = await smsGateway.insertEncryptedSms(tx, supply.partnerId, {
          id: randomUUID(),
          deviceId: supply.deviceId,
          numberId: supply.numberId,
          messageId: randomUUID(),
          idempotencyKey: randomUUID(),
          senderCiphertext: encrypted.senderCiphertext,
          bodyCiphertext: encrypted.bodyCiphertext,
          keyVersion: encrypted.keyVersion,
          bodyFingerprint: encrypted.bodyFingerprint,
          receivedAtDeviceEpochMs: nowEpochMs - 2_000,
        });
        if (insert.kind !== "inserted") throw new Error("unreachable");
        await matchingGateway.markSmsAudited(tx, {
          smsId: insert.sms.id,
          matchStatus: "ambiguous",
          nowEpochMs,
        });
        return insert.sms.id;
      });

      // The SMS is audited AMBIGUOUS, bound to no order, and carries no OTP.
      const sms = await client.partnerSms.findUniqueOrThrow({ where: { id: smsId } });
      expect(sms.matchStatus).toBe("AMBIGUOUS");
      expect(sms.matchedOrderId).toBeNull();
      expect(sms.extractedAt).toBeNull();
      // The number's single waiting order was not mutated and no Earning exists.
      const order = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe("WAITING_SMS");
      expect(order.otpKeyVersion).toBeNull();
      const earnings = await client.partnerEarning.count({ where: { partnerId: supply.partnerId } });
      expect(earnings).toBe(0);
    });
  });

  // Requirement 11.7: for the single matched order, a keyword-less / decoy /
  // Unicode-digit / multi-candidate body is stored `unmatched` with no OTP and
  // the order left in `waiting_sms` — the generic fallback stays off.
  describe("Parser rejections store audit-only SMS without misdelivery", () => {
    const rejections: ReadonlyArray<readonly [label: string, body: string, reason: string]> = [
      ["missing keyword", `your number is ${OTP}`, "missing_keyword"],
      ["labelled decoy", `WhatsApp verification. phone: ${OTP}`, "decoy_candidate"],
      ["unicode digits", "WhatsApp code \uFF11\uFF12\uFF13\uFF14\uFF15\uFF16", "no_candidate"],
      ["multiple candidates", "WhatsApp code 123456, backup 654321", "ambiguous_candidates"],
    ];

    for (const [label, body, reason] of rejections) {
      it(`rejects a ${label} body without delivering an OTP`, async () => {
        const supply = await seedSupply(client);
        const orderId = await seedWaitingOrder(client, supply);

        const result = await service.ingest(ingestInput(supply, { body }));

        expect(result.status).toBe("unmatched");
        if (result.status !== "unmatched") throw new Error("unreachable");
        expect(result.reason).toBe(reason);
        const sms = await client.partnerSms.findUniqueOrThrow({ where: { id: result.sms.id } });
        expect(sms.matchStatus).toBe("UNMATCHED");
        expect(sms.matchedOrderId).toBeNull();
        // Body stored encrypted for audit; never plaintext.
        expect(Buffer.from(sms.bodyCiphertext).toString("utf8")).not.toContain(body);
        // The order is untouched and no Earning exists.
        const order = await client.partnerOrder.findUniqueOrThrow({ where: { id: orderId } });
        expect(order.status).toBe("WAITING_SMS");
        expect(order.otpKeyVersion).toBeNull();
        expect(await client.partnerEarning.count({ where: { orderId } })).toBe(0);
      });
    }
  });
});
