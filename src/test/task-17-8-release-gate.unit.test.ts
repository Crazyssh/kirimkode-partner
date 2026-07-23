import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createPartnerBackupPlan } from "../../scripts/backup-partner-db.mjs";
import { createPartnerRestorePlan } from "../../scripts/restore-partner-db.mjs";
import {
  PARTNER_DATABASE_NAME,
  PARTNER_PROCESS_NAME,
} from "../../scripts/lib/partner-target-guards.mjs";

import {
  assertZeroSumEntries,
  computeBalancesFromTransactions,
  createLedgerTransaction,
  isLedgerBalanced,
  LEDGER_BUCKETS,
  PAYOUT_METHOD,
  PAYOUT_MINIMUM_IDR,
  decideEarningOnSuccess,
  decideHoldRelease,
  decideRequestPayout,
  decidePayoutTransition,
  type EarningState,
  type LedgerTransaction,
} from "@domain/task-5-6";
import { reconcilePartner, type PersistedFinding } from "@domain/task-16-4";
import { DEVICE_TYPES, decideDeviceCreation } from "@domain/task-5-7/simulator";
import { decidePlutoPolicy } from "@domain/task-5-3/private-beta-policy";

/**
 * Task 17.8 — Automated MVP release-gate (static + pure invariants).
 *
 * This suite is the shippability gate for the Partner MVP: an automated,
 * dependency-free assertion that the release-blocking invariants hold. It is
 * split from the Postgres-guarded seeded flow
 * (`task-17-8-release-gate.integration.test.ts`) exactly like task 17.5 splits
 * static/config checks from the integration suites. Everything here runs with
 * no PostgreSQL, no network, and no external hardware, parsing the REAL scripts
 * and config and driving the REAL domain builders rather than duplicating
 * logic.
 *
 * The gate asserts five release conditions:
 *   1. The backup/restore drill targets ONLY `kirimkode_partner` and refuses
 *      any Main (`kirimkode`) target or PM2/process of the Main platform.
 *   2. Every ledger transaction nets to zero and per-bucket SUM balances are
 *      conservative (the ledger is the single source of monetary truth).
 *   3. A clean/consistent dataset yields zero reconciliation issues, and any
 *      high-severity issue is treated as a release blocker.
 *   4. The acceptance scope is simulator-only `wa/ID/any` with no live
 *      APK/modem/GoIP/direct supplier API/payment-gateway dependency.
 *   5. MVP acceptance (reserve → SMS → OTP → earning → payout) depends on none
 *      of APK/modem/GoIP/public direct API/automatic payout — the only payout
 *      method is `bank_transfer_manual`.
 *
 * **Validates: Requirements 20.1, 20.2, 20.6, 23.4, 23.5**
 */

const partnerRoot = fileURLToPath(new URL("../../", import.meta.url));

function partnerFile(relativePath: string): string {
  return readFileSync(path.join(partnerRoot, relativePath), "utf8");
}

/** A Partner-only database URL (the app role scoped to `kirimkode_partner`). */
const partnerDatabaseUrl =
  "postgresql://kirimkode_partner_app:secret@127.0.0.1:5432/kirimkode_partner?sslmode=require";
/** A Main-platform database URL the gate must refuse everywhere. */
const mainDatabaseUrl = "postgresql://kirimkode_partner_app:secret@127.0.0.1:5432/kirimkode";

/**
 * The release-gate severity policy: a `high` or `critical` reconciliation issue
 * blocks the release (design section 12 alert "ledger imbalance > 0"). This is
 * the predicate the automated gate uses to turn detected issues into a ship /
 * no-ship decision.
 */
const RELEASE_BLOCKING_SEVERITIES: ReadonlySet<string> = new Set(["high", "critical"]);

function releaseBlockingIssues(
  findings: readonly PersistedFinding[],
): readonly PersistedFinding[] {
  return findings.filter((finding) => RELEASE_BLOCKING_SEVERITIES.has(finding.severity));
}

