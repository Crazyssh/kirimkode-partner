import { beforeEach, describe, expect, it } from "vitest";

import {
  earningReversalEventKey,
  holdReleaseEventKey,
  type LedgerTransaction,
} from "@domain/task-5-6";

import type {
  AppendLedgerResult,
  AppendLedgerTransactionInput,
  BucketBalances,
  CreateEarningInput,
  EarningProjection,
  EarningProjectionRepository,
  EarningStatus,
  LedgerRepository,
  UpdateEarningStatusInput,
  UpdateEarningStatusResult,
} from "./ports";
import type {
  RecordReconciliationIssueInput,
  RecordReconciliationIssueResult,
  ReconciliationIssueRepository,
} from "./earning-lifecycle-ports";
import { EarningLifecycleService } from "./earning-lifecycle-service";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EARNING_1 = "11111111-1111-4111-8111-111111111111";
const ORDER_1 = "22222222-2222-4222-8222-222222222222";
const HOLD_MS = 24 * 60 * 60 * 1000;

/** A trivial single-connection transaction runner: the fakes ignore the tx. */
type Tx = "tx";
const runner = {
  async run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return work("tx");
  },
};

/** In-memory ledger that honours the unique-eventKey idempotency contract. */
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

/** In-memory Earning projection with compare-and-set status advances. */
class FakeEarnings implements EarningProjectionRepository<Tx> {
  private row: (EarningProjection & { reversedAtEpochMs: number | null }) | null;
  private afterReadHook: (() => void) | null = null;

  constructor(seed: EarningProjection | null) {
    this.row = seed === null ? null : { ...seed };
  }

  get current(): EarningProjection | null {
    return this.row;
  }

  /**
   * Register a one-shot mutation to run *after* the next `findEarningById`
   * returns its snapshot — simulating a concurrent transition that lands
   * between the service's read and its compare-and-set.
   */
  raceAfterRead(mutate: () => void): void {
    this.afterReadHook = mutate;
  }

  async createEarning(
    _tx: Tx,
    _input: CreateEarningInput,
  ): Promise<{ readonly created: boolean }> {
    throw new Error("not used");
  }

  async findEarningById(
    partnerId: string,
    earningId: string,
  ): Promise<EarningProjection | null> {
    if (this.row === null) return null;
    const snapshot =
      this.row.partnerId === partnerId && this.row.id === earningId
        ? { ...this.row }
        : null;
    if (this.afterReadHook !== null) {
      const hook = this.afterReadHook;
      this.afterReadHook = null;
      hook();
    }
    return snapshot;
  }

  async findEarningByOrderId(): Promise<EarningProjection | null> {
    throw new Error("not used");
  }

  async updateEarningStatus(
    _tx: Tx,
    input: UpdateEarningStatusInput,
  ): Promise<UpdateEarningStatusResult> {
    if (
      this.row === null ||
      this.row.id !== input.earningId ||
      this.row.partnerId !== input.partnerId ||
      this.row.status !== input.expectedStatus
    ) {
      return { outcome: "no_op" };
    }
    this.row = {
      ...this.row,
      status: input.nextStatus,
      reversedAtEpochMs: input.reversedAtEpochMs ?? this.row.reversedAtEpochMs,
    };
    return { outcome: "updated" };
  }

  /** Test-only helper to mutate the row underneath the service (races). */
  forceStatus(status: EarningStatus): void {
    if (this.row !== null) this.row = { ...this.row, status };
  }
}

/** In-memory reconciliation issue store with open-issue dedupe. */
class FakeReconciliation implements ReconciliationIssueRepository<Tx> {
  public readonly issues: RecordReconciliationIssueInput[] = [];

  async recordIssue(
    _tx: Tx,
    input: RecordReconciliationIssueInput,
  ): Promise<RecordReconciliationIssueResult> {
    const existing = this.issues.find(
      (i) =>
        i.partnerId === input.partnerId &&
        i.type === input.type &&
        i.referenceId === input.referenceId,
    );
    if (existing !== undefined) {
      return { outcome: "duplicate_no_op", issueId: existing.id };
    }
    this.issues.push(input);
    return { outcome: "recorded", issueId: input.id };
  }
}

function fixedClock(nowEpochMs: number) {
  return { nowEpochMs: () => nowEpochMs };
}

let issueSeq = 0;
const idGenerator = {
  uuid: () => `issue-${(issueSeq += 1)}`,
};

function earning(
  overrides: Partial<EarningProjection> = {},
): EarningProjection {
  return {
    id: EARNING_1,
    partnerId: TENANT_A,
    orderId: ORDER_1,
    amountIdr: 1000,
    status: "pending",
    availableAtEpochMs: HOLD_MS,
    reversedAtEpochMs: null,
    ...overrides,
  };
}

