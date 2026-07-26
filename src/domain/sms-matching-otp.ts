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
 * The wire shape of one service's code. `digitLength` is the number of
 * contiguous ASCII digits that forms a candidate; `groupedForm` additionally
 * accepts the same digits split into groups by a literal separator (WhatsApp's
 * `718-891`). A service without `groupedForm` accepts contiguous digits only,
 * so a dashed run is never mistaken for its code.
 */
export interface OtpCodeShape {
  readonly digitLength: number;
  readonly groupedForm?: Readonly<{
    readonly groupSizes: readonly number[];
    readonly separator: string;
  }>;
}

/** One registry entry: everything that makes a service's OTP recognisable. */
export interface ServiceOtpSpec {
  /**
   * Whole-word keywords the body must contain. Deliberately ONLY brand words:
   * generic words like "kode"/"code"/"verification" appear in every service's
   * OTP, so including them would let a foreign 6-digit OTP arriving inside this
   * order's window be misdelivered as this service's code.
   */
  readonly keywords: readonly string[];
  /**
   * Case-folded substring markers that identify THIS service's own sender ids.
   * Never treated as foreign for its own orders, and treated as foreign for
   * every other service — see {@link foreignSenderMarkersFor}.
   */
  readonly senderBrandMarkers: readonly string[];
  readonly codeShape: OtpCodeShape;
}

/**
 * Per-service parse rules. Adding a service is a data change here — nothing
 * downstream branches on the service code.
 *
 * Every entry encodes an observed real-world message shape, not a guess:
 *
 * - **`wa` (WhatsApp).** Verbatim Business SMS: "Kode WhatsApp Business Anda:
 *   718-891" plus an app-hash line; the EN variant is "Your WhatsApp code:
 *   123-456". Six digits, sent either contiguous or as two three-digit groups
 *   joined by one hyphen, so `groupedForm` is 3+3. The brand word appears in
 *   every regular/Business, ID/EN variant.
 * - **`tg` (Telegram).** Login codes are FIVE digits, not six: Telegram's own
 *   API documentation defines a login code as "a sequence of 5 to 7 decimal
 *   digits" for its code-invalidation rule, and pins test-DC accounts to "the
 *   DC number, repeated five times" (core.telegram.org/api/auth) — five is the
 *   production length, and third-party guides agree ("The SMS code is a
 *   five-digit number"). The body carries the brand word ("Telegram code
 *   12345"). No grouped form: Telegram never splits the code, and accepting a
 *   dashed run here would let a date or phone fragment qualify.
 * - **`ig` (Instagram).** Six digits, code first: "123456 is your Instagram
 *   code. Don't share it." Users also report a `<#>` prefix and a trailing
 *   app-hash line, neither of which contributes digits. Sent from shortcode
 *   32665. Contiguous only.
 * - **`go` (Google).** Six digits behind a `G-` display prefix: "G-123456 is
 *   your Google verification code" — the single most-reported Google OTP shape,
 *   and Google's own docs confirm the length ("A 6-digit code is sent to a
 *   number you've previously provided"). The prefix needs no rule of its own:
 *   `-` is not a digit, so the six digits after it are already an intact
 *   candidate. Requiring the prefix would instead REJECT the Google Voice /
 *   Workspace variants that omit it, so the brand word carries the filtering.
 */
export const SERVICE_OTP_REGISTRY = Object.freeze({
  wa: Object.freeze({
    keywords: Object.freeze(["WhatsApp"]),
    senderBrandMarkers: Object.freeze(["whatsapp"]),
    codeShape: Object.freeze({
      digitLength: 6,
      groupedForm: Object.freeze({ groupSizes: Object.freeze([3, 3]), separator: "-" }),
    }),
  }),
  tg: Object.freeze({
    keywords: Object.freeze(["Telegram"]),
    senderBrandMarkers: Object.freeze(["telegram"]),
    codeShape: Object.freeze({ digitLength: 5 }),
  }),
  ig: Object.freeze({
    keywords: Object.freeze(["Instagram"]),
    senderBrandMarkers: Object.freeze(["instagram"]),
    codeShape: Object.freeze({ digitLength: 6 }),
  }),
  go: Object.freeze({
    keywords: Object.freeze(["Google"]),
    senderBrandMarkers: Object.freeze(["google"]),
    codeShape: Object.freeze({ digitLength: 6 }),
  }),
} as const satisfies Readonly<Record<string, ServiceOtpSpec>>);