// ---------------------------------------------------------------------------
// 1. Backup/restore drill isolation (Req 20.1)
// ---------------------------------------------------------------------------
describe("Task 17.8 gate — backup/restore drill never touches Main (Req 20.1)", () => {
  const backupRoot = path.join(partnerRoot, "backups", PARTNER_PROCESS_NAME);

  it("plans a Partner-only backup and refuses a Main database target", () => {
    const plan = createPartnerBackupPlan(
      { PARTNER_DATABASE_URL: partnerDatabaseUrl, PARTNER_BACKUP_ROOT: backupRoot },
      new Date("2026-01-01T01:02:03.000Z"),
    );
    // The plan is a pg_dump of the Partner DB into the Partner backup root only.
    expect(plan.artifact).toBe(
      path.join(backupRoot, "kirimkode_partner_20260101T010203Z.dump"),
    );
    expect(plan.command).toBe("pg_dump");
    // The gate asserts the PLAN, never running a real dump.
    expect(() =>
      createPartnerBackupPlan(
        { PARTNER_DATABASE_URL: mainDatabaseUrl, PARTNER_BACKUP_ROOT: backupRoot },
        new Date("2026-01-01T01:02:03.000Z"),
      ),
    ).toThrow(`database target other than ${PARTNER_DATABASE_NAME}`);
  });

  it("requires explicit confirmation and refuses a Main restore target", () => {
    const artifact = path.join(backupRoot, "kirimkode_partner_20260101T010203Z.dump");
    // No PARTNER_RESTORE_CONFIRM => abort before touching any database.
    expect(() =>
      createPartnerRestorePlan(artifact, {
        PARTNER_DATABASE_URL: partnerDatabaseUrl,
        PARTNER_BACKUP_ROOT: backupRoot,
      }),
    ).toThrow(`Restore requires PARTNER_RESTORE_CONFIRM=${PARTNER_DATABASE_NAME}`);
    // A Main target is refused even with a (wrong) confirmation value.
    expect(() =>
      createPartnerRestorePlan(artifact, {
        PARTNER_DATABASE_URL: mainDatabaseUrl,
        PARTNER_BACKUP_ROOT: backupRoot,
        PARTNER_RESTORE_CONFIRM: "kirimkode",
      }),
    ).toThrow(`database target other than ${PARTNER_DATABASE_NAME}`);
  });

  it("keeps the backup/restore scripts free of any Main DB or PM2/process reference", () => {
    const backupScript = partnerFile("scripts/backup-partner-db.mjs");
    const restoreScript = partnerFile("scripts/restore-partner-db.mjs");
    const guards = partnerFile("scripts/lib/partner-target-guards.mjs");
    // A bare Main database `kirimkode` (not `kirimkode_partner`/`kirimkode-partner`).
    const bareMain = /kirimkode(?![_-]partner)/;
    // Neither drill script names the Main DB, nor drives PM2 / restarts a process.
    for (const source of [backupScript, restoreScript]) {
      expect(source).not.toMatch(bareMain);
      expect(source).not.toMatch(/\bpm2\b|reload|restart|\bkill\b/i);
      expect(source).not.toMatch(/\bkirimkode-main\b|\bmain-platform\b/);
    }
    // The only database name the guards accept is the Partner DB.
    expect(guards).toContain(`export const PARTNER_DATABASE_NAME = "${PARTNER_DATABASE_NAME}"`);
    expect(guards).toContain("Refusing database target other than ${PARTNER_DATABASE_NAME}");
  });
});

