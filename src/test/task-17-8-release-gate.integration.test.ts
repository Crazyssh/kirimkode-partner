import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decideEarningOnSuccess } from "@domain/task-5-6";
import { reconcilePartner, type PersistedFinding } from "@domain/task-16-4";

import {
  createPartnerDatabaseClient,
  PrismaLedgerRepository,
  PrismaReconciliationGateway,
  type PartnerDatabaseClient,
} from "@infrastructure/database";

import {
  createDisposableTestDatabase,
  type DisposableTestDatabase,
} from "./disposable-database";

/**
 * Task 17.8 — Automated MVP release-gate (Postgres-guarded seeded invariants).
 *
 * The static half of the gate lives in `task-17-8-release-gate.unit.test.ts`.
 * This half proves the same release invariants against a REAL disposable
 * PostgreSQL database migrated from empty, driving the REAL Prisma ledger
 * repository and reconciliation gateway plus the pure domain reconciler — no
 * in-memory fakes. It is skipped automatically when no admin database URL is
 * configured (the Partner-only CI checkout), mirroring the other integration
 * suites.
 *
 * It asserts, as a shippability gate:
 *   - A seeded consistent single-order flow: the ledger nets to zero and
 *     per-bucket SUM balances are conservative (Req 20.1), and the reconciler
 *     yields ZERO release-blocking issues (Req 20.2, 20.6).
 *   - An injected leak (a non-zero-sum ledger transaction that bypasses the
 *     repository guard) is caught by the reconciler as a HIGH-severity issue,
 *     and the gate treats any high-severity issue as a release blocker.
 *
 * **Validates: Requirements 20.1, 20.2, 20.6, 23.4, 23.5**
 */
const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const adminUrl = process.env.PARTNER_TEST_DATABASE_ADMIN_URL ?? "";
const hasPostgres = adminUrl.length > 0;

const PAYOUT_IDR = 1_000;
const RETAIL_PRICE_IDR = 1_400;
const PLATFORM_MARGIN_IDR = 400;
const HEARTBEAT_TIMEOUT_MS = 90_000;

/** The release-gate severity policy: high/critical issues block the release. */
const RELEASE_BLOCKING_SEVERITIES: ReadonlySet<string> = new Set(["high", "critical"]);
function releaseBlockingIssues(
  findings: readonly PersistedFinding[],
): readonly PersistedFinding[] {
  return findings.filter((finding) => RELEASE_BLOCKING_SEVERITIES.has(finding.severity));
}

async function deployFromEmpty(connectionString: string): Promise<void> {
  await execFileAsync(process.execPath, ["scripts/migrate-from-empty.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, PARTNER_MIGRATION_DATABASE_URL: connectionString },
    maxBuffer: 10 * 1024 * 1024,
  });
}

function uniqueCanonicalNumber(): string {
  let digits = "";
  for (let i = 0; i < 9; i += 1) digits += String(randomInt(0, 10));
  return `+628${digits}`;
}

/**
 * A fully consistent, terminal single-order supply for one partner: an approved
 * partner, an (offline) simulator device, an active `wa/ID/any` offer, an
 * `available` number, one SUCCESS order with its immutable snapshot, and one
 * PENDING earning at the snapshot payout. The order-success ledger event is
 * appended separately through the real ledger repository.
 */
async function seedConsistentPartner(client: PartnerDatabaseClient): Promise<{
  readonly partnerId: string;
  readonly orderId: string;
  readonly earningId: string;
}> {
  const partnerId = randomUUID();
  const now = new Date();
  await client.partner.create({
    data: {
      id: partnerId,
      legalName: "Release Gate Legal",
      displayName: "Release Gate Partner",
      status: "APPROVED",
      simulatorAllowed: true,
    },
  });

  const deviceId = randomUUID();
  await client.partnerDevice.create({
    data: {
      id: deviceId,
      partnerId,
      type: "SIMULATOR",
      label: "Sim",
      effectiveStatus: "OFFLINE",
      lastSeenAt: now,
      capabilitiesJson: { sms: true, notification: false, resend: false, operator: null, slots: 1 },
    },
  });

  const offerId = randomUUID();
  await client.partnerOffer.create({
    data: {
      id: offerId,
      partnerId,
      serviceCode: "wa",
      countryCode: "ID",
      operatorCode: "any",
      basePriceIdr: PAYOUT_IDR,
      status: "ACTIVE",
      configVersion: 1,
      activeDimensionKey: `${partnerId}:wa:ID:any`,
    },
  });

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
      status: "AVAILABLE",
      enabled: true,
    },
  });

  const orderId = randomUUID();
  await client.partnerOrder.create({
    data: {
      id: orderId,
      buyerOrderRef: `buyer-${randomUUID()}`,
      buyerAccountRef: `acct-${randomUUID()}`,
      partnerId,
      numberId,
      offerId,
      status: "SUCCESS",
      expiresAt: new Date(now.getTime() + 1_200_000),
      reservedAt: now,
      waitingAt: now,
      succeededAt: now,
      terminalAt: now,
    },
  });
  await client.orderSnapshot.create({
    data: {
      orderId,
      serviceCode: "wa",
      countryCode: "ID",
      operatorCode: "any",
      canonicalNumber,
      basePriceIdr: PAYOUT_IDR,
      retailPriceIdr: RETAIL_PRICE_IDR,
      payoutIdr: PAYOUT_IDR,
      platformMarginIdr: PLATFORM_MARGIN_IDR,
      currency: "IDR",
      configVersion: 1,
    },
  });

  const earningId = randomUUID();
  await client.partnerEarning.create({
    data: {
      id: earningId,
      partnerId,
      orderId,
      amountIdr: PAYOUT_IDR,
      status: "PENDING",
      availableAt: new Date(now.getTime() + 86_400_000),
    },
  });

  return { partnerId, orderId, earningId };
}