export type SupportedOtpServiceCode = keyof typeof SERVICE_OTP_REGISTRY;

/**
 * Brands the platform never sells OTPs for, so they are foreign for EVERY
 * service. Kept separate from the registry's own brand markers: those flip
 * between "legitimate" and "foreign" per service, these never do.
 *
 * Deliberately conservative (unambiguous brand names only) — OTP SMS also
 * arrive from bare shortcodes or plain numbers, and a false block on a
 * legitimate route would lose a real OTP.
 */
export const THIRD_PARTY_SENDER_MARKERS = Object.freeze([
  "facebook", "tiktok",
  "tokopedia", "shopee", "lazada", "gojek", "grab",
  "dana", "ovo", "linkaja", "bca", "mandiri", "bni", "bri",
] as const);

/** The registry entry for a service code, or `undefined` when unsupported. */
function serviceOtpSpec(serviceCode: string): ServiceOtpSpec | undefined {
  // `Object.hasOwn`, not `in`: an inherited key (`toString`, `constructor`)
  // must stay unsupported rather than resolve to a prototype member.
  return Object.hasOwn(SERVICE_OTP_REGISTRY, serviceCode)
    ? SERVICE_OTP_REGISTRY[serviceCode as SupportedOtpServiceCode]
    : undefined;
}

/**
 * "Everyone else's brands" for one service, derived from the registry so the
 * two lists cannot drift apart.
 *
 * This is the safety-critical half of the foreign-sender guard: for a `tg`
 * order a sender named "Telegram" is the LEGITIMATE sender, so `telegram` must
 * NOT be a marker there — while it stays a marker for `wa`, `ig`, and `go`. A
 * hand-maintained per-service list would eventually be edited on one side only
 * and start refusing real OTPs, so every service's own brand markers are
 * subtracted from the union instead of being omitted by hand.
 */
function foreignSenderMarkersFor(serviceCode: string): readonly string[] {
  const ownMarkers = new Set(serviceOtpSpec(serviceCode)?.senderBrandMarkers ?? []);
  const otherBrandMarkers = Object.entries(SERVICE_OTP_REGISTRY)
    .filter(([code]) => code !== serviceCode)
    .flatMap(([, spec]) => spec.senderBrandMarkers);
  // Subtract own markers from the whole union, third-party list included, so a
  // service whose brand later joins that list still trusts its own sender.
  const markers = [...otherBrandMarkers, ...THIRD_PARTY_SENDER_MARKERS]
    .filter((marker) => !ownMarkers.has(marker));
  return Object.freeze([...new Set(markers)]);
}

const FOREIGN_SENDER_MARKERS_BY_SERVICE: Readonly<Record<string, readonly string[]>> =
  Object.freeze(Object.fromEntries(
    Object.keys(SERVICE_OTP_REGISTRY).map((code) => [code, foreignSenderMarkersFor(code)]),
  ));

/**
 * Markers that make a sender foreign for `serviceCode`. An unknown service gets
 * every brand marker: it never parses anyway, and failing closed keeps the
 * helper safe if it is ever reused for a code not yet in the registry.
 */
export function foreignSenderMarkersForService(serviceCode: string): readonly string[] {
  return FOREIGN_SENDER_MARKERS_BY_SERVICE[serviceCode] ?? foreignSenderMarkersFor(serviceCode);
}

/**
 * Whole-word keywords a `wa` body must contain. Retained as the historical
 * name for the `wa` registry entry's keywords.
 */
export const DEFAULT_WHATSAPP_OTP_KEYWORDS = SERVICE_OTP_REGISTRY.wa.keywords;

/**
 * Default markers for {@link isForeignServiceSender} — the `wa` view, i.e.
 * every other brand plus the third-party list, excluding WhatsApp itself.
 */
export const DEFAULT_FOREIGN_SENDER_MARKERS = foreignSenderMarkersForService("wa");

/** True when the observed sender id clearly names another service. */
export function isForeignServiceSender(
  sender: string,
  markers: readonly string[] = DEFAULT_FOREIGN_SENDER_MARKERS,
): boolean {
  if (typeof sender !== "string" || sender.length === 0) return false;
  const folded = sender.toLocaleLowerCase("en-US");
  return markers.some((marker) => marker.length > 0 && folded.includes(marker));
}