function makeService(
  earningRepo: FakeEarnings,
  nowEpochMs: number,
): {
  service: EarningLifecycleService<Tx>;
  ledger: FakeLedger;
  reconciliation: FakeReconciliation;
} {
  const ledger = new FakeLedger();
  const reconciliation = new FakeReconciliation();
  const service = new EarningLifecycleService<Tx>({
    runner,
    ledger,
    earnings: earningRepo,
    reconciliation,
    clock: fixedClock(nowEpochMs),
    idGenerator,
  });
  return { service, ledger, reconciliation };
}

beforeEach(() => {
  issueSeq = 0;
});

// **Validates: Requirements 13.4, 13.5, 20.6**
describe("EarningLifecycleService.releaseHold", () => {
  it("releases pending -> available after the hold with no dispute", async () => {
    const earnings = new FakeEarnings(earning());
    const { service, ledger } = makeService(earnings, HOLD_MS);

    const result = await service.releaseHold({
      partnerId: TENANT_A,
      earningId: EARNING_1,
    });

    expect(result).toEqual({ kind: "released", earningId: EARNING_1 });
    expect(earnings.current?.status).toBe("available");
    expect(ledger.appended).toHaveLength(1);
    expect(ledger.appended[0].eventKey).toBe(holdReleaseEventKey(EARNING_1));
    // Zero-sum compensating move: pending -1000, available +1000.
    const sum = ledger.appended[0].entries.reduce(
      (s, e) => s + e.amountIdrSigned,
      0,
    );
    expect(sum).toBe(0);
  });

  it("is a deterministic no-op when already available (cron retry)", async () => {
    const earnings = new FakeEarnings(earning({ status: "available" }));
    const { service, ledger } = makeService(earnings, HOLD_MS);

    const result = await service.releaseHold({
      partnerId: TENANT_A,
      earningId: EARNING_1,
    });

    expect(result).toEqual({ kind: "already_available", earningId: EARNING_1 });
    expect(ledger.appended).toHaveLength(0);
  });

  it("refuses to release before the hold elapses", async () => {
    const earnings = new FakeEarnings(earning());
    const { service, ledger } = makeService(earnings, HOLD_MS - 1);

    const result = await service.releaseHold({
      partnerId: TENANT_A,
      earningId: EARNING_1,
    });

    expect(result).toEqual({ kind: "hold_not_elapsed", earningId: EARNING_1 });
    expect(earnings.current?.status).toBe("pending");
    expect(ledger.appended).toHaveLength(0);
  });

  it("refuses to release while a dispute is active", async () => {
    const earnings = new FakeEarnings(earning());
    const { service, ledger } = makeService(earnings, HOLD_MS);

    const result = await service.releaseHold({
      partnerId: TENANT_A,
      earningId: EARNING_1,
      hasActiveDispute: true,
    });

    expect(result).toEqual({ kind: "dispute_active", earningId: EARNING_1 });
    expect(ledger.appended).toHaveLength(0);
  });

  it("reports not_found for an absent / cross-tenant earning", async () => {
    const earnings = new FakeEarnings(null);
    const { service } = makeService(earnings, HOLD_MS);

    expect(
      await service.releaseHold({ partnerId: TENANT_A, earningId: EARNING_1 }),
    ).toEqual({ kind: "not_found" });
  });

  it("appends no ledger event when the earning changed under a stale read", async () => {
    const earnings = new FakeEarnings(earning());
    const { service, ledger } = makeService(earnings, HOLD_MS);
    // The read returns pending; a concurrent reversal lands before the CAS.
    earnings.raceAfterRead(() => earnings.forceStatus("reversed"));

    const result = await service.releaseHold({
      partnerId: TENANT_A,
      earningId: EARNING_1,
    });

    expect(result).toEqual({ kind: "state_changed", earningId: EARNING_1 });
    expect(ledger.appended).toHaveLength(0);
    expect(earnings.current?.status).toBe("reversed");
  });
});