describe.runIf(hasPostgres)("Task 17.8 release-gate — seeded ledger + reconciliation invariants", () => {
  let database: DisposableTestDatabase;
  let client: PartnerDatabaseClient;

  beforeAll(async () => {
    database = await createDisposableTestDatabase(adminUrl);
    await deployFromEmpty(database.connectionString);
    client = createPartnerDatabaseClient({ databaseUrl: database.connectionString });
    await client.$connect();
  }, 120_000);

  afterAll(async () => {
    await client?.$disconnect();
    await database?.dispose();
  }, 30_000);

  it("keeps a seeded consistent flow zero-sum, conservative, and issue-free", async () => {
    const { partnerId, orderId } = await seedConsistentPartner(client);
    const ledger = new PrismaLedgerRepository(client);

    // Append the order-success event through the REAL ledger repository, using
    // the pure domain builder — payable -1000, pending +1000.
    const decision = decideEarningOnSuccess({
      earningId: randomUUID(),
      orderId,
      payoutIdr: PAYOUT_IDR,
      succeededAt: new Date(),
      earningExistsForOrder: false,
    });
    if (decision.kind !== "create") throw new Error("expected earning creation");
    await client.$transaction(async (tx) => {
      await ledger.appendTransaction(tx, { partnerId, transaction: decision.transaction });
    });

    // Zero-sum + conservation: money leaves payable and rests in pending.
    const balances = await ledger.computeBucketBalances(partnerId);
    expect(balances.platform_partner_payable).toBe(-PAYOUT_IDR);
    expect(balances.partner_pending).toBe(PAYOUT_IDR);
    expect(balances.partner_available).toBe(0);
    expect(balances.partner_payout_locked).toBe(0);
    expect(balances.partner_paid).toBe(0);
    expect(balances.partner_reversed).toBe(0);
    expect(Object.values(balances).reduce((total, value) => total + value, 0)).toBe(0);

    // The reconciler, reading the REAL persisted state, finds no issues at all.
    const gateway = new PrismaReconciliationGateway(client);
    const state = await gateway.loadPartnerState(partnerId);
    const findings = reconcilePartner({
      ...state,
      nowEpochMs: Date.now(),
      heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    });
    expect(findings).toHaveLength(0);
    expect(releaseBlockingIssues(findings)).toHaveLength(0);
  }, 30_000);

  it("catches an injected ledger leak as a high-severity release blocker", async () => {
    const partnerId = randomUUID();
    await client.partner.create({
      data: {
        id: partnerId,
        legalName: "Leak Legal",
        displayName: "Leak Partner",
        status: "APPROVED",
        simulatorAllowed: true,
      },
    });

    // Bypass the repository's zero-sum guard to persist a leaking transaction
    // (entries sum to -100) — the exact corruption the release-gate must catch.
    const leakingTransaction = await client.ledgerTransaction.create({
      data: {
        partnerId,
        eventType: "ORDER_SUCCESS",
        eventKey: `order-success:leak-${randomUUID()}`,
        referenceType: "order",
        referenceId: randomUUID(),
      },
    });
    await client.ledgerEntry.createMany({
      data: [
        { transactionId: leakingTransaction.id, partnerId, bucket: "PLATFORM_PARTNER_PAYABLE", amountIdrSigned: -1_000 },
        { transactionId: leakingTransaction.id, partnerId, bucket: "PARTNER_PENDING", amountIdrSigned: 900 },
      ],
    });

    const gateway = new PrismaReconciliationGateway(client);
    const state = await gateway.loadPartnerState(partnerId);
    const findings = reconcilePartner({
      ...state,
      nowEpochMs: Date.now(),
      heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    });

    const blockers = releaseBlockingIssues(findings);
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.some((issue) => issue.type === "ledger_imbalance")).toBe(true);
  }, 30_000);
});
