export type SmsIngressDecision =
  | Readonly<{ kind: "accept" }>
  | Readonly<{ kind: "duplicate"; matchedBy: "message_id" | "idempotency_key" }>
  | Readonly<{ kind: "reject"; reason: "ownership_mismatch" }>;

export interface SmsIngressPolicyInput {
  readonly principal: Readonly<{ partnerId: string; deviceId: string }>;
  readonly device: Readonly<{ id: string; partnerId: string }>;
  readonly number: Readonly<{ id: string; partnerId: string; deviceId: string }>;
  readonly messageId: string;
  readonly idempotencyKey: string;
  readonly priorMessages: readonly Readonly<{
    deviceId: string;
    messageId: string;
    idempotencyKey: string;
  }>[];
}

export function decideSmsIngress(input: SmsIngressPolicyInput): SmsIngressDecision {
  const ownsDevice = input.principal.deviceId === input.device.id
    && input.principal.partnerId === input.device.partnerId;
  const ownsNumber = input.number.deviceId === input.device.id
    && input.number.partnerId === input.device.partnerId;
  if (!ownsDevice || !ownsNumber) {
    return Object.freeze({ kind: "reject", reason: "ownership_mismatch" });
  }
  const sameDeviceMessages = input.priorMessages.filter(({ deviceId }) => deviceId === input.device.id);
  if (sameDeviceMessages.some(({ messageId }) => messageId === input.messageId)) {
    return Object.freeze({ kind: "duplicate", matchedBy: "message_id" });
  }
  if (sameDeviceMessages.some(({ idempotencyKey }) => idempotencyKey === input.idempotencyKey)) {
    return Object.freeze({ kind: "duplicate", matchedBy: "idempotency_key" });
  }
  return Object.freeze({ kind: "accept" });
}
export interface SmsOrderCandidate {
  readonly id: string;
  readonly numberId: string;
  readonly serviceCode: string;
  readonly status: string;
  readonly windowStartsAtMs: number;
  readonly windowEndsAtMs: number;
}

export type SmsOrderMatch =
  | Readonly<{ status: "matched"; orderId: string; serviceCode: string }>
  | Readonly<{ status: "unmatched"; candidateOrderIds: readonly string[] }>
  | Readonly<{ status: "ambiguous"; candidateOrderIds: readonly string[] }>;

export function matchSmsToActiveOrder(input: Readonly<{
  numberId: string;
  receivedAtMs: number;
  orders: readonly SmsOrderCandidate[];
}>): SmsOrderMatch {
  const matches = input.orders.filter((order) => order.numberId === input.numberId
    && order.status === "waiting_sms"
    && Number.isFinite(input.receivedAtMs)
    && Number.isFinite(order.windowStartsAtMs)
    && Number.isFinite(order.windowEndsAtMs)
    && order.windowStartsAtMs <= order.windowEndsAtMs
    && input.receivedAtMs >= order.windowStartsAtMs
    && input.receivedAtMs <= order.windowEndsAtMs);

  if (matches.length === 0) {
    return Object.freeze({ status: "unmatched", candidateOrderIds: Object.freeze([]) });
  }
  if (matches.length > 1) {
    const candidateOrderIds = Object.freeze(matches.map(({ id }) => id).sort());
    return Object.freeze({ status: "ambiguous", candidateOrderIds });
  }
  const match = matches[0];
  return Object.freeze({ status: "matched", orderId: match.id, serviceCode: match.serviceCode });
}

export const DEFAULT_WHATSAPP_OTP_KEYWORDS = Object.freeze([
  "WhatsApp", "kode", "code", "verification", "verifikasi",
] as const);

export interface WhatsAppOtpRule {
  readonly keywords?: readonly string[];
}

export type OtpParseResult =
  | Readonly<{ status: "matched"; otp: string }>
  | Readonly<{ status: "rejected"; reason:
    | "unsupported_service"
    | "missing_keyword"
    | "no_candidate"
    | "ambiguous_candidates"
    | "decoy_candidate" }>;
const unicodeWordCharacter = /[\p{L}\p{N}_]/u;
const unicodeDecimalDigit = /\p{Nd}/u;
const directDecoyLabel = /(?:date|tanggal|phone|tel|nomor|telepon)\s*[:#-]?\s*$/iu;

function hasKeyword(body: string, configuredKeywords: readonly string[]): boolean {
  const foldedBody = body.toLocaleLowerCase("en-US");
  return configuredKeywords.some((rawKeyword) => {
    const keyword = rawKeyword.trim().toLocaleLowerCase("en-US");
    if (keyword.length === 0) return false;
    let fromIndex = 0;
    while (fromIndex <= foldedBody.length - keyword.length) {
      const index = foldedBody.indexOf(keyword, fromIndex);
      if (index < 0) return false;
      const before = index === 0 ? "" : foldedBody[index - 1];
      const afterIndex = index + keyword.length;
      const after = afterIndex === foldedBody.length ? "" : foldedBody[afterIndex];
      if ((!before || !unicodeWordCharacter.test(before))
        && (!after || !unicodeWordCharacter.test(after))) return true;
      fromIndex = index + 1;
    }
    return false;
  });
}

function intactSixDigitCandidates(body: string): ReadonlyArray<Readonly<{ value: string; index: number }>> {
  const candidates: Array<Readonly<{ value: string; index: number }>> = [];
  for (const match of body.matchAll(/[0-9]{6}/g)) {
    const index = match.index;
    const value = match[0];
    const before = index === 0 ? "" : body[index - 1];
    const afterIndex = index + value.length;
    const after = afterIndex === body.length ? "" : body[afterIndex];
    if ((!before || !unicodeDecimalDigit.test(before))
      && (!after || !unicodeDecimalDigit.test(after))) {
      candidates.push(Object.freeze({ value, index }));
    }
  }
  return candidates;
}

export function parseServiceOtp(
  serviceCode: string,
  body: string,
  rule: WhatsAppOtpRule = {},
): OtpParseResult {
  if (serviceCode !== "wa") {
    return Object.freeze({ status: "rejected", reason: "unsupported_service" });
  }
  const keywords = rule.keywords ?? DEFAULT_WHATSAPP_OTP_KEYWORDS;
  if (!hasKeyword(body, keywords)) {
    return Object.freeze({ status: "rejected", reason: "missing_keyword" });
  }
  const candidates = intactSixDigitCandidates(body);
  if (candidates.length === 0) {
    return Object.freeze({ status: "rejected", reason: "no_candidate" });
  }
  if (candidates.length > 1) {
    return Object.freeze({ status: "rejected", reason: "ambiguous_candidates" });
  }
  const candidate = candidates[0];
  const immediatePrefix = body.slice(Math.max(0, candidate.index - 24), candidate.index);
  if (directDecoyLabel.test(immediatePrefix)) {
    return Object.freeze({ status: "rejected", reason: "decoy_candidate" });
  }
  return Object.freeze({ status: "matched", otp: candidate.value });
}