// **Validates: Requirements 13.5, 20.6**
describe("EarningLifecycleService.reverseEarning", () => {
  it("reverses an available earning with a compensating ledger event", async () => {
    const earnings = new FakeEarnings(earning({ status: "available" }));
    const { service, ledger } = makeService(earnings, 50_000);

    const result = await service.reverseEarning({
      partnerId: TENANT_A,
      earningId: EARNING_1,
      reason: "buyer_refund",
    });

    expect(result).toEqual({ kind: "reversed", earningId: EARNING_1 });
    expect(earnings.current?.status).toBe("reversed");
    expect(earnings.current?.reversedAtEpochMs).toBe(50_000);
    expect(ledger.appended).toHaveLength(1);
    expect(ledger.appended[0].eventKey).toBe(earningReversalEventKey(EARNING_1));
    // available -1000, reversed +1000.
    expect(
      ledger.appended[0].entries.find((e) => e.bucket === "partner_available")
        ?.amountIdrSigned,
    ).toBe(-1000);
    expect(
      ledger.appended[0].entries.find((e) => e.bucket === "partner_reversed")
        ?.amountIdrSigned,
    ).toBe(1000);
  });

  it("reverses a pending earning out of the pending bucket", async () => {
    const earnings = new FakeEarnings(earning({ status: "pending" }));
    const { service, ledger } = makeService(earnings, 50_000);

    const result = await service.reverseEarning({
      partnerId: TENANT_A,
      earningId: EARNING_1,
      reason: "dispute_upheld",
    });

    expect(result).toEqual({ kind: "reversed", earningId: EARNING_1 });
    expect(
      ledger.appended[0].entries.find((e) => e.bucket === "partner_pending")
        ?.amountIdrSigned,
    ).toBe(-1000);
  });

  it("blocks reversal of a paid earning and records a reconciliation issue", async () => {
    const earnings = new FakeEarnings(earning({ status: "paid" }));
    const { service, ledger, reconciliation } = makeService(earnings, 50_000);

    const result = await service.reverseEarning({
      partnerId: TENANT_A,
      earningId: EARNING_1,
      reason: "late_refund",
    });

    expect(result).toEqual({
      kind: "reconciliation_required",
      earningId: EARNING_1,
      issueId: "issue-1",
    });
    // No money moved and the projection is untouched (requirement 20.6).
    expect(ledger.appended).toHaveLength(0);
    expect(earnings.current?.status).toBe("paid");
    expect(reconciliation.issues).toHaveLength(1);
    expect(reconciliation.issues[0]).toMatchObject({
      type: "stale_financial_state",
      referenceId: EARNING_1,
      severity: "high",
    });
  });

  it("dedupes the reconciliation issue on a retried paid reversal", async () => {
    const earnings = new FakeEarnings(earning({ status: "paid" }));
    const { service, reconciliation } = makeService(earnings, 50_000);

    const first = await service.reverseEarning({
      partnerId: TENANT_A,
      earningId: EARNING_1,
      reason: "late_refund",
    });
    const second = await service.reverseEarning({
      partnerId: TENANT_A,
      earningId: EARNING_1,
      reason: "late_refund",
    });

    expect(first.kind).toBe("reconciliation_required");
    expect(second).toEqual(first);
    expect(reconciliation.issues).toHaveLength(1);
  });

  it("is a no-op when already reversed", async () => {
    const earnings = new FakeEarnings(earning({ status: "reversed" }));
    const { service, ledger } = makeService(earnings, 50_000);

    const result = await service.reverseEarning({
      partnerId: TENANT_A,
      earningId: EARNING_1,
      reason: "buyer_refund",
    });

    expect(result).toEqual({ kind: "already_reversed", earningId: EARNING_1 });
    expect(ledger.appended).toHaveLength(0);
  });

  it("rejects a reversal with a blank reason", async () => {
    const earnings = new FakeEarnings(earning({ status: "available" }));
    const { service, ledger } = makeService(earnings, 50_000);

    const result = await service.reverseEarning({
      partnerId: TENANT_A,
      earningId: EARNING_1,
      reason: "   ",
    });

    expect(result).toEqual({ kind: "missing_reason", earningId: EARNING_1 });
    expect(ledger.appended).toHaveLength(0);
  });

  it("rejects reversing an earning locked in a payout (requested)", async () => {
    const earnings = new FakeEarnings(earning({ status: "requested" }));
    const { service, ledger } = makeService(earnings, 50_000);

    const result = await service.reverseEarning({
      partnerId: TENANT_A,
      earningId: EARNING_1,
      reason: "buyer_refund",
    });

    expect(result).toEqual({ kind: "invalid_state", earningId: EARNING_1 });
    expect(ledger.appended).toHaveLength(0);
  });

  it("reports not_found for an absent earning", async () => {
    const earnings = new FakeEarnings(null);
    const { service } = makeService(earnings, 50_000);

    expect(
      await service.reverseEarning({
        partnerId: TENANT_A,
        earningId: EARNING_1,
        reason: "buyer_refund",
      }),
    ).toEqual({ kind: "not_found" });
  });

  it("appends no ledger event when the earning changed under a stale read", async () => {
    const earnings = new FakeEarnings(earning({ status: "available" }));
    const { service, ledger } = makeService(earnings, 50_000);
    // The read returns available; a concurrent payout locks it to requested.
    earnings.raceAfterRead(() => earnings.forceStatus("requested"));

    const result = await service.reverseEarning({
      partnerId: TENANT_A,
      earningId: EARNING_1,
      reason: "buyer_refund",
    });

    expect(result).toEqual({ kind: "state_changed", earningId: EARNING_1 });
    expect(ledger.appended).toHaveLength(0);
    expect(earnings.current?.status).toBe("requested");
  });
});
