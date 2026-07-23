import { describe, expect, it } from "vitest";

import {
  payoutPaidEventKey,
  payoutUnlockEventKey,
  type LedgerTransaction,
  type PayoutAllocation,
  type PayoutStatus,
} from "@domain/task-5-6";
import {
  PAYOUT_REVIEW_PERMISSION,
  type AuthenticatedAdmin,
} from "@domain/task-7-5";
import type {
  AppendLedgerResult,
  AppendLedgerTransactionInput,
  BucketBalances,
  EarningProjection,
  EarningProjectionRepository,
  LedgerRepository,
  UpdateEarningStatusInput,
  UpdateEarningStatusResult,
} from "@application/ledger";

import { PayoutReviewService } from "./payout-review-service";
import type {
  AuditWriteInput,
  PayoutAdminRecord,
  PayoutAdminRepository,
  RecordPayoutTransitionInput,
  UpdatePayoutStatusInput,
  UpdatePayoutStatusResult,
} from "./ports";

type Tx = "tx";

const PARTNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_ID = "adadadad-adad-4ada-8ada-adadadadadad";
const PAYOUT_ID = "b0000000-0000-4000-8000-000000000000";
const EARNING_1 = "e1111111-1111-4111-8111-111111111111";
const EARNING_2 = "e2222222-2222-4222-8222-222222222222";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const NOW = 1_700_000_000_000;

const runner = {
  async run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return work("tx");
  },
};

class FakeLedger implements LedgerRepository<Tx> {
  public readonly appended: LedgerTransaction[] = [];
  async appendTransaction(
    _tx: Tx,
    input: AppendLedgerTransactionInput,
  ): Promise<AppendLedgerResult> {
    if (this.appended.some((t) => t.eventKey === input.transaction.eventKey)) {
      return { outcome: "duplicate_no_op" };
    }
    this.appended.push(input.transaction);
    return { outcome: "appended", transactionId: `tx-${this.appended.length}` };
  }
  async computeBucketBalances(): Promise<BucketBalances> {
    throw new Error("not used");
  }
}

class FakeEarnings implements EarningProjectionRepository<Tx> {
  private readonly rows = new Map<string, EarningProjection>();
  constructor(seed: readonly EarningProjection[]) {
    for (const row of seed) this.rows.set(row.id, { ...row });
  }
  get(id: string): EarningProjection | undefined {
    return this.rows.get(id);
  }
  async createEarning(): Promise<{ readonly created: boolean }> {
    throw new Error("not used");
  }
  async findEarningById(): Promise<EarningProjection | null> {
    throw new Error("not used");
  }
  async findEarningByOrderId(): Promise<EarningProjection | null> {
    throw new Error("not used");
  }
  async updateEarningStatus(
    _tx: Tx,
    input: UpdateEarningStatusInput,
  ): Promise<UpdateEarningStatusResult> {
    const row = this.rows.get(input.earningId);
    if (
      row === undefined ||
      row.partnerId !== input.partnerId ||
      row.status !== input.expectedStatus
    ) {
      return { outcome: "no_op" };
    }
    this.rows.set(input.earningId, { ...row, status: input.nextStatus });
    return { outcome: "updated" };
  }
}

interface FakePayoutStore {
  record: PayoutAdminRecord;
  transitions: RecordPayoutTransitionInput[];
  audits: AuditWriteInput[];
  usedReferences: Set<string>;
  /** payoutIds whose allocations were released (reject/fail), in call order. */
  releasedPayoutIds: string[];
}

function makePayoutRepo(store: FakePayoutStore): PayoutAdminRepository<Tx> {
  return {
    async findPayoutForReview(payoutId) {
      return store.record.id === payoutId ? store.record : null;
    },
    async updatePayoutStatus(
      _tx: Tx,
      input: UpdatePayoutStatusInput,
    ): Promise<UpdatePayoutStatusResult> {
      if (store.record.status !== input.expectedStatus) {
        return { outcome: "no_op" };
      }
      if (input.paymentReference !== undefined) {
        if (store.usedReferences.has(input.paymentReference)) {
          return { outcome: "duplicate_reference" };
        }
        store.usedReferences.add(input.paymentReference);
      }
      store.record = {
        ...store.record,
        status: input.nextStatus,
        paymentReference:
          input.paymentReference ?? store.record.paymentReference,
      };
      return { outcome: "updated" };
    },
    async releaseAllocations(_tx, _partnerId, payoutId) {
      store.releasedPayoutIds.push(payoutId);
    },
    async recordTransition(_tx, _partnerId, input) {
      store.transitions.push(input);
    },
    async recordAudit(_tx, input) {
      store.audits.push(input);
    },
  };
}