export interface ServiceOtpRule {
  readonly keywords?: readonly string[];
  /** Observed SMS sender id; when it names another service the parse rejects. */
  readonly sender?: string;
  readonly foreignSenderMarkers?: readonly string[];
}

/** @deprecated Rules are per service now; use {@link ServiceOtpRule}. */
export type WhatsAppOtpRule = ServiceOtpRule;

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

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/**
 * The candidate pattern for one code shape: contiguous digits first, then the
 * grouped form when the service has one. Alternation order matters — `matchAll`
 * takes the leftmost match and, at equal start, the first alternative that
 * fits, so listing the contiguous run first keeps the `wa` scan byte-identical
 * to the previous hard-coded `/[0-9]{6}|[0-9]{3}-[0-9]{3}/g`.
 */
function candidatePattern(shape: OtpCodeShape): RegExp {
  const contiguous = `[0-9]{${shape.digitLength}}`;
  if (shape.groupedForm === undefined) return new RegExp(contiguous, "g");
  const separator = escapeForRegExp(shape.groupedForm.separator);
  const grouped = shape.groupedForm.groupSizes
    .map((size) => `[0-9]{${size}}`)
    .join(separator);
  return new RegExp(`${contiguous}|${grouped}`, "g");
}

/**
 * Collect standalone OTP candidates for one service's code shape. Two shapes
 * count: `digitLength` contiguous ASCII digits, and — only where the service
 * declares one — the grouped wire format (WhatsApp's `718-891`), which
 * normalizes to the same digits. A candidate is only intact when no decimal
 * digit borders it, and a grouped match must additionally stand alone: when its
 * separator chain continues with more digits on either side (phones such as
 * `0812-345-6789`, dashed ids, ranges) the match is a fragment of a longer
 * number, never an OTP.
 */
function intactCodeCandidates(
  body: string,
  shape: OtpCodeShape,
): ReadonlyArray<Readonly<{ value: string; index: number }>> {
  const candidates: Array<Readonly<{ value: string; index: number }>> = [];
  const separator = shape.groupedForm?.separator;
  for (const match of body.matchAll(candidatePattern(shape))) {
    const index = match.index;
    const raw = match[0];
    const before = index === 0 ? "" : body[index - 1];
    const afterIndex = index + raw.length;
    const after = afterIndex === body.length ? "" : body[afterIndex];
    if ((before !== "" && unicodeDecimalDigit.test(before))
      || (after !== "" && unicodeDecimalDigit.test(after))) {
      continue;
    }
    if (separator !== undefined && raw.includes(separator)) {
      // Look past the adjoining separator for another digit: that is what makes
      // this match a link in a longer chain rather than a standalone code.
      const precedingSeparator = body.slice(Math.max(0, index - separator.length), index);
      const beforeSeparator = index >= separator.length + 1 ? body[index - separator.length - 1] : "";
      const followingSeparator = body.slice(afterIndex, afterIndex + separator.length);
      const afterSeparator = afterIndex + separator.length < body.length
        ? body[afterIndex + separator.length]
        : "";
      const chainBefore = precedingSeparator === separator
        && beforeSeparator !== "" && unicodeDecimalDigit.test(beforeSeparator);
      const chainAfter = followingSeparator === separator
        && afterSeparator !== "" && unicodeDecimalDigit.test(afterSeparator);
      if (chainBefore || chainAfter) continue;
    }
    const value = separator === undefined ? raw : raw.split(separator).join("");
    candidates.push(Object.freeze({ value, index }));
  }
  return candidates;
}

export function parseServiceOtp(
  serviceCode: string,
  body: string,
  rule: ServiceOtpRule = {},
): OtpParseResult {
  const spec = serviceOtpSpec(serviceCode);
  if (spec === undefined) {
    return Object.freeze({ status: "rejected", reason: "unsupported_service" });
  }
  if (
    rule.sender !== undefined
    && isForeignServiceSender(
      rule.sender,
      rule.foreignSenderMarkers ?? foreignSenderMarkersForService(serviceCode),
    )
  ) {
    return Object.freeze({ status: "rejected", reason: "foreign_sender" });
  }
  const keywords = rule.keywords ?? spec.keywords;
  if (!hasKeyword(body, keywords)) {
    return Object.freeze({ status: "rejected", reason: "missing_keyword" });
  }
  const candidates = intactCodeCandidates(body, spec.codeShape);
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