// ---------------------------------------------------------------------------
// 2. Ledger zero-sum + conservation invariant (Req 20.1)
// ---------------------------------------------------------------------------
describe("Task 17.8 gate — ledger zero-sum + conservation (Req 20.1)", () => {
  const HOLD_MS = 24 * 60 * 60 * 1000;

  /** Build the full lifecycle transaction sequence for a Rp1.000 payout. */
  function fullLifecycleTransactions(): readonly LedgerTransaction[] {
    const orderId = "order-1";
    const earningId = "earning-1";
    const payoutId = "payout-1";
    const succeededAt = new Date("2026-01-01T00:00:00.000Z");

    const earning = decideEarningOnSuccess({
      earningId,
      orderId,
      payoutIdr: 1_000,
      succeededAt,
      earningExistsForOrder: false,
    });
    if (earning.kind !== "create") throw new Error("expected earning creation");

    const available: EarningState = { ...earning.earning, status: "pending" };
    const release = decideHoldRelease({
      earning: available,
      now: new Date(succeededAt.getTime() + HOLD_MS + 1),
      hasActiveDispute: false,
    });
    if (release.kind !== "release") throw new Error("expected hold release");

    const request = decideRequestPayout({
      payoutId,
      earnings: [{ ...available, status: "available" }],
    });
    if (request.kind !== "lock") throw new Error("expected payout lock");

    const paid = decidePayoutTransition(
      { id: payoutId, status: "processing", amountIdr: 1_000, allocations: [], paymentReference: null },
      { type: "markPaid", paymentReference: "PAY-1", paidAt: succeededAt, actorRef: "admin-1" },
    );
    if (paid.kind !== "apply" || paid.transaction === null) {
      throw new Error("expected payout paid transaction");
    }

    return [earning.transaction, release.transaction, request.transaction, paid.transaction];
  }

  it("makes every domain-built ledger transaction net to exactly zero", () => {
    for (const transaction of fullLifecycleTransactions()) {
      const sum = transaction.entries.reduce((total, entry) => total + entry.amountIdrSigned, 0);
      expect(sum).toBe(0);
      expect(transaction.entries.length).toBeGreaterThanOrEqual(2);
      // The domain guard agrees the entries are balanced.
      expect(() => assertZeroSumEntries(transaction.entries)).not.toThrow();
    }
  });

  it("keeps per-bucket SUM balances conservative across the whole flow", () => {
    const balances = computeBalancesFromTransactions(fullLifecycleTransactions());
    // Money leaves the platform payable and rests in partner_paid — conserved.
    expect(balances.platform_partner_payable).toBe(-1_000);
    expect(balances.partner_paid).toBe(1_000);
    expect(balances.partner_pending).toBe(0);
    expect(balances.partner_available).toBe(0);
    expect(balances.partner_payout_locked).toBe(0);
    expect(balances.partner_reversed).toBe(0);
    // The whole ledger nets to zero across every bucket.
    expect(isLedgerBalanced(balances)).toBe(true);
    expect(LEDGER_BUCKETS.reduce((total, bucket) => total + balances[bucket], 0)).toBe(0);
  });

  it("rejects any imbalanced transaction so a leak can never be committed", () => {
    expect(() =>
      createLedgerTransaction({
        eventType: "order-success",
        eventKey: "order-success:leak",
        referenceType: "order",
        referenceId: "order-leak",
        entries: [
          { bucket: "platform_partner_payable", amountIdrSigned: -1_000 },
          { bucket: "partner_pending", amountIdrSigned: 900 },
        ],
      }),
    ).toThrow(/sum to zero/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Reconciliation: clean => zero issues, high severity => release blocker
//    (Req 20.2, 20.6)
// ---------------------------------------------------------------------------
describe("Task 17.8 gate — reconciliation blocks release on high-severity issues (Req 20.2, 20.6)", () => {
  /** A fully consistent single-order dataset: one success earning + its ledger. */
  const consistentInput = {
    ledgerTransactions: [
      {
        eventType: "order-success",
        eventKey: "order-success:order-1",
        referenceType: "order",
        referenceId: "order-1",
        entries: [
          { bucket: "platform_partner_payable", amountIdrSigned: -1_000 },
          { bucket: "partner_pending", amountIdrSigned: 1_000 },
        ],
      },
    ],
    earnings: [{ id: "earning-1", orderId: "order-1", amountIdr: 1_000, status: "pending" }],
    orderSnapshots: [{ orderId: "order-1", payoutIdr: 1_000 }],
    payouts: [],
    projectionBalances: {
      partner_pending: 1_000,
      partner_available: 0,
      partner_payout_locked: 0,
      partner_paid: 0,
      partner_reversed: 0,
    },
    orderNumberPairs: [],
    numbers: [{ numberId: "number-1", status: "available", activeOrderIds: [] }],
    devices: [],
  } as const;

  it("yields zero issues (and zero release blockers) on a consistent dataset", () => {
    const findings = reconcilePartner(consistentInput);
    expect(findings).toHaveLength(0);
    expect(releaseBlockingIssues(findings)).toHaveLength(0);
  });

  it("flags a non-zero-sum ledger as a high-severity release blocker", () => {
    // Inject a leaking transaction: entries sum to -100 (money vanished).
    const leaking = reconcilePartner({
      ...consistentInput,
      ledgerTransactions: [
        {
          eventType: "order-success",
          eventKey: "order-success:order-leak",
          referenceType: "order",
          referenceId: "order-leak",
          entries: [
            { bucket: "platform_partner_payable", amountIdrSigned: -1_000 },
            { bucket: "partner_pending", amountIdrSigned: 900 },
          ],
        },
      ],
      earnings: [],
      orderSnapshots: [],
      projectionBalances: {},
    });
    const blockers = releaseBlockingIssues(leaking);
    expect(blockers.length).toBeGreaterThan(0);
    // The leak is classified as a ledger imbalance and blocks the release.
    expect(blockers.some((issue) => issue.type === "ledger_imbalance")).toBe(true);
    expect(blockers.every((issue) => issue.severity === "high")).toBe(true);
  });

  it("flags projection drift from the ledger as a high-severity blocker", () => {
    const drift = reconcilePartner({
      ...consistentInput,
      // The projection claims Rp2.000 pending while the ledger only holds Rp1.000.
      projectionBalances: { ...consistentInput.projectionBalances, partner_pending: 2_000 },
    });
    const blockers = releaseBlockingIssues(drift);
    expect(blockers.some((issue) => issue.type === "projection_ledger_mismatch")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Acceptance scope is simulator-only wa/ID/any — no external dependency
//    (Req 23.4)
// ---------------------------------------------------------------------------
describe("Task 17.8 gate — acceptance scope excludes external dependencies (Req 23.4)", () => {
  it("pins the MVP catalog to wa/ID/any/IDR from the real seed", () => {
    const seed = partnerFile("prisma/seed.sql");
    expect(seed).toContain("'wa', 'ID', 'any', 'IDR'");
    // The seed only touches the Partner PlatformConfig — no external wiring.
    expect(seed).toContain('INSERT INTO "platform_configs"');
    expect(seed).not.toMatch(/GRANT|REVOKE|CREATE ROLE|CREATE USER/i);
  });

  it("requires only a simulator device for acceptance — no production hardware", () => {
    expect(DEVICE_TYPES).toContain("simulator");
    // A simulator can be created in a non-production/test acceptance environment
    // without any allowlist, so the flow needs no APK/modem/GoIP hardware.
    expect(decideDeviceCreation("simulator", {
      environment: "test",
      partnerSimulatorAllowed: false,
    })).toEqual({ allowed: true, reason: "non_production_environment" });
    // Hardware/external device types exist for post-MVP but are NOT required:
    // the private-beta partner is admitted purely by flag + allowlist, not by
    // owning any external device.
    for (const external of ["android", "modem", "goip", "api"] as const) {
      expect(DEVICE_TYPES).toContain(external);
    }
  });

  it("declares no external-provider/hardware/payment-gateway runtime config", () => {
    const envExample = partnerFile(".env.example");
    // Every runtime key stays in the PARTNER_ namespace; none names a live
    // modem/GoIP/APK, a direct supplier API, or a payment gateway.
    expect(envExample).not.toMatch(/MODEM|GOIP|GAMMU|APK|ANDROID/i);
    expect(envExample).not.toMatch(/PAYMENT[_-]?GATEWAY|PAYOUT[_-]?PROVIDER|MIDTRANS|XENDIT|STRIPE/i);
    expect(envExample).not.toMatch(/SUPPLIER[_-]?API|DIRECT[_-]?API/i);
  });

  it("gates partner supply behind the private-beta flag + allowlist, not any external API", () => {
    // Discovery/purchase require the flag AND the allowlist — no external call.
    expect(
      decidePlutoPolicy({
        operation: "purchase",
        buyerAccountRef: "buyer-1",
        partnerSupplyEnabled: true,
        allowlistedBuyerAccountRefs: ["buyer-1"],
        existingPlutoOrder: false,
      }),
    ).toEqual({ allowed: true, reason: "PRIVATE_BETA_ELIGIBLE" });
    expect(
      decidePlutoPolicy({
        operation: "purchase",
        buyerAccountRef: "buyer-1",
        partnerSupplyEnabled: false,
        allowlistedBuyerAccountRefs: ["buyer-1"],
        existingPlutoOrder: false,
      }).allowed,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. MVP acceptance independence: manual payout only, no auto payout (Req 23.5)
// ---------------------------------------------------------------------------
describe("Task 17.8 gate — acceptance depends on no automatic payout (Req 23.5)", () => {
  const availableEarning: EarningState = {
    id: "earning-1",
    orderId: "order-1",
    amountIdr: 1_000,
    status: "available",
    availableAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("uses bank_transfer_manual as the only payout method", () => {
    expect(PAYOUT_METHOD).toBe("bank_transfer_manual");
    expect(PAYOUT_MINIMUM_IDR).toBe(1_000);
  });

  it("locks earnings on request but never auto-pays without an admin action", () => {
    const request = decideRequestPayout({ payoutId: "payout-1", earnings: [availableEarning] });
    expect(request.kind).toBe("lock");
    if (request.kind !== "lock") throw new Error("expected lock");
    // Requesting a payout only LOCKS funds (available -> locked); it never mints
    // a `paid` state on its own — that needs an explicit admin markPaid.
    expect(request.earningNextStatus).toBe("requested");
    expect(request.transaction.entries.map((entry) => entry.bucket).sort()).toEqual(
      ["partner_available", "partner_payout_locked"],
    );
  });

  it("only reaches paid via an explicit manual admin reference (no automation)", () => {
    // A requested payout cannot jump straight to paid without approve+process.
    const illegal = decidePayoutTransition(
      { id: "payout-1", status: "requested", amountIdr: 1_000, allocations: [], paymentReference: null },
      { type: "markPaid", paymentReference: "PAY-1", paidAt: new Date(), actorRef: "admin-1" },
    );
    expect(illegal).toEqual({ kind: "reject", code: "illegal_transition" });

    // markPaid requires a non-empty manual payment reference.
    const missingRef = decidePayoutTransition(
      { id: "payout-1", status: "processing", amountIdr: 1_000, allocations: [], paymentReference: null },
      { type: "markPaid", paymentReference: "", paidAt: new Date(), actorRef: "admin-1" },
    );
    expect(missingRef).toEqual({ kind: "reject", code: "missing_payment_reference" });

    // The only path to paid is a manual admin markPaid carrying method + reference.
    const paid = decidePayoutTransition(
      { id: "payout-1", status: "processing", amountIdr: 1_000, allocations: [], paymentReference: null },
      { type: "markPaid", paymentReference: "PAY-1", paidAt: new Date(), actorRef: "admin-1" },
    );
    expect(paid.kind).toBe("apply");
    if (paid.kind !== "apply") throw new Error("expected apply");
    expect(paid.method).toBe("bank_transfer_manual");
    expect(paid.paymentReference).toBe("PAY-1");
  });
});
