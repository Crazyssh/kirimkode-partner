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
  /**
   * Set once a successful order's number hold was released (buyer completed, or
   * the expiry sweep closed it). A `success` order is only still eligible —
   * "listening" for a repeat OTP — while this is null and its window is open.
   *
   * Required, not optional: an absent value would otherwise read as "hold never
   * released" and quietly make a closed order eligible again, so every caller
   * must state the hold explicitly.
   */
  readonly completedAtMs: number | null;
}

/**
 * How the matched order relates to this SMS: `first` settles the order (money
 * is created once), `repeat` refreshes the OTP of an order that already
 * succeeded and is still listening.
 */
export type SmsMatchMode = "first" | "repeat";

export type SmsOrderMatch =
  | Readonly<{ status: "matched"; orderId: string; serviceCode: string; mode: SmsMatchMode }>
  | Readonly<{ status: "unmatched"; candidateOrderIds: readonly string[] }>
  | Readonly<{ status: "ambiguous"; candidateOrderIds: readonly string[] }>;

/** True when this candidate may still receive an SMS at `receivedAtMs`. */
function isEligible(order: SmsOrderCandidate, numberId: string, receivedAtMs: number): boolean {
  if (order.numberId !== numberId) return false;
  // `waiting_sms` awaits its first code; a still-listening `success` order awaits
  // a repeat. Any other status — including a success whose hold was already
  // released — no longer holds the number and must never match.
  const awaitsFirst = order.status === "waiting_sms";
  const awaitsRepeat = order.status === "success" && order.completedAtMs === null;
  if (!awaitsFirst && !awaitsRepeat) return false;
  return Number.isFinite(receivedAtMs)
    && Number.isFinite(order.windowStartsAtMs)
    && Number.isFinite(order.windowEndsAtMs)
    && order.windowStartsAtMs <= order.windowEndsAtMs
    && receivedAtMs >= order.windowStartsAtMs
    && receivedAtMs <= order.windowEndsAtMs;
}

export function matchSmsToActiveOrder(input: Readonly<{
  numberId: string;
  receivedAtMs: number;
  orders: readonly SmsOrderCandidate[];
}>): SmsOrderMatch {
  const matches = input.orders.filter((order) =>
    isEligible(order, input.numberId, input.receivedAtMs));

  if (matches.length === 0) {
    return Object.freeze({ status: "unmatched", candidateOrderIds: Object.freeze([]) });
  }
  // Fail closed: a number is held by exactly one order, so overlapping
  // candidates mean the projection is inconsistent — deliver to nobody.
  if (matches.length > 1) {
    const candidateOrderIds = Object.freeze(matches.map(({ id }) => id).sort());
    return Object.freeze({ status: "ambiguous", candidateOrderIds });
  }
  const match = matches[0];
  return Object.freeze({
    status: "matched",
    orderId: match.id,
    serviceCode: match.serviceCode,
    mode: match.status === "success" ? "repeat" : "first",
  });
}

/**
 * Whole-word keywords a `wa` body must contain. Deliberately ONLY the brand
 * word: every real WhatsApp verification SMS (regular/Business, ID/EN) contains
 * "WhatsApp", while generic words like "kode"/"code"/"verification" also appear
 * in bank/Google/other-service OTPs — with those in the list, a foreign 6-digit
 * OTP arriving during a WA order window would be misdelivered as the WA OTP.
 */
export const DEFAULT_WHATSAPP_OTP_KEYWORDS = Object.freeze([
  "WhatsApp",
] as const);

/**
 * Case-folded substring markers of senders that clearly belong to another
 * service. A foreign-sender SMS is rejected before its body is even parsed —
 * the second defence layer next to the brand-keyword requirement. The list is
 * deliberately conservative (unambiguous brand names only): WhatsApp SMS
 * arrive from "WhatsApp"-style ids, shortcodes, or plain numbers, and a false
 * block on a legitimate route would lose a real OTP.
 */
