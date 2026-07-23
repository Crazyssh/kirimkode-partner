import { beforeEach, describe, expect, it } from "vitest";

import {
  SmsDependencyUnavailableError,
  SmsIngestionService,
  SmsOwnershipMismatchError,
  SmsSuccessContentionError,
  type ApplySmsSuccessInput,
  type EncryptedField,
  type EncryptedSmsRecord,
  type IngestSmsInput,
  type OrderSuccessContext,
  type PartnerSmsGateway,
  type PartnerSmsInsertResult,
  type SafePartnerSmsView,
  type SmsAuditMatchStatus,
  type SmsCipher,
  type SmsMatchingConfig,
  type SmsMatchingGateway,
  type SmsOrderCandidateRow,
  type SmsOwnershipContext,
} from "./index";

/**
 * Unit tests for the task 12.2 SMS ingestion / matching pipeline.
 *
 * The pipeline is exercised entirely behind in-memory fakes (no Prisma, no
 * `node:crypto`), so each test pins one rule from design section 8:
 * ownership rejection, idempotent replay, exactly-one matching (zero /
 * one / many), the `wa` parser (keyword + single intact 6-digit candidate,
 * decoy rejection), the misdelivery guard (no OTP unless exactly one order
 * matches AND the parser extracts), and the compare-and-set contention on the
 * success transition.
 */
const PARTNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NUMBER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORDER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SMS_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = 1_700_000_000_000;
const KEY_VERSION = 7;

type Tx = { readonly id: "tx" };
const TX: Tx = Object.freeze({ id: "tx" });

class FakeClock {
  constructor(public value = NOW) {}
  nowEpochMs(): number {
    return this.value;
  }
}

class FakeIdGenerator {
  uuid(): string {
    return SMS_ID;
  }
}

class FakeRunner {
  async run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return work(TX);
  }
}

/**
 * Deterministic, reversible-looking-but-opaque cipher. Ciphertext is the UTF-8
 * bytes of the plaintext prefixed by a marker so a test can assert the value is
 * an envelope and never the raw string identity, while staying deterministic.
 */
class FakeCipher implements SmsCipher {
  readonly keyVersion = KEY_VERSION;
  encrypt(plaintext: string): EncryptedField {
    return {
      ciphertext: new TextEncoder().encode(`enc:${plaintext}`),
      keyVersion: this.keyVersion,
    };
  }
  fingerprint(plaintext: string): string {
    return `fp-${plaintext.length}-${plaintext.slice(0, 4)}`.padEnd(64, "0");
  }
}

function safeView(overrides: Partial<SafePartnerSmsView> = {}): SafePartnerSmsView {
  return Object.freeze({
    id: SMS_ID,
    deviceId: DEVICE_ID,
    numberId: NUMBER_ID,
    messageId: "msg-1",
    keyVersion: KEY_VERSION,
    bodyFingerprint: "fp".padEnd(64, "0"),
    matchStatus: "pending",
    matchedOrderId: null,
    receivedAtDeviceEpochMs: NOW - 2_000,
    receivedAtServerEpochMs: NOW,
    extractedAtEpochMs: null,
    redactedAtEpochMs: null,
    ...overrides,
  });
}

class FakeSmsGateway implements PartnerSmsGateway<Tx> {
  result: PartnerSmsInsertResult = { kind: "inserted", sms: safeView() };
  readonly inserted: EncryptedSmsRecord[] = [];
  async insertEncryptedSms(
    _tx: Tx,
    _partnerId: string,
    record: EncryptedSmsRecord,
  ): Promise<PartnerSmsInsertResult> {
    this.inserted.push(record);
    return this.result;
  }
}

interface MatchingState {
  ownership: SmsOwnershipContext | null;
  config: SmsMatchingConfig | null;
  candidates: readonly SmsOrderCandidateRow[];
  successContext: OrderSuccessContext | null;
  applyThrows: boolean;
}