function allocations(): PayoutAllocation[] {
  return [
    { earningId: EARNING_1, amountIdr: 1000 },
    { earningId: EARNING_2, amountIdr: 1000 },
  ];
}

function payoutRecord(
  status: PayoutStatus,
  over: Partial<PayoutAdminRecord> = {},
): PayoutAdminRecord {
  return {
    id: PAYOUT_ID,
    partnerId: PARTNER_A,
    status,
    amountIdr: 2000,
    paymentReference: null,
    allocations: allocations(),
    ...over,
  };
}

function lockedEarnings(): FakeEarnings {
  return new FakeEarnings([
    {
      id: EARNING_1,
      partnerId: PARTNER_A,
      orderId: "order-1",
      amountIdr: 1000,
      status: "requested",
      availableAtEpochMs: NOW - 1000,
      reversedAtEpochMs: null,
    },
    {
      id: EARNING_2,
      partnerId: PARTNER_A,
      orderId: "order-2",
      amountIdr: 1000,
      status: "requested",
      availableAtEpochMs: NOW - 1000,
      reversedAtEpochMs: null,
    },
  ]);
}

function admin(
  permissions: readonly string[] = [PAYOUT_REVIEW_PERMISSION],
): AuthenticatedAdmin {
  return { adminId: ADMIN_ID, permissions, securityVersion: 1 };
}

let idSeq = 0;
function makeService(
  earnings: FakeEarnings,
  ledger: FakeLedger,
  store: FakePayoutStore,
): PayoutReviewService<Tx> {
  idSeq = 0;
  return new PayoutReviewService<Tx>({
    runner,
    ledger,
    earnings,
    payouts: makePayoutRepo(store),
    clock: { nowEpochMs: () => NOW },
    idGenerator: { uuid: () => `uuid-${(idSeq += 1)}` },
  });
}

function makeStore(record: PayoutAdminRecord): FakePayoutStore {
  return {
    record,
    transitions: [],
    audits: [],
    usedReferences: new Set(),
    releasedPayoutIds: [],
  };
}

