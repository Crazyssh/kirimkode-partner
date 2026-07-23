/**
 * SMS ingestion / matching pipeline service (task 12.2).
 *
 * Turns one authenticated inbound SMS into a deterministic, misdelivery-proof
 * outcome, reusing the pieces built earlier so each rule lives in exactly one
 * place. The whole flow runs inside a single transaction (design section 8:
 * "Pencocokan, update order success ... dilakukan dalam satu transaksi
 * idempotent") so either every effect commits or none does:
 *
 *  1. **Ownership (task 5.4 `decideSmsIngress`).** The device + number are
 *     loaded scoped to the trusted tenant; a cross-tenant / missing pairing is
 *     rejected before anything is persisted (requirement 11.1). Deduplication
 *     is enforced by the persistence layer's unique constraints, not by
 *     re-reading history here.
 *  2. **Encrypt + persist (task 12.1).** The sender/body are encrypted and the
 *     row is inserted via {@link import("./ports").PartnerSmsGateway}. A replay
 *     resolves to `duplicate` on `(deviceId, messageId)` / `(deviceId,
 *     idempotencyKey)`, and the pipeline short-circuits deterministically
 *     without re-matching (idempotent replay; requirement 11.3).
 *  3. **Match (task 5.4 `matchSmsToActiveOrder`).** Among the `waiting_sms`
 *     orders on the number, the SMS matches only when its server-received
 *     instant falls inside exactly one order's window. Zero → `unmatched`,
 *     more than one → `ambiguous`; neither delivers an OTP (requirements 11.4,
 *     11.5).
 *  4. **Parse (task 5.4 `parseServiceOtp`).** For the single matched order the
 *     `wa` rule requires a configured keyword and exactly one intact 6-digit
 *     candidate; decoys / ambiguity / missing keyword are rejected and the SMS
 *     is stored `unmatched` with the order untouched (requirement 11.7; generic
 *     fallback stays off).
 *  5. **Succeed (task 5.5 `decideOrderNumberTransition`, task 5.6
 *     `decideEarningOnSuccess`).** On extraction the encrypted OTP is stored on
 *     the order, the order flips `waiting_sms → success`, the number is released
 *     (`busy → available|offline`) by `decideNumberRelease`, exactly one pending
 *     Earning is created from the immutable snapshot payout, and the zero-sum
 *     `order-success` ledger event (payable → pending) is appended — all in this
 *     one transaction via a compare-and-set (task 13.3; design section 8:
 *     "Pencocokan, update order success, pembuatan earning, dan ledger event
 *     dilakukan dalam satu transaksi idempotent"). A concurrent change fails the
 *     compare-and-set and rolls the whole unit back, and the `orderId` /
 *     `eventKey` unique constraints guarantee a retried success never produces a
 *     second Earning or duplicate ledger entries (requirements 13.1, 13.7).
 *
 * Raw SMS/OTP text is encrypted immediately and never returned, logged, or
 * echoed; every outcome carries only the redaction-safe {@link SafePartnerSmsView}.
 */
import {
  decideSmsIngress,
  matchSmsToActiveOrder,
  parseServiceOtp,
  type OtpParseResult,
} from "@domain/sms-matching-otp";
import { decideOrderNumberTransition } from "@domain/order-state-machine";
import { decideEarningOnSuccess } from "@domain/task-5-6";

import type {
  EncryptedSmsRecord,
  PartnerSmsGateway,
  SafePartnerSmsView,
  SmsCipher,
} from "./ports";
import { encryptInboundSms, encryptOtp } from "./sms-encryption";
import {
  SmsSuccessContentionError,
  type Clock,
  type IdGenerator,
  type SmsMatchingGateway,
  type SmsMatchingTransactionRunner,
} from "./matching-ports";

export { SmsSuccessContentionError };

/**
 * Raised when the SMS does not belong to the authenticated device/number under
 * the trusted tenant. Opaque by design (indistinguishable from a missing
 * resource) so a caller cannot probe another tenant's inventory; the task 12.3
 * endpoint maps it to `RESOURCE_NOT_FOUND`.
 */
export class SmsOwnershipMismatchError extends Error {
  constructor() {
    super("The SMS does not belong to the authenticated device and number");
    this.name = "SmsOwnershipMismatchError";
  }
}

/** Why a stored SMS carries no OTP. `no_active_order` covers zero-candidate and
 * lost-race cases; the remaining reasons mirror the `wa` parser rejections. */
export type SmsUnmatchedReason =
  | "no_active_order"
  | Extract<OtpParseResult, { status: "rejected" }>["reason"];

/**
 * The deterministic outcome of ingesting one SMS. Every processed variant
 * carries the redaction-safe view of the persisted row; `duplicate` short-
 * circuits an idempotent replay before matching.
 */