class FakeMatchingGateway implements SmsMatchingGateway<Tx> {
  readonly applied: ApplySmsSuccessInput[] = [];
  readonly audited: Array<{ smsId: string; matchStatus: SmsAuditMatchStatus }> = [];
  constructor(private readonly state: MatchingState) {}

  async loadOwnershipContext(): Promise<SmsOwnershipContext | null> {
    return this.state.ownership;
  }
  async loadActiveConfig(): Promise<SmsMatchingConfig | null> {
    return this.state.config;
  }
  async loadActiveOrderCandidates(): Promise<readonly SmsOrderCandidateRow[]> {
    return this.state.candidates;
  }
  async loadSuccessContext(): Promise<OrderSuccessContext | null> {
    return this.state.successContext;
  }
  async applySuccess(_tx: Tx, input: ApplySmsSuccessInput): Promise<void> {
    if (this.state.applyThrows) throw new SmsSuccessContentionError();
    this.applied.push(input);
  }
  async markSmsAudited(
    _tx: Tx,
    input: Readonly<{ smsId: string; matchStatus: SmsAuditMatchStatus; nowEpochMs: number }>,
  ): Promise<void> {
    this.audited.push({ smsId: input.smsId, matchStatus: input.matchStatus });
  }
}

const OWNERSHIP: SmsOwnershipContext = Object.freeze({
  device: { id: DEVICE_ID, partnerId: PARTNER_ID },
  number: { id: NUMBER_ID, partnerId: PARTNER_ID, deviceId: DEVICE_ID },
});

function waitingCandidate(overrides: Partial<SmsOrderCandidateRow> = {}): SmsOrderCandidateRow {
  return Object.freeze({
    id: ORDER_ID,
    numberId: NUMBER_ID,
    serviceCode: "wa",
    status: "waiting_sms",
    windowStartsAtMs: NOW - 60_000,
    windowEndsAtMs: NOW + 60_000,
    ...overrides,
  });
}

const PAYOUT_IDR = 1_000;
const EARNING_HOLD_SECONDS = 24 * 60 * 60;

function successContext(overrides: Partial<OrderSuccessContext> = {}): OrderSuccessContext {
  return Object.freeze({
    orderId: ORDER_ID,
    partnerId: PARTNER_ID,
    numberId: NUMBER_ID,
    version: 3,
    orderStatus: "waiting_sms",
    numberStatus: "busy",
    otpReceived: false,
    numberEnabled: true,
    deviceStatus: "online",
    deviceLastSeenAtEpochMs: NOW - 5_000,
    payoutIdr: PAYOUT_IDR,
    earningExistsForOrder: false,
    ...overrides,
  });
}

function baseState(overrides: Partial<MatchingState> = {}): MatchingState {
  return {
    ownership: OWNERSHIP,
    config: { heartbeatTimeoutSeconds: 90, earningHoldSeconds: EARNING_HOLD_SECONDS },
    candidates: [waitingCandidate()],
    successContext: successContext(),
    applyThrows: false,
    ...overrides,
  };
}

function makeService(state: MatchingState): {
  service: SmsIngestionService<Tx>;
  smsGateway: FakeSmsGateway;
  matchingGateway: FakeMatchingGateway;
} {
  const smsGateway = new FakeSmsGateway();
  const matchingGateway = new FakeMatchingGateway(state);
  const service = new SmsIngestionService<Tx>({
    runner: new FakeRunner(),
    smsGateway,
    matchingGateway,
    cipher: new FakeCipher(),
    clock: new FakeClock(),
    idGenerator: new FakeIdGenerator(),
  });
  return { service, smsGateway, matchingGateway };
}

function input(overrides: Partial<IngestSmsInput> = {}): IngestSmsInput {
  return {
    principal: { partnerId: PARTNER_ID, deviceId: DEVICE_ID },
    numberId: NUMBER_ID,
    messageId: "msg-1",
    idempotencyKey: "idem-1",
    sender: "WhatsApp",
    body: "Your WhatsApp code is 123456",
    receivedAtDeviceEpochMs: NOW - 2_000,
    ...overrides,
  };
}