export const DEFAULT_FOREIGN_SENDER_MARKERS = Object.freeze([
  "telegram", "google", "facebook", "instagram", "tiktok",
  "tokopedia", "shopee", "lazada", "gojek", "grab",
  "dana", "ovo", "linkaja", "bca", "mandiri", "bni", "bri",
] as const);

/** True when the observed sender id clearly names another service. */
export function isForeignServiceSender(
  sender: string,
  markers: readonly string[] = DEFAULT_FOREIGN_SENDER_MARKERS,
): boolean {
  if (typeof sender !== "string" || sender.length === 0) return false;
  const folded = sender.toLocaleLowerCase("en-US");
  return markers.some((marker) => marker.length > 0 && folded.includes(marker));
}

export interface WhatsAppOtpRule {
  readonly keywords?: readonly string[];
  /** Observed SMS sender id; when it names another service the parse rejects. */
  readonly sender?: string;
  readonly foreignSenderMarkers?: readonly string[];
}

export type OtpParseResult =
  | Readonly<{ status: "matched"; otp: string }>
  | Readonly<{ status: "rejected"; reason:
    | "unsupported_service"
    | "foreign_sender"
    | "missing_keyword"
    | "no_candidate"
    | "ambiguous_candidates"
    | "decoy_candidate" }>;
const unicodeWordCharacter = /[\p{L}\p{N}_]/u;
const unicodeDecimalDigit = /\p{Nd}/u;
// The label must be a whole word: the leading negative lookbehind forbids a
// preceding Unicode word character so a substring inside a longer word (the
// `date` in `update`, `tel` in `hotel`, `phone` in `iPhone`) is not mistaken
// for a phone/date decoy label and does not reject a legitimate adjacent OTP.
const directDecoyLabel =
  /(?<![\p{L}\p{N}_])(?:date|tanggal|phone|tel|nomor|telepon)\s*[:#-]?\s*$/iu;

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

/**
 * Collect standalone OTP candidates. Two shapes count: six contiguous ASCII
 * digits, and the real WhatsApp wire format of two three-digit groups joined
 * by a single hyphen (`718-891`), which normalizes to the same six digits. A
 * candidate is only intact when no decimal digit borders it, and a hyphenated
 * pair must additionally stand alone — when its hyphen chain continues with
 * more digits on either side (phones such as `0812-345-6789`, dashed ids,
 * ranges) the pair is a fragment of a longer number, never an OTP.
 */
function intactSixDigitCandidates(body: string): ReadonlyArray<Readonly<{ value: string; index: number }>> {
  const candidates: Array<Readonly<{ value: string; index: number }>> = [];
  for (const match of body.matchAll(/[0-9]{6}|[0-9]{3}-[0-9]{3}/g)) {
    const index = match.index;
    const raw = match[0];
    const before = index === 0 ? "" : body[index - 1];
    const afterIndex = index + raw.length;
    const after = afterIndex === body.length ? "" : body[afterIndex];
    if ((before !== "" && unicodeDecimalDigit.test(before))
      || (after !== "" && unicodeDecimalDigit.test(after))) {
      continue;
    }
    if (raw.includes("-")) {
      const beforeBefore = index >= 2 ? body[index - 2] : "";
      const afterAfter = afterIndex + 1 < body.length ? body[afterIndex + 1] : "";
      const chainBefore = before === "-" && beforeBefore !== "" && unicodeDecimalDigit.test(beforeBefore);
      const chainAfter = after === "-" && afterAfter !== "" && unicodeDecimalDigit.test(afterAfter);
      if (chainBefore || chainAfter) continue;
    }
    candidates.push(Object.freeze({ value: raw.replace("-", ""), index }));
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
  if (
    rule.sender !== undefined
    && isForeignServiceSender(rule.sender, rule.foreignSenderMarkers ?? DEFAULT_FOREIGN_SENDER_MARKERS)
  ) {
    return Object.freeze({ status: "rejected", reason: "foreign_sender" });
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
