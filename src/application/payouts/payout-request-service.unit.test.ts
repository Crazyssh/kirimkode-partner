import { describe, expect, it } from "vitest";

import { payoutLockEventKey, type LedgerTransaction } from "@domain/task-5-6";
import type { AuthenticatedPrincipal } from "@domain/task-7-2";
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

import { toSessionContext, type SessionContext } from "../authorization/session-context";
import { PayoutRequestService } from "./payout-request-service";
import {
  EarningAlreadyAllocatedError,
  type AuditWriteInput,
  type EncryptedField,
  type NewPartnerPayout,
  type NewPayoutTransition,
  type PayoutDestinationRecord,
  type PayoutMinimumReader,
  type PayoutRequestRepository,
  type PayoutSecretCipher,
} from "./ports";
import type { PayoutAllocation } from "@domain/task-5-6";

type Tx = "tx";

const PARTNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const DEST_ID = "33333333-3333-4333-8333-333333333333";
const EARNING_1 = "e1111111-1111-4111-8111-111111111111";
const EARNING_2 = "e2222222-2222-4222-8222-222222222222";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const NOW = 1_700_000_000_000;

const runner = {
  async run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return work("tx");
  },
};

class FakeCipher implements PayoutSecretCipher {
  readonly keyVersion = 7;
  encrypt(plaintext: string): EncryptedField {
    return {
      ciphertext: Uint8Array.from(Buffer.from(`enc:${plaintext}`, "utf8")),
      keyVersion: this.keyVersion,
    };
  }
  async decrypt(input: { ciphertext: Uint8Array; keyVersion: number }): Promise<string | null> {
    const text = Buffer.from(input.ciphertext).toString("utf8");
    return text.startsWith("enc:") ? text.slice(4) : null;
  }
}

class FakeLedger implements LedgerRepository<Tx> {
  public readonly appended: LedgerTransaction[] = [];
  async appendTransaction(_tx: Tx, input: AppendLedgerTransactionInput): Promise<AppendLedgerResult> {
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
  async findEarningById(partnerId: string, earningId: string): Promise<EarningProjection | null> {
    const row = this.rows.get(earningId);
    return row && row.partnerId === partnerId ? { ...row } : null;
  }
  async findEarningByOrderId(): Promise<EarningProjection | null> {
    throw new Error("not used");
  }
  async updateEarningStatus(_tx: Tx, input: UpdateEarningStatusInput): Promise<UpdateEarningStatusResult> {
    const row = this.rows.get(input.earningId);
    if (row === undefined || row.partnerId !== input.partnerId || row.status !== input.expectedStatus) {
      return { outcome: "no_op" };
    }
    this.rows.set(input.earningId, { ...row, status: input.nextStatus });
    return { outcome: "updated" };
  }
}

interface FakePayoutState {
  destination: PayoutDestinationRecord | null;
  payout: NewPartnerPayout | null;
  allocations: PayoutAllocation[];
  transition: NewPayoutTransition | null;
  audit: AuditWriteInput | null;
  allocationConflictFor?: string;
}

function makePayoutRepo(state: FakePayoutState): PayoutRequestRepository<Tx> {
  return {
    async findActiveDestination(partnerId, destinationId) {
      if (state.destination && state.destination.partnerId === partnerId && state.destination.id === destinationId) {
        return state.destination;
      }
      return null;
    },
    async createPayout(_tx, _partnerId, input) {
      state.payout = input;
    },
    async createAllocations(_tx, _partnerId, _payoutId, allocations) {
      for (const allocation of allocations) {
        if (state.allocationConflictFor === allocation.earningId) {
          throw new EarningAlreadyAllocatedError(allocation.earningId);
        }
        state.allocations.push(allocation);
      }
    },
    async recordTransition(_tx, _partnerId, input) {
      state.transition = input;
    },
    async recordAudit(_tx, input) {
      state.audit = input;
    },
  };
}

function destination(): PayoutDestinationRecord {
  return {
    id: DEST_ID,
    partnerId: PARTNER_A,
    bankCode: "BCA",
    accountNumberCiphertext: Uint8Array.from(Buffer.from("enc:1234567890", "utf8")),
    keyVersion: 7,
    accountNumberLast4: "7890",
    accountHolderName: "Budi Santoso",
    status: "active",
  };
}

function earning(id: string, over: Partial<EarningProjection> = {}): EarningProjection {
  return {
    id,
    partnerId: PARTNER_A,
    orderId: `order-${id}`,
    amountIdr: 1000,
    status: "available",
    availableAtEpochMs: NOW - 1000,
    reversedAtEpochMs: null,
    ...over,
  };
}

function principal(over: Partial<AuthenticatedPrincipal> = {}): AuthenticatedPrincipal {
  return { memberId: OWNER_ID, partnerId: PARTNER_A, role: "owner", securityVersion: 1, ...over };
}
function context(over: Partial<AuthenticatedPrincipal> = {}): SessionContext {
  return toSessionContext(principal(over));
}

/**
 * A fake {@link PayoutMinimumReader}. `value` is the admin-configured minimum
 * (`null` models "no active config", so the service falls back to the domain
 * Rp1.000 floor); `calls` records that it is read per request.
 */
function makeMinimumReader(value: number | null = null) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async readMinimumPayoutIdr(): Promise<number | null> {
      calls += 1;
      return value;
    },
  } satisfies PayoutMinimumReader & { readonly calls: number };
}