// **Validates: Requirements 14.3, 14.4, 14.5, 14.6, 14.7, 16.6, 23.3**
describe("PayoutReviewService", () => {
  it("approves requested -> approved with no ledger/earning effect", async () => {
    const earnings = lockedEarnings();
    const ledger = new FakeLedger();
    const store = makeStore(payoutRecord("requested"));
    const service = makeService(earnings, ledger, store);

    const result = await service.approve({
      admin: admin(),
      payoutId: PAYOUT_ID,
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: true, status: "approved" });
    expect(ledger.appended).toHaveLength(0);
    expect(earnings.get(EARNING_1)?.status).toBe("requested");
    expect(store.transitions[0]).toMatchObject({
      fromStatus: "requested",
      toStatus: "approved",
      actorType: "partner_admin",
      operationKey: `payout-approve:${PAYOUT_ID}`,
    });
    expect(store.audits[0]?.descriptor.action).toBe("payout.changed");
  });

  it("marks processing -> paid, moves earnings to paid, and appends payout-paid", async () => {
    const earnings = lockedEarnings();
    const ledger = new FakeLedger();
    const store = makeStore(payoutRecord("processing"));
    const service = makeService(earnings, ledger, store);

    const result = await service.markPaid({
      admin: admin(),
      payoutId: PAYOUT_ID,
      requestId: REQUEST_ID,
      paymentReference: "  BCA-REF-001  ",
    });

    expect(result).toEqual({ ok: true, status: "paid" });
    expect(earnings.get(EARNING_1)?.status).toBe("paid");
    expect(earnings.get(EARNING_2)?.status).toBe("paid");

    expect(ledger.appended).toHaveLength(1);
    expect(ledger.appended[0].eventKey).toBe(payoutPaidEventKey(PAYOUT_ID));
    const sum = ledger.appended[0].entries.reduce(
      (s, e) => s + e.amountIdrSigned,
      0,
    );
    expect(sum).toBe(0);
    expect(
      ledger.appended[0].entries.find((e) => e.bucket === "partner_payout_locked")
        ?.amountIdrSigned,
    ).toBe(-2000);
    expect(
      ledger.appended[0].entries.find((e) => e.bucket === "partner_paid")
        ?.amountIdrSigned,
    ).toBe(2000);

    // Payment reference is trimmed and recorded; method + reference audited.
    expect(store.record.paymentReference).toBe("BCA-REF-001");
    const meta = store.audits[0]?.descriptor.safeMetadata as Record<string, unknown>;
    expect(meta.paymentReference).toBe("BCA-REF-001");
    expect(meta.method).toBe("bank_transfer_manual");
    expect(meta.change).toBe("paid");
    // A settled (paid) payout keeps its allocations bound to the earnings — the
    // earnings are `paid`, never re-requestable, so nothing is released.
    expect(store.releasedPayoutIds).toEqual([]);
  });

  it("rejects a payout, unlocks earnings requested -> available, and appends payout-unlock", async () => {
    const earnings = lockedEarnings();
    const ledger = new FakeLedger();
    const store = makeStore(payoutRecord("requested"));
    const service = makeService(earnings, ledger, store);

    const result = await service.reject({
      admin: admin(),
      payoutId: PAYOUT_ID,
      requestId: REQUEST_ID,
      reason: "Rekening tidak valid",
    });

    expect(result).toEqual({ ok: true, status: "rejected" });
    expect(earnings.get(EARNING_1)?.status).toBe("available");
    expect(earnings.get(EARNING_2)?.status).toBe("available");
    expect(ledger.appended).toHaveLength(1);
    expect(ledger.appended[0].eventKey).toBe(payoutUnlockEventKey(PAYOUT_ID));
    expect(
      ledger.appended[0].entries.find((e) => e.bucket === "partner_available")
        ?.amountIdrSigned,
    ).toBe(2000);
    expect(store.transitions[0]?.reason).toBe("Rekening tidak valid");
    // The allocations are released so the returned-to-available earnings are no
    // longer held by the partial unique index and can be requested again.
    expect(store.releasedPayoutIds).toEqual([PAYOUT_ID]);
  });

  it("is idempotent: a repeated reject on an already-rejected payout is a no-op success", async () => {
    const earnings = lockedEarnings();
    const ledger = new FakeLedger();
    const store = makeStore(payoutRecord("rejected"));
    const service = makeService(earnings, ledger, store);

    const result = await service.reject({
      admin: admin(),
      payoutId: PAYOUT_ID,
      requestId: REQUEST_ID,
      reason: "Rekening tidak valid",
    });

    expect(result).toEqual({ ok: true, status: "rejected" });
    // No second unlock event and no transition recorded.
    expect(ledger.appended).toHaveLength(0);
    expect(store.transitions).toHaveLength(0);
    // The no-op short-circuits before the transaction: no second release.
    expect(store.releasedPayoutIds).toEqual([]);
  });

  it("fails a processing payout, unlocks earnings, and releases its allocations", async () => {
    const earnings = lockedEarnings();
    const ledger = new FakeLedger();
    const store = makeStore(payoutRecord("processing"));
    const service = makeService(earnings, ledger, store);

    const result = await service.fail({
      admin: admin(),
      payoutId: PAYOUT_ID,
      requestId: REQUEST_ID,
      reason: "Transfer bank ditolak",
    });

    expect(result).toEqual({ ok: true, status: "failed" });
    expect(earnings.get(EARNING_1)?.status).toBe("available");
    expect(earnings.get(EARNING_2)?.status).toBe("available");
    expect(ledger.appended[0].eventKey).toBe(payoutUnlockEventKey(PAYOUT_ID));
    // Allocations released so the earnings can be requested in a new payout.
    expect(store.releasedPayoutIds).toEqual([PAYOUT_ID]);
  });

  it("forbids an admin without the payout:review permission", async () => {
    const earnings = lockedEarnings();
    const ledger = new FakeLedger();
    const store = makeStore(payoutRecord("processing"));
    const service = makeService(earnings, ledger, store);

    const result = await service.markPaid({
      admin: admin([]),
      payoutId: PAYOUT_ID,
      requestId: REQUEST_ID,
      paymentReference: "REF-1",
    });

    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(ledger.appended).toHaveLength(0);
  });

  it("rejects an illegal transition (skip approved/processing to paid)", async () => {
    const earnings = lockedEarnings();
    const ledger = new FakeLedger();
    const store = makeStore(payoutRecord("requested"));
    const service = makeService(earnings, ledger, store);

    const result = await service.markPaid({
      admin: admin(),
      payoutId: PAYOUT_ID,
      requestId: REQUEST_ID,
      paymentReference: "REF-1",
    });

    expect(result).toEqual({ ok: false, reason: "illegal_transition" });
    expect(ledger.appended).toHaveLength(0);
  });

  it("blocks a transition out of a terminal state", async () => {
    const earnings = lockedEarnings();
    const ledger = new FakeLedger();
    const store = makeStore(payoutRecord("paid"));
    const service = makeService(earnings, ledger, store);

    const result = await service.reject({
      admin: admin(),
      payoutId: PAYOUT_ID,
      requestId: REQUEST_ID,
      reason: "too late",
    });

    expect(result).toEqual({ ok: false, reason: "terminal_state_conflict" });
  });

  it("requires a non-empty reason to reject", async () => {
    const earnings = lockedEarnings();
    const ledger = new FakeLedger();
    const store = makeStore(payoutRecord("requested"));
    const service = makeService(earnings, ledger, store);

    const result = await service.reject({
      admin: admin(),
      payoutId: PAYOUT_ID,
      requestId: REQUEST_ID,
      reason: "   ",
    });

    expect(result).toEqual({ ok: false, reason: "missing_reason" });
  });

  it("requires a payment reference to mark paid", async () => {
    const earnings = lockedEarnings();
    const ledger = new FakeLedger();
    const store = makeStore(payoutRecord("processing"));
    const service = makeService(earnings, ledger, store);

    const result = await service.markPaid({
      admin: admin(),
      payoutId: PAYOUT_ID,
      requestId: REQUEST_ID,
      paymentReference: "  ",
    });

    expect(result).toEqual({ ok: false, reason: "missing_payment_reference" });
  });

  it("maps a duplicate payment reference to a conflict without a ledger effect", async () => {
    const earnings = lockedEarnings();
    const ledger = new FakeLedger();
    const store = makeStore(payoutRecord("processing"));
    store.usedReferences.add("REF-DUP");
    const service = makeService(earnings, ledger, store);

    const result = await service.markPaid({
      admin: admin(),
      payoutId: PAYOUT_ID,
      requestId: REQUEST_ID,
      paymentReference: "REF-DUP",
    });

    expect(result).toEqual({ ok: false, reason: "duplicate_payment_reference" });
    expect(ledger.appended).toHaveLength(0);
    expect(earnings.get(EARNING_1)?.status).toBe("requested");
  });

  it("reports not_found for an absent payout", async () => {
    const earnings = lockedEarnings();
    const ledger = new FakeLedger();
    const store = makeStore(payoutRecord("requested"));
    const service = makeService(earnings, ledger, store);

    const result = await service.approve({
      admin: admin(),
      payoutId: "c0000000-0000-4000-8000-000000000000",
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("walks the full happy path requested -> approved -> processing -> paid", async () => {
    const earnings = lockedEarnings();
    const ledger = new FakeLedger();
    const store = makeStore(payoutRecord("requested"));
    const service = makeService(earnings, ledger, store);

    expect(await service.approve({ admin: admin(), payoutId: PAYOUT_ID, requestId: REQUEST_ID })).toEqual({
      ok: true,
      status: "approved",
    });
    expect(
      await service.markProcessing({ admin: admin(), payoutId: PAYOUT_ID, requestId: REQUEST_ID }),
    ).toEqual({ ok: true, status: "processing" });
    expect(
      await service.markPaid({
        admin: admin(),
        payoutId: PAYOUT_ID,
        requestId: REQUEST_ID,
        paymentReference: "REF-FINAL",
      }),
    ).toEqual({ ok: true, status: "paid" });

    expect(store.record.status).toBe("paid");
    expect(earnings.get(EARNING_1)?.status).toBe("paid");
    expect(ledger.appended).toHaveLength(1);
    expect(ledger.appended[0].eventKey).toBe(payoutPaidEventKey(PAYOUT_ID));
  });
});