export type SmsIngestionResult =
  | Readonly<{ status: "duplicate"; matchedBy: "message_id" | "idempotency_key" }>
  | Readonly<{ status: "matched"; sms: SafePartnerSmsView; orderId: string }>
  | Readonly<{ status: "unmatched"; sms: SafePartnerSmsView; reason: SmsUnmatchedReason }>
  | Readonly<{
      status: "ambiguous";
      sms: SafePartnerSmsView;
      candidateOrderIds: readonly string[];
    }>;

/** The authenticated, validated inbound SMS the endpoint (task 12.3) supplies. */
export interface IngestSmsInput {
  /** Identity comes solely from the authenticated device principal. */
  readonly principal: Readonly<{ partnerId: string; deviceId: string }>;
  readonly numberId: string;
  readonly messageId: string;
  readonly idempotencyKey: string;
  /** Raw sender, encrypted immediately and never retained as plaintext. */
  readonly sender: string;
  /** Raw body, encrypted immediately and parsed in-memory only. */
  readonly body: string;
  readonly receivedAtDeviceEpochMs: number;
}

export interface SmsIngestionServiceDeps<Tx> {
  readonly runner: SmsMatchingTransactionRunner<Tx>;
  readonly smsGateway: PartnerSmsGateway<Tx>;
  readonly matchingGateway: SmsMatchingGateway<Tx>;
  readonly cipher: SmsCipher;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

/** A dependency (e.g. missing active config) is temporarily unavailable. */
export class SmsDependencyUnavailableError extends Error {
  constructor() {
    super("A required dependency is unavailable");
    this.name = "SmsDependencyUnavailableError";
  }
}

export class SmsIngestionService<Tx> {
  private readonly deps: SmsIngestionServiceDeps<Tx>;

  constructor(deps: SmsIngestionServiceDeps<Tx>) {
    this.deps = deps;
  }

  /**
   * Ingest one SMS. Returns a deterministic {@link SmsIngestionResult}; throws
   * {@link SmsOwnershipMismatchError} for an ownership violation and
   * {@link SmsSuccessContentionError} for a lost compare-and-set race (both
   * roll the transaction back with nothing persisted so a retry is safe).
   */
  async ingest(input: IngestSmsInput): Promise<SmsIngestionResult> {
    return this.deps.runner.run((tx) => this.runIngest(tx, input));
  }