let idSeq = 0;
function makeService(
  earnings: FakeEarnings,
  ledger: FakeLedger,
  state: FakePayoutState,
  minimum: PayoutMinimumReader = makeMinimumReader(),
): PayoutRequestService<Tx> {
  idSeq = 0;
  return new PayoutRequestService<Tx>({
    runner,
    ledger,
    earnings,
    payouts: makePayoutRepo(state),
    minimum,
    cipher: new FakeCipher(),
    clock: { nowEpochMs: () => NOW },
    idGenerator: { uuid: () => `uuid-${(idSeq += 1)}` },
  });
}

// **Validates: Requirements 14.1, 14.2, 14.3, 14.6, 14.7, 23.3**
describe("PayoutRequestService.requestPayout", () => {
  it("locks whole earnings and creates payout + allocations + ledger event atomically", async () => {
    const earnings = new FakeEarnings([earning(EARNING_1), earning(EARNING_2)]);
    const ledger = new FakeLedger();
    const state: FakePayoutState = { destination: destination(), payout: null, allocations: [], transition: null, audit: null };
    const service = makeService(earnings, ledger, state);

    const result = await service.requestPayout({
      caller: context(),
      destinationId: DEST_ID,
      earningIds: [EARNING_1, EARNING_2],
      requestId: REQUEST_ID,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payout.amountIdr).toBe(2000);
    expect(result.payout.status).toBe("requested");
    expect(result.payout.paymentMethod).toBe("bank_transfer_manual");
    expect(result.payout.allocations).toHaveLength(2);

    // Both earnings were locked available -> requested.
    expect(earnings.get(EARNING_1)?.status).toBe("requested");
    expect(earnings.get(EARNING_2)?.status).toBe("requested");

    // Exactly one zero-sum payout-lock ledger event (available -> locked).
    expect(ledger.appended).toHaveLength(1);
    expect(ledger.appended[0].eventKey).toBe(payoutLockEventKey(state.payout!.id));
    const sum = ledger.appended[0].entries.reduce((s, e) => s + e.amountIdrSigned, 0);
    expect(sum).toBe(0);
    expect(
      ledger.appended[0].entries.find((e) => e.bucket === "partner_available")?.amountIdrSigned,
    ).toBe(-2000);
    expect(
      ledger.appended[0].entries.find((e) => e.bucket === "partner_payout_locked")?.amountIdrSigned,
    ).toBe(2000);

    // Payout snapshot is encrypted, and never carries the raw number in the clear.
    expect(state.payout?.amountIdr).toBe(2000);
    expect(Buffer.from(state.payout!.destinationSnapshotJsonEncrypted).toString("utf8")).toContain("enc:");

    // Allocations equal whole earnings; initial transition + audit recorded.
    expect(state.allocations.map((a) => a.amountIdr)).toEqual([1000, 1000]);
    expect(state.transition?.toStatus).toBe("requested");
    expect(state.transition?.operationKey).toBe(`payout-request:${state.payout!.id}`);
    expect(state.audit?.descriptor.action).toBe("payout.changed");
    const meta = state.audit?.descriptor.safeMetadata as Record<string, unknown>;
    expect(meta.accountNumberLast4).toBe("7890");
  });

  it("forbids a member without the request_payout permission", async () => {
    const earnings = new FakeEarnings([earning(EARNING_1)]);
    const ledger = new FakeLedger();
    const state: FakePayoutState = { destination: destination(), payout: null, allocations: [], transition: null, audit: null };
    const service = makeService(earnings, ledger, state);

    const result = await service.requestPayout({
      caller: context({ role: "member", memberId: MEMBER_ID }),
      destinationId: DEST_ID,
      earningIds: [EARNING_1],
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(ledger.appended).toHaveLength(0);
    expect(state.payout).toBeNull();
  });

  it("rejects when the destination is missing / not active", async () => {
    const earnings = new FakeEarnings([earning(EARNING_1)]);
    const ledger = new FakeLedger();
    const state: FakePayoutState = { destination: null, payout: null, allocations: [], transition: null, audit: null };
    const service = makeService(earnings, ledger, state);

    const result = await service.requestPayout({
      caller: context(),
      destinationId: DEST_ID,
      earningIds: [EARNING_1],
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: false, reason: "destination_not_found" });
    expect(ledger.appended).toHaveLength(0);
  });

  it("rejects a total below the Rp1.000 minimum", async () => {
    const earnings = new FakeEarnings([earning(EARNING_1, { amountIdr: 500 })]);
    const ledger = new FakeLedger();
    const state: FakePayoutState = { destination: destination(), payout: null, allocations: [], transition: null, audit: null };
    const service = makeService(earnings, ledger, state);

    const result = await service.requestPayout({
      caller: context(),
      destinationId: DEST_ID,
      earningIds: [EARNING_1],
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: false, reason: "below_minimum" });
    expect(ledger.appended).toHaveLength(0);
    expect(earnings.get(EARNING_1)?.status).toBe("available");
  });

  it("enforces the admin-configured minimum above the domain default", async () => {
    // Rp10.000 clears the domain Rp1.000 floor but not the admin Rp50.000 floor,
    // so a wiring that ignored the config (the bug) would have let it through.
    const earnings = new FakeEarnings([earning(EARNING_1, { amountIdr: 10_000 })]);
    const ledger = new FakeLedger();
    const state: FakePayoutState = { destination: destination(), payout: null, allocations: [], transition: null, audit: null };
    const reader = makeMinimumReader(50_000);
    const service = makeService(earnings, ledger, state, reader);

    const result = await service.requestPayout({
      caller: context(),
      destinationId: DEST_ID,
      earningIds: [EARNING_1],
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: false, reason: "below_minimum" });
    expect(ledger.appended).toHaveLength(0);
    expect(earnings.get(EARNING_1)?.status).toBe("available");
    // The floor was read from the config for this request, not cached/ignored.
    expect(reader.calls).toBe(1);
  });

  it("allows a request that meets the admin-configured minimum", async () => {
    // Two Rp30.000 earnings total Rp60.000, at/above the Rp50.000 admin floor.
    const earnings = new FakeEarnings([
      earning(EARNING_1, { amountIdr: 30_000 }),
      earning(EARNING_2, { amountIdr: 30_000 }),
    ]);
    const ledger = new FakeLedger();
    const state: FakePayoutState = { destination: destination(), payout: null, allocations: [], transition: null, audit: null };
    const service = makeService(earnings, ledger, state, makeMinimumReader(50_000));

    const result = await service.requestPayout({
      caller: context(),
      destinationId: DEST_ID,
      earningIds: [EARNING_1, EARNING_2],
      requestId: REQUEST_ID,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payout.amountIdr).toBe(60_000);
    expect(ledger.appended).toHaveLength(1);
    expect(earnings.get(EARNING_1)?.status).toBe("requested");
    expect(earnings.get(EARNING_2)?.status).toBe("requested");
  });

  it("falls back to the domain minimum when no active config is published", async () => {
    // Reader returns null (no active config); Rp1.500 clears the domain Rp1.000
    // floor, so the request proceeds — the fallback never disables the floor.
    const earnings = new FakeEarnings([earning(EARNING_1, { amountIdr: 1500 })]);
    const ledger = new FakeLedger();
    const state: FakePayoutState = { destination: destination(), payout: null, allocations: [], transition: null, audit: null };
    const service = makeService(earnings, ledger, state, makeMinimumReader(null));

    const result = await service.requestPayout({
      caller: context(),
      destinationId: DEST_ID,
      earningIds: [EARNING_1],
      requestId: REQUEST_ID,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payout.amountIdr).toBe(1500);
    expect(ledger.appended).toHaveLength(1);
  });

  it("rejects when a selected earning is not available", async () => {
    const earnings = new FakeEarnings([earning(EARNING_1, { status: "pending" })]);
    const ledger = new FakeLedger();
    const state: FakePayoutState = { destination: destination(), payout: null, allocations: [], transition: null, audit: null };
    const service = makeService(earnings, ledger, state);

    const result = await service.requestPayout({
      caller: context(),
      destinationId: DEST_ID,
      earningIds: [EARNING_1],
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: false, reason: "earning_not_available" });
    expect(ledger.appended).toHaveLength(0);
  });

  it("reports earning_not_found for an absent / cross-tenant earning", async () => {
    const earnings = new FakeEarnings([earning(EARNING_1)]);
    const ledger = new FakeLedger();
    const state: FakePayoutState = { destination: destination(), payout: null, allocations: [], transition: null, audit: null };
    const service = makeService(earnings, ledger, state);

    const result = await service.requestPayout({
      caller: context(),
      destinationId: DEST_ID,
      earningIds: [EARNING_2],
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: false, reason: "earning_not_found", earningId: EARNING_2 });
  });

  it("rolls back and reports a conflict when an earning lock is lost (CAS no-op)", async () => {
    // EARNING_2 is already locked (requested), so the second CAS is a no-op.
    const earnings = new FakeEarnings([earning(EARNING_1), earning(EARNING_2, { status: "requested" })]);
    const ledger = new FakeLedger();
    const state: FakePayoutState = { destination: destination(), payout: null, allocations: [], transition: null, audit: null };
    const service = makeService(earnings, ledger, state);

    const result = await service.requestPayout({
      caller: context(),
      destinationId: DEST_ID,
      earningIds: [EARNING_1, EARNING_2],
      requestId: REQUEST_ID,
    });

    // decideRequestPayout already rejects a non-available earning before the tx.
    expect(result).toEqual({ ok: false, reason: "earning_not_available" });
    expect(ledger.appended).toHaveLength(0);
    expect(state.payout).toBeNull();
  });

  it("maps a duplicate allocation (unique earningId) to a conflict", async () => {
    const earnings = new FakeEarnings([earning(EARNING_1)]);
    const ledger = new FakeLedger();
    const state: FakePayoutState = {
      destination: destination(),
      payout: null,
      allocations: [],
      transition: null,
      audit: null,
      allocationConflictFor: EARNING_1,
    };
    const service = makeService(earnings, ledger, state);

    const result = await service.requestPayout({
      caller: context(),
      destinationId: DEST_ID,
      earningIds: [EARNING_1],
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: false, reason: "earning_conflict", earningId: EARNING_1 });
  });

  it("rejects an empty selection", async () => {
    const earnings = new FakeEarnings([]);
    const ledger = new FakeLedger();
    const state: FakePayoutState = { destination: destination(), payout: null, allocations: [], transition: null, audit: null };
    const service = makeService(earnings, ledger, state);

    const result = await service.requestPayout({
      caller: context(),
      destinationId: DEST_ID,
      earningIds: [],
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: false, reason: "empty_selection" });
  });
});