describe("SmsIngestionService", () => {
  let state: MatchingState;

  beforeEach(() => {
    state = baseState();
  });

  it("matches exactly one order, stores the encrypted OTP, and succeeds it", async () => {
    const { service, smsGateway, matchingGateway } = makeService(state);

    const result = await service.ingest(input());

    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("unreachable");
    expect(result.orderId).toBe(ORDER_ID);
    expect(result.sms.matchStatus).toBe("matched");
    expect(result.sms.matchedOrderId).toBe(ORDER_ID);

    // Exactly one success write, carrying an OTP *ciphertext* (never the raw
    // "123456"), the busy->available release, and the extracted key version.
    expect(matchingGateway.applied).toHaveLength(1);
    const applied = matchingGateway.applied[0];
    expect(applied.otpKeyVersion).toBe(KEY_VERSION);
    expect(new TextDecoder().decode(applied.otpCiphertext)).toBe("enc:123456");
    expect(applied.toNumberStatus).toBe("available");
    expect(applied.numberChanged).toBe(true);
    expect(matchingGateway.audited).toHaveLength(0);

    // Exactly one pending Earning at the snapshot payout, held 24h from now
    // (task 13.3; requirement 13.1).
    expect(applied.earning.amountIdr).toBe(PAYOUT_IDR);
    expect(applied.earning.availableAtEpochMs).toBe(NOW + EARNING_HOLD_SECONDS * 1_000);

    // The zero-sum `order-success` ledger event: payable -payout, pending
    // +payout, keyed uniquely on the order so a retry is a no-op.
    expect(applied.ledger.eventType).toBe("order-success");
    expect(applied.ledger.eventKey).toBe(`order-success:${ORDER_ID}`);
    expect(applied.ledger.entries).toEqual([
      { bucket: "platform_partner_payable", amountIdrSigned: -PAYOUT_IDR },
      { bucket: "partner_pending", amountIdrSigned: PAYOUT_IDR },
    ]);
    const ledgerSum = applied.ledger.entries.reduce(
      (total, entry) => total + entry.amountIdrSigned,
      0,
    );
    expect(ledgerSum).toBe(0);

    // The persisted SMS row carries ciphertext only, never plaintext.
    expect(smsGateway.inserted).toHaveLength(1);
    const record = smsGateway.inserted[0];
    expect(new TextDecoder().decode(record.bodyCiphertext)).toBe(
      "enc:Your WhatsApp code is 123456",
    );
  });

  it("rejects an SMS whose device/number are not owned by the tenant", async () => {
    state.ownership = null;
    const { service, smsGateway, matchingGateway } = makeService(state);

    await expect(service.ingest(input())).rejects.toBeInstanceOf(
      SmsOwnershipMismatchError,
    );
    // Nothing is persisted before the ownership check.
    expect(smsGateway.inserted).toHaveLength(0);
    expect(matchingGateway.applied).toHaveLength(0);
  });

  it("short-circuits a duplicate delivery before matching (idempotent replay)", async () => {
    // Ownership still resolves, but the insert reports the replay so the
    // pipeline returns the first result without re-matching.
    const matchingGateway = new FakeMatchingGateway(state);
    const smsGatewayDup = new FakeSmsGateway();
    smsGatewayDup.result = { kind: "duplicate", matchedBy: "message_id" };
    const service = new SmsIngestionService<Tx>({
      runner: new FakeRunner(),
      smsGateway: smsGatewayDup,
      matchingGateway,
      cipher: new FakeCipher(),
      clock: new FakeClock(),
      idGenerator: new FakeIdGenerator(),
    });

    const result = await service.ingest(input());

    expect(result).toEqual({ status: "duplicate", matchedBy: "message_id" });
    // No matching or OTP work happens on a replay.
    expect(matchingGateway.applied).toHaveLength(0);
    expect(matchingGateway.audited).toHaveLength(0);
  });

  it("marks unmatched with no OTP when zero orders are active", async () => {
    state.candidates = [];
    const { service, matchingGateway } = makeService(state);

    const result = await service.ingest(input());

    expect(result.status).toBe("unmatched");
    if (result.status !== "unmatched") throw new Error("unreachable");
    expect(result.reason).toBe("no_active_order");
    expect(matchingGateway.applied).toHaveLength(0);
    expect(matchingGateway.audited).toEqual([{ smsId: SMS_ID, matchStatus: "unmatched" }]);
  });

  it("marks ambiguous with no OTP when more than one order matches", async () => {
    state.candidates = [
      waitingCandidate({ id: ORDER_ID }),
      waitingCandidate({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
    ];
    const { service, matchingGateway } = makeService(state);

    const result = await service.ingest(input());

    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") throw new Error("unreachable");
    expect(result.candidateOrderIds).toHaveLength(2);
    // No OTP is ever delivered to any candidate (requirement 11.5).
    expect(matchingGateway.applied).toHaveLength(0);
    expect(matchingGateway.audited).toEqual([{ smsId: SMS_ID, matchStatus: "ambiguous" }]);
  });

  it("does not misdeliver when the single matched order fails the wa parser", async () => {
    // Missing keyword: exactly one order matches, but no OTP may be extracted.
    const { service, matchingGateway } = makeService(state);

    const result = await service.ingest(input({ body: "your number is 123456" }));

    expect(result.status).toBe("unmatched");
    if (result.status !== "unmatched") throw new Error("unreachable");
    expect(result.reason).toBe("missing_keyword");
    expect(matchingGateway.applied).toHaveLength(0);
    expect(matchingGateway.audited).toEqual([{ smsId: SMS_ID, matchStatus: "unmatched" }]);
  });

  it("rejects a decoy candidate rather than delivering a labelled non-OTP number", async () => {
    const { service, matchingGateway } = makeService(state);

    const result = await service.ingest(
      input({ body: "WhatsApp verification. phone: 123456" }),
    );

    expect(result.status).toBe("unmatched");
    if (result.status !== "unmatched") throw new Error("unreachable");
    expect(result.reason).toBe("decoy_candidate");
    expect(matchingGateway.applied).toHaveLength(0);
  });

  it("never creates a second Earning when one already exists for the order", async () => {
    // A re-success (e.g. the order already succeeded and carries an Earning):
    // the dedupe guard blocks a second Earning / duplicate ledger entries and
    // no OTP is re-delivered (requirement 13.7).
    state.successContext = successContext({ earningExistsForOrder: true });
    const { service, matchingGateway } = makeService(state);

    const result = await service.ingest(input());

    expect(result.status).toBe("unmatched");
    if (result.status !== "unmatched") throw new Error("unreachable");
    expect(result.reason).toBe("no_active_order");
    expect(matchingGateway.applied).toHaveLength(0);
    expect(matchingGateway.audited).toEqual([{ smsId: SMS_ID, matchStatus: "unmatched" }]);
  });

  it("audits unmatched when the order moved on before the success transition", async () => {
    state.successContext = successContext({ orderStatus: "timeout" });
    const { service, matchingGateway } = makeService(state);

    const result = await service.ingest(input());

    expect(result.status).toBe("unmatched");
    if (result.status !== "unmatched") throw new Error("unreachable");
    expect(result.reason).toBe("no_active_order");
    expect(matchingGateway.applied).toHaveLength(0);
  });

  it("surfaces a success contention as a retryable error with nothing delivered", async () => {
    state.applyThrows = true;
    const { service, matchingGateway } = makeService(state);

    await expect(service.ingest(input())).rejects.toBeInstanceOf(
      SmsSuccessContentionError,
    );
    expect(matchingGateway.applied).toHaveLength(0);
  });

  it("raises a dependency error when active config is missing on a match", async () => {
    state.config = null;
    const { service } = makeService(state);

    await expect(service.ingest(input())).rejects.toBeInstanceOf(
      SmsDependencyUnavailableError,
    );
  });
});