  private async runIngest(tx: Tx, input: IngestSmsInput): Promise<SmsIngestionResult> {
    const { matchingGateway, smsGateway, cipher } = this.deps;
    const nowEpochMs = this.deps.clock.nowEpochMs();

    // 1. Ownership: resolve the device + number under the trusted tenant and let
    //    the pure policy decide. Dedup is enforced by the DB unique constraints,
    //    so no prior-message history is consulted here.
    const ownership = await matchingGateway.loadOwnershipContext(
      tx,
      input.principal.partnerId,
      input.principal.deviceId,
      input.numberId,
    );
    if (ownership === null) throw new SmsOwnershipMismatchError();

    const ingress = decideSmsIngress({
      principal: input.principal,
      device: ownership.device,
      number: ownership.number,
      messageId: input.messageId,
      idempotencyKey: input.idempotencyKey,
      priorMessages: [],
    });
    if (ingress.kind !== "accept") throw new SmsOwnershipMismatchError();

    // 2. Encrypt + persist. A replay resolves to `duplicate` and short-circuits.
    const encrypted = encryptInboundSms(cipher, {
      sender: input.sender,
      body: input.body,
    });
    const record: EncryptedSmsRecord = {
      id: this.deps.idGenerator.uuid(),
      deviceId: input.principal.deviceId,
      numberId: input.numberId,
      messageId: input.messageId,
      idempotencyKey: input.idempotencyKey,
      senderCiphertext: encrypted.senderCiphertext,
      bodyCiphertext: encrypted.bodyCiphertext,
      keyVersion: encrypted.keyVersion,
      bodyFingerprint: encrypted.bodyFingerprint,
      receivedAtDeviceEpochMs: input.receivedAtDeviceEpochMs,
    };
    const insert = await smsGateway.insertEncryptedSms(tx, input.principal.partnerId, record);
    if (insert.kind === "duplicate") {
      return Object.freeze({ status: "duplicate", matchedBy: insert.matchedBy });
    }
    const sms = insert.sms;

    // 3. Match against the `waiting_sms` orders on the number, keyed on the
    //    authoritative server-received instant.
    const candidates = await matchingGateway.loadActiveOrderCandidates(
      tx,
      input.principal.partnerId,
      input.numberId,
    );
    const match = matchSmsToActiveOrder({
      numberId: input.numberId,
      receivedAtMs: sms.receivedAtServerEpochMs,
      orders: candidates,
    });

    if (match.status === "unmatched") {
      return this.audit(tx, sms, "unmatched", "no_active_order", nowEpochMs);
    }
    if (match.status === "ambiguous") {
      await matchingGateway.markSmsAudited(tx, {
        smsId: sms.id,
        matchStatus: "ambiguous",
        nowEpochMs,
      });
      return Object.freeze({
        status: "ambiguous",
        sms: withStatus(sms, "ambiguous", null, null),
        candidateOrderIds: match.candidateOrderIds,
      });
    }

    // 4. Exactly one order matched: parse the service-specific OTP.
    const parse = parseServiceOtp(match.serviceCode, input.body);
    if (parse.status === "rejected") {
      return this.audit(tx, sms, "unmatched", parse.reason, nowEpochMs);
    }

    // 5. Extract succeeded: transition the order `waiting_sms → success`.
    const context = await matchingGateway.loadSuccessContext(tx, match.orderId);
    if (context === null || context.orderStatus !== "waiting_sms") {
      // The order changed since the candidate load (a concurrent success or
      // timeout). No OTP is delivered; the SMS is stored for audit.
      return this.audit(tx, sms, "unmatched", "no_active_order", nowEpochMs);
    }

    const config = await matchingGateway.loadActiveConfig(tx);
    if (config === null) throw new SmsDependencyUnavailableError();

    const decision = decideOrderNumberTransition({
      orderId: context.orderId,
      orderStatus: context.orderStatus,
      numberStatus: context.numberStatus,
      otpReceived: context.otpReceived,
      command: {
        type: "succeed",
        release: {
          numberEnabled: context.numberEnabled,
          deviceStatus: context.deviceStatus,
          deviceLastSeenAtMs: context.deviceLastSeenAtEpochMs,
          observedAtMs: nowEpochMs,
          heartbeatTimeoutMs: config.heartbeatTimeoutSeconds * 1000,
        },
      },
    });
    if (decision.kind !== "apply") {
      // The state machine refused the success (e.g. OTP already received, or a
      // number-state mismatch). Never misdeliver: store the SMS for audit.
      return this.audit(tx, sms, "unmatched", "no_active_order", nowEpochMs);
    }

    // Decide the single pending Earning + zero-sum ledger success event in the
    // pure domain (task 5.6). The payout amount is the immutable snapshot value
    // and the hold comes from config; `earningExistsForOrder` dedupes a replay.
    const earningDecision = decideEarningOnSuccess({
      earningId: this.deps.idGenerator.uuid(),
      orderId: context.orderId,
      payoutIdr: context.payoutIdr,
      succeededAt: new Date(nowEpochMs),
      holdPeriodMs: config.earningHoldSeconds * 1000,
      earningExistsForOrder: context.earningExistsForOrder,
    });
    if (earningDecision.kind !== "create") {
      // An Earning already exists for this order: the order was already
      // succeeded. Never create a second Earning or re-deliver; audit the SMS.
      return this.audit(tx, sms, "unmatched", "no_active_order", nowEpochMs);
    }

    const otp = encryptOtp(cipher, parse.otp);
    await matchingGateway.applySuccess(tx, {
      smsId: sms.id,
      orderId: context.orderId,
      partnerId: context.partnerId,
      numberId: context.numberId,
      expectedOrderVersion: context.version,
      fromNumberStatus: context.numberStatus,
      toNumberStatus: decision.nextNumberStatus,
      numberChanged: decision.numberChanged,
      otpCiphertext: otp.otpCiphertext,
      otpKeyVersion: otp.otpKeyVersion,
      otpFingerprint: otp.otpFingerprint,
      operationKey: decision.operationKey,
      actorRef: input.principal.deviceId,
      nowEpochMs,
      earning: {
        id: earningDecision.earning.id,
        amountIdr: earningDecision.earning.amountIdr,
        availableAtEpochMs: earningDecision.earning.availableAt.getTime(),
      },
      ledger: earningDecision.transaction,
    });

    return Object.freeze({
      status: "matched",
      sms: withStatus(sms, "matched", context.orderId, nowEpochMs),
      orderId: context.orderId,
    });
  }

  /** Persist an `unmatched` audit status (no OTP) and return the outcome. */
  private async audit(
    tx: Tx,
    sms: SafePartnerSmsView,
    matchStatus: "unmatched",
    reason: SmsUnmatchedReason,
    nowEpochMs: number,
  ): Promise<SmsIngestionResult> {
    await this.deps.matchingGateway.markSmsAudited(tx, {
      smsId: sms.id,
      matchStatus,
      nowEpochMs,
    });
    return Object.freeze({
      status: "unmatched",
      sms: withStatus(sms, "unmatched", null, null),
      reason,
    });
  }
}

/**
 * Reproject the redaction-safe view with the final match outcome, so the
 * returned DTO reflects the committed row without a second read. Only opaque
 * status fields change; no ciphertext or plaintext is ever present.
 */
function withStatus(
  sms: SafePartnerSmsView,
  matchStatus: SafePartnerSmsView["matchStatus"],
  matchedOrderId: string | null,
  extractedAtEpochMs: number | null,
): SafePartnerSmsView {
  return Object.freeze({
    ...sms,
    matchStatus,
    matchedOrderId,
    extractedAtEpochMs,
  });
}
