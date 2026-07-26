export const MVP_CATALOG = Object.freeze({
  serviceCode: "wa",
  countryCode: "ID",
  operatorCode: "any",
  currency: "IDR",
});

export const MVP_HEARTBEAT_INTERVAL_SECONDS = 30;
export const MVP_HEARTBEAT_TIMEOUT_SECONDS = 90;

export const MVP_PRICING_CONFIG = Object.freeze({
  ...MVP_CATALOG,
  version: 1,
  minBasePriceIdr: 500,
  maxBasePriceIdr: 5_000,
  fixedFeeIdr: 250,
  markupBps: 1_500,
  roundToIdr: 50,
});

export type PartnerStatus = "pending" | "approved" | "suspended" | "rejected";
export type DeviceType = "simulator" | "android" | "modem" | "goip" | "api";
export type DeviceStatus = "offline" | "online" | "disabled";
export type NumberStatus = "offline" | "available" | "reserved" | "busy" | "disabled";
export type OfferStatus = "inactive" | "active";

export type Task52DomainErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_DEVICE_CAPABILITIES"
  | "DEVICE_DISABLED"
  | "UNSUPPORTED_CAPABILITY"
  | "INVALID_HEARTBEAT"
  | "INVALID_PHONE_NUMBER"
  | "NUMBER_STATE_GUARD"
  | "DUPLICATE_ACTIVE_NUMBER"
  | "PARTNER_NOT_APPROVED"
  | "INVALID_OFFER_CATALOG"
  | "PRICE_OUT_OF_GUARDRAIL";

export class Task52DomainError extends Error {
  constructor(public readonly code: Task52DomainErrorCode, message: string) {
    super(message);
    this.name = "Task52DomainError";
  }
}

export interface DeviceCapabilities {
  readonly sms: boolean;
  readonly notification: boolean;
  readonly resend: boolean;
  readonly operator: boolean;
  readonly slots: number;
}

export interface HeartbeatMetadata {
  readonly agentVersion?: string;
  readonly signal?: number;
  readonly operator?: string;
  readonly health?: Readonly<Record<string, JsonValue>>;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface DeviceState {
  readonly type: DeviceType;
  readonly status: DeviceStatus;
  readonly lastSeenAt: Date | null;
  readonly capabilities: DeviceCapabilities;
  readonly heartbeatMetadata?: HeartbeatMetadata;
}

export type DeviceOperation = "inventory" | "sms" | "notification" | "resend" | "operator";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function assertSafeInteger(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Task52DomainError("INVALID_CONFIG", `${name} must be a safe integer >= ${minimum}`);
  }
}

export function parseDeviceCapabilities(input: unknown): DeviceCapabilities {
  if (!isRecord(input)) {
    throw new Task52DomainError("INVALID_DEVICE_CAPABILITIES", "Capabilities must be an object");
  }

  const booleanCapability = (key: "sms" | "notification" | "resend" | "operator"): boolean => {
    const value = input[key] ?? false;
    if (typeof value !== "boolean") {
      throw new Task52DomainError("INVALID_DEVICE_CAPABILITIES", `${key} must be boolean`);
    }
    return value;
  };
  const slots = input.slots ?? 0;
  if (!Number.isSafeInteger(slots) || (slots as number) < 0) {
    throw new Task52DomainError("INVALID_DEVICE_CAPABILITIES", "slots must be a non-negative safe integer");
  }

  return Object.freeze({
    sms: booleanCapability("sms"),
    notification: booleanCapability("notification"),
    resend: booleanCapability("resend"),
    operator: booleanCapability("operator"),
    slots: slots as number,
  });
}

export function sanitizeHeartbeatMetadata(input: unknown): HeartbeatMetadata {
  if (input === undefined) return Object.freeze({});
  if (!isRecord(input)) {
    throw new Task52DomainError("INVALID_HEARTBEAT", "Heartbeat metadata must be an object");
  }

  const metadata: {
    agentVersion?: string;
    signal?: number;
    operator?: string;
    health?: Readonly<Record<string, JsonValue>>;
  } = {};
  if (input.agentVersion !== undefined) {
    if (typeof input.agentVersion !== "string" || input.agentVersion.length > 64) {
      throw new Task52DomainError("INVALID_HEARTBEAT", "agentVersion must be at most 64 characters");
    }
    metadata.agentVersion = input.agentVersion;
  }
  if (input.signal !== undefined) {
    if (!Number.isSafeInteger(input.signal)) {
      throw new Task52DomainError("INVALID_HEARTBEAT", "signal must be an integer");
    }
    metadata.signal = input.signal as number;
  }
  if (input.operator !== undefined) {
    if (typeof input.operator !== "string" || input.operator.length > 64) {
      throw new Task52DomainError("INVALID_HEARTBEAT", "operator must be at most 64 characters");
    }
    metadata.operator = input.operator;
  }
  if (input.health !== undefined) {
    if (!isRecord(input.health) || !isJsonValue(input.health)) {
      throw new Task52DomainError("INVALID_HEARTBEAT", "health must be a JSON object");
    }
    metadata.health = Object.freeze({ ...input.health });
  }
  return Object.freeze(metadata);
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Task52DomainError("INVALID_HEARTBEAT", `${label} must be a valid Date`);
  }
}

export function recordServerHeartbeat(
  device: DeviceState,
  receivedAtServer: Date,
  update: { readonly metadata?: unknown; readonly capabilities?: unknown } = {},
): DeviceState {
  assertValidDate(receivedAtServer, "receivedAtServer");
  const previousTime = device.lastSeenAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const lastSeenAt = new Date(Math.max(previousTime, receivedAtServer.getTime()));

  return Object.freeze({
    ...device,
    status: device.status === "disabled" ? "disabled" : "online",
    lastSeenAt,
    capabilities:
      update.capabilities === undefined
        ? device.capabilities
        : parseDeviceCapabilities(update.capabilities),
    heartbeatMetadata:
      update.metadata === undefined
        ? device.heartbeatMetadata
        : sanitizeHeartbeatMetadata(update.metadata),
  });
}

export function isDeviceLive(
  device: Pick<DeviceState, "status" | "lastSeenAt">,
  nowServer: Date,
  timeoutSeconds = MVP_HEARTBEAT_TIMEOUT_SECONDS,
): boolean {
  assertValidDate(nowServer, "nowServer");
  assertSafeInteger(timeoutSeconds, "timeoutSeconds", 1);
  if (device.status !== "online" || device.lastSeenAt === null) return false;
  assertValidDate(device.lastSeenAt, "lastSeenAt");
  return nowServer.getTime() - device.lastSeenAt.getTime() <= timeoutSeconds * 1_000;
}

export function effectiveDeviceStatus(
  device: Pick<DeviceState, "status" | "lastSeenAt">,
  nowServer: Date,
  timeoutSeconds = MVP_HEARTBEAT_TIMEOUT_SECONDS,
): DeviceStatus {
  if (device.status === "disabled") return "disabled";
  return isDeviceLive(device, nowServer, timeoutSeconds) ? "online" : "offline";
}

export function assertDeviceOperationAllowed(
  device: Pick<DeviceState, "status" | "capabilities">,
  operation: DeviceOperation,
): void {
  if (device.status === "disabled") {
    throw new Task52DomainError("DEVICE_DISABLED", "Disabled devices cannot perform agent operations");
  }
  if (operation !== "inventory" && !device.capabilities[operation]) {
    throw new Task52DomainError(
      "UNSUPPORTED_CAPABILITY",
      `Device does not support ${operation}`,
    );
  }
}

const INDONESIAN_CANONICAL_NUMBER = /^\+628[1-9]\d{8,11}$/;
const PHONE_SEPARATORS = /[\s().-]/g;

export function normalizeIndonesianNumber(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Task52DomainError("INVALID_PHONE_NUMBER", "Phone number is required");
  }
  const compact = input.normalize("NFKC").trim().replace(PHONE_SEPARATORS, "");
  if (!/^\+?\d+$/.test(compact)) {
    throw new Task52DomainError("INVALID_PHONE_NUMBER", "Phone number contains unsupported characters");
  }

  let national: string;
  if (compact.startsWith("+62")) national = compact.slice(3);
  else if (compact.startsWith("0062")) national = compact.slice(4);
  else if (compact.startsWith("62")) national = compact.slice(2);
  else if (compact.startsWith("0")) national = compact.slice(1);
  else national = compact;

  const canonical = `+62${national}`;
  if (!INDONESIAN_CANONICAL_NUMBER.test(canonical)) {
    throw new Task52DomainError(
      "INVALID_PHONE_NUMBER",
      "Indonesian mobile number must be valid E.164 under +62",
    );
  }
  return canonical;
}

export interface ExistingNumberIdentity {
  readonly id: string;
  readonly canonicalNumber: string;
  readonly status: NumberStatus;
}

export function assertUniqueActiveNumber(
  input: string,
  existingNumbers: readonly ExistingNumberIdentity[],
  excludedNumberId?: string,
): string {
  const canonical = normalizeIndonesianNumber(input);
  const duplicate = existingNumbers.some(
    (number) =>
      number.id !== excludedNumberId &&
      number.status !== "disabled" &&
      normalizeIndonesianNumber(number.canonicalNumber) === canonical,
  );
  if (duplicate) {
    throw new Task52DomainError(
      "DUPLICATE_ACTIVE_NUMBER",
      "An active number already uses this canonical number",
    );
  }
  return canonical;
}

export function assertNumberMoveOrDeleteAllowed(status: NumberStatus): void {
  if (status === "reserved" || status === "busy") {
    throw new Task52DomainError(
      "NUMBER_STATE_GUARD",
      `Number cannot be moved or deleted while ${status}`,
    );
  }
}

export function disableIdleNumber(status: NumberStatus): NumberStatus {
  assertNumberMoveOrDeleteAllowed(status);
  return "disabled";
}

export function reenableNumber(): NumberStatus {
  return "offline";
}

export interface NumberAvailabilityInput {
  readonly status: NumberStatus;
  readonly enabled: boolean;
  readonly hasActiveOrder: boolean;
  readonly hasActiveOffer: boolean;
  readonly device: Pick<DeviceState, "status" | "lastSeenAt">;
  readonly nowServer: Date;
  readonly heartbeatTimeoutSeconds?: number;
}

export function reconcileNumberAvailability(input: NumberAvailabilityInput): NumberStatus {
  if (!input.enabled || input.status === "disabled") return "disabled";
  if (input.status === "reserved" || input.status === "busy") return input.status;
  if (
    !isDeviceLive(
      input.device,
      input.nowServer,
      input.heartbeatTimeoutSeconds ?? MVP_HEARTBEAT_TIMEOUT_SECONDS,
    )
  ) {
    return "offline";
  }
  return input.hasActiveOffer && !input.hasActiveOrder ? "available" : "offline";
}

export interface PricingConfig {
  readonly version: number;
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly currency: string;
  readonly minBasePriceIdr: number;
  readonly maxBasePriceIdr: number;
  readonly fixedFeeIdr: number;
  readonly markupBps: number;
  readonly roundToIdr: number;
}

export interface PricingResult {
  readonly retailPriceIdr: number;
  readonly payoutIdr: number;
  readonly platformMarginIdr: number;
}

export function validatePricingConfig(config: PricingConfig): PricingConfig {
  assertSafeInteger(config.version, "version", 1);
  assertSafeInteger(config.minBasePriceIdr, "minBasePriceIdr");
  assertSafeInteger(config.maxBasePriceIdr, "maxBasePriceIdr");
  assertSafeInteger(config.fixedFeeIdr, "fixedFeeIdr");
  assertSafeInteger(config.markupBps, "markupBps");
  assertSafeInteger(config.roundToIdr, "roundToIdr", 1);
  if (config.minBasePriceIdr > config.maxBasePriceIdr) {
    throw new Task52DomainError("INVALID_CONFIG", "Price guardrail minimum must not exceed maximum");
  }
  if (
    config.serviceCode.length === 0 ||
    config.countryCode.length !== 2 ||
    config.operatorCode.length === 0 ||
    config.currency.length !== 3
  ) {
    throw new Task52DomainError("INVALID_CONFIG", "Catalog and currency codes are invalid");
  }
  return config;
}

export function assertBasePriceWithinGuardrail(
  basePriceIdr: number,
  config: PricingConfig = MVP_PRICING_CONFIG,
): void {
  validatePricingConfig(config);
  if (
    !Number.isSafeInteger(basePriceIdr) ||
    basePriceIdr < config.minBasePriceIdr ||
    basePriceIdr > config.maxBasePriceIdr
  ) {
    throw new Task52DomainError(
      "PRICE_OUT_OF_GUARDRAIL",
      `Base price must be between Rp${config.minBasePriceIdr} and Rp${config.maxBasePriceIdr}`,
    );
  }
}

function ceilTo(value: number, unit: number): number {
  const result = Math.ceil(value / unit) * unit;
  if (!Number.isSafeInteger(result)) {
    throw new Task52DomainError("INVALID_CONFIG", "Pricing result exceeds safe integer range");
  }
  return result;
}

export function calculateAuthoritativePricing(
  input: { readonly basePriceIdr: number },
  config: PricingConfig = MVP_PRICING_CONFIG,
): PricingResult {
  assertBasePriceWithinGuardrail(input.basePriceIdr, config);
  const markupNumerator = input.basePriceIdr * config.markupBps;
  if (!Number.isSafeInteger(markupNumerator)) {
    throw new Task52DomainError("INVALID_CONFIG", "Pricing multiplication exceeds safe integer range");
  }
  const markupIdr = Math.ceil(markupNumerator / 10_000);
  const unroundedRetail = input.basePriceIdr + config.fixedFeeIdr + markupIdr;
  if (!Number.isSafeInteger(unroundedRetail)) {
    throw new Task52DomainError("INVALID_CONFIG", "Pricing subtotal exceeds safe integer range");
  }
  const retailPriceIdr = ceilTo(unroundedRetail, config.roundToIdr);
  return Object.freeze({
    retailPriceIdr,
    payoutIdr: input.basePriceIdr,
    platformMarginIdr: retailPriceIdr - input.basePriceIdr,
  });
}

/**
 * One catalog dimension the platform offers, with OPTIONAL pricing overrides.
 *
 * The platform used to serve exactly one dimension because the dimension lived
 * on the single active platform config row, so every check compared a dimension
 * for EQUALITY with that row. A dimension is now a first-class value: the
 * catalog is a SET of these, and a dimension is served when it is present and
 * `enabled`.
 *
 * An `undefined`/absent override inherits the global config's value, so a
 * dimension declared with no overrides prices exactly like the global config.
 * Only the inputs {@link calculateAuthoritativePricing} consumes are
 * overridable; `currency` and `version` stay global because the ledger,
 * earnings, and payouts are denominated once for the whole platform.
 */
export interface CatalogDimension {
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly enabled: boolean;
  readonly minBasePriceIdr?: number | null;
  readonly maxBasePriceIdr?: number | null;
  readonly fixedFeeIdr?: number | null;
  readonly markupBps?: number | null;
  readonly roundToIdr?: number | null;
}

/** True when `dimension` is the catalog dimension `filter` asks for. */
export function dimensionMatches(dimension: CatalogDimension, filter: InventoryFilter): boolean {
  return (
    dimension.serviceCode === filter.serviceCode &&
    dimension.countryCode === filter.countryCode &&
    dimension.operatorCode === filter.operatorCode
  );
}

/** True when a resolved dimension exists and is currently served. */
export function isDimensionServed(dimension: CatalogDimension | null): boolean {
  return dimension !== null && dimension.enabled;
}

/**
 * A lookup of ONE catalog dimension, plus whether the platform has declared any
 * dimension at all.
 *
 * `declared` exists to make the "no catalog yet" state unambiguous, and it
 * matters for real deployments: the documented order is to run the migration and
 * only then seed the config, so a fresh install briefly has a config with an
 * empty dimension table. Treating that as "nothing is served" would leave the
 * platform unable to sell anything, so it is instead read as "serve the config's
 * own dimension" — precisely the behaviour before the catalog existed.
 */
export interface DimensionLookup {
  /** The row for the requested triple, or `null` when there is none. */
  readonly dimension: CatalogDimension | null;
  /** False when NO dimension row exists at all (catalog not yet declared). */
  readonly declared: boolean;
}

/** The whole served catalog, with the same `declared` signal. */
export interface CatalogSnapshot {
  readonly dimensions: readonly CatalogDimension[];
  readonly declared: boolean;
}

/**
 * The dimensions actually served: the declared catalog, or — when nothing has
 * been declared — the active config's own dimension.
 *
 * Once ANY dimension row exists the table is authoritative, so an operator who
 * declares a catalog is never silently overridden by the config's dimension.
 */
export function resolveServedCatalog(
  snapshot: CatalogSnapshot,
  config: PricingConfig,
): readonly CatalogDimension[] {
  return snapshot.declared ? snapshot.dimensions : [configDimension(config)];
}

/**
 * The served dimension for one filter, applying the same undeclared-catalog
 * fallback. Returns `null` when the dimension is absent or disabled, which every
 * caller maps to its existing "catalog not served" error.
 */
export function resolveServedDimension(
  lookup: DimensionLookup,
  config: PricingConfig,
  filter: InventoryFilter,
): CatalogDimension | null {
  if (!lookup.declared) {
    const fallback = configDimension(config);
    return dimensionMatches(fallback, filter) ? fallback : null;
  }
  return isDimensionServed(lookup.dimension) ? lookup.dimension : null;
}

/** The enabled dimension matching `filter`, or `null` when none is served. */
export function findEnabledDimension(
  dimensions: readonly CatalogDimension[],
  filter: InventoryFilter,
): CatalogDimension | null {
  return (
    dimensions.find((dimension) => dimension.enabled && dimensionMatches(dimension, filter)) ?? null
  );
}

/**
 * The pricing config in force for one dimension: the global config with the
 * dimension's non-null overrides applied, and the dimension's own codes.
 *
 * The global values (`version`, `currency`) are never overridden, so the config
 * row stays the single source for them — a dimension can only change the
 * formula inputs the pricing calculation actually reads.
 */
export function resolveDimensionPricing(
  dimension: CatalogDimension,
  config: PricingConfig,
): PricingConfig {
  return Object.freeze({
    version: config.version,
    serviceCode: dimension.serviceCode,
    countryCode: dimension.countryCode,
    operatorCode: dimension.operatorCode,
    currency: config.currency,
    minBasePriceIdr: dimension.minBasePriceIdr ?? config.minBasePriceIdr,
    maxBasePriceIdr: dimension.maxBasePriceIdr ?? config.maxBasePriceIdr,
    fixedFeeIdr: dimension.fixedFeeIdr ?? config.fixedFeeIdr,
    markupBps: dimension.markupBps ?? config.markupBps,
    roundToIdr: dimension.roundToIdr ?? config.roundToIdr,
  });
}

/** The dimension a config row describes, as an always-enabled dimension. */
export function configDimension(config: PricingConfig): CatalogDimension {
  return Object.freeze({
    serviceCode: config.serviceCode,
    countryCode: config.countryCode,
    operatorCode: config.operatorCode,
    enabled: true,
  });
}

/**
 * Why a proposed catalog dimension was refused.
 *
 * Every code corresponds to something the database would refuse anyway — the
 * column widths, `catalog_dimensions_code_check`, and
 * `catalog_dimensions_pricing_check` — so the rejection is a deterministic,
 * reportable outcome instead of a constraint crash surfacing as a 500.
 */
export type DimensionDeclarationViolationCode =
  | "INVALID_SERVICE_CODE"
  | "INVALID_COUNTRY_CODE"
  | "INVALID_OPERATOR_CODE"
  | "INVALID_PRICE_OVERRIDE"
  | "INVALID_PRICE_GUARDRAIL_ORDER"
  | "INVALID_NOTE";

/** One refusal, naming the offending field so the UI can point at it. */
export interface DimensionDeclarationViolation {
  readonly field: string;
  readonly code: DimensionDeclarationViolationCode;
}

/**
 * A dimension an operator proposes to declare, as it arrives from the form.
 *
 * The five pricing overrides are optional and nullable: an absent or null
 * override means "inherit the active platform config", which is what every
 * currently-live dimension does.
 */
export interface DimensionDeclarationInput {
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly enabled: boolean;
  readonly minBasePriceIdr?: number | null;
  readonly maxBasePriceIdr?: number | null;
  readonly fixedFeeIdr?: number | null;
  readonly markupBps?: number | null;
  readonly roundToIdr?: number | null;
  readonly note?: string | null;
}

/** A declaration input normalised to exactly what the row will contain. */
export interface NormalizedDimensionDeclaration {
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly enabled: boolean;
  readonly minBasePriceIdr: number | null;
  readonly maxBasePriceIdr: number | null;
  readonly fixedFeeIdr: number | null;
  readonly markupBps: number | null;
  readonly roundToIdr: number | null;
  readonly note: string | null;
}

export type DimensionDeclarationValidation =
  | { readonly valid: true; readonly declaration: NormalizedDimensionDeclaration }
  | { readonly valid: false; readonly violations: readonly DimensionDeclarationViolation[] };

/** `catalog_dimensions.serviceCode` / `operatorCode` are VARCHAR(32). */
const DIMENSION_CODE_MAX_LENGTH = 32;
/** `catalog_dimensions.note` is VARCHAR(500). */
const DIMENSION_NOTE_MAX_LENGTH = 500;
/**
 * A dimension code as the rest of the catalog already writes them: lower-case
 * alphanumerics plus `_`/`-` (`wa`, `tg`, `ig`, `go`, `any`). Narrower than the
 * database's `<> ''`, deliberately — a code is a stable machine identifier that
 * ends up in URLs, quote filters, and order snapshots, so whitespace and
 * mixed case would produce two dimensions that look identical to an operator.
 */
const DIMENSION_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
/** ISO-2 upper case, matching the `countryCode ~ '^[A-Z]{2}$'` CHECK. */
const ISO2_COUNTRY_PATTERN = /^[A-Z]{2}$/;

/**
 * The pricing-override columns, paired with their per-column CHECK bound.
 *
 * `roundToIdr` must be strictly positive because it is a divisor in
 * {@link calculateAuthoritativePricing}; the rest are merely non-negative. This
 * mirrors `catalog_dimensions_pricing_check` exactly, which in turn mirrors the
 * global `platform_configs_policy_check`.
 */
const PRICE_OVERRIDE_FIELDS = Object.freeze([
  { field: "minBasePriceIdr", minimum: 0 },
  { field: "maxBasePriceIdr", minimum: 0 },
  { field: "fixedFeeIdr", minimum: 0 },
  { field: "markupBps", minimum: 0 },
  { field: "roundToIdr", minimum: 1 },
] as const);

/**
 * Upper bound for every override: the columns are `INTEGER`, so this is a real
 * storage limit, not a policy choice.
 *
 * `Number.isSafeInteger` alone is not enough. A value between INT4 max and
 * `MAX_SAFE_INTEGER` passes every CHECK expression yet cannot be encoded as an
 * int4 parameter at all: the driver fails before the statement runs, and Prisma
 * surfaces it as `PrismaClientUnknownRequestError` — no error code to branch on,
 * so it reaches the operator as a 500 instead of the named field violation this
 * validator exists to produce. Checked against the live database rather than
 * assumed.
 */
const INT4_MAX = 2_147_483_647;

function normalizeOptionalNumber(value: number | null | undefined): number | null {
  return value === undefined ? null : value;
}

/**
 * Validate and normalise a proposed catalog dimension BEFORE it reaches the
 * database.
 *
 * This is the pure half of the admin declare path. It rejects everything the
 * `catalog_dimensions` constraints would reject — code shape and length, ISO-2
 * country, the per-column price-override bounds, and `max >= min` — so an
 * operator gets a named field and a stable code instead of a Postgres
 * constraint error. It deliberately does NOT check whether the triple already
 * exists: uniqueness is a fact about stored rows, not about the input, so it
 * stays with the gateway that holds the unique index.
 *
 * Every violation is collected rather than thrown on the first problem, matching
 * how the config form reports its invariant violations.
 */
export function validateDimensionDeclaration(
  input: DimensionDeclarationInput,
): DimensionDeclarationValidation {
  const violations: DimensionDeclarationViolation[] = [];

  const serviceCode = typeof input.serviceCode === "string" ? input.serviceCode.trim() : "";
  const operatorCode = typeof input.operatorCode === "string" ? input.operatorCode.trim() : "";
  // Country code is upper-cased rather than rejected for case: `id` and `ID` are
  // unambiguously the same country, and the CHECK stores the upper form.
  const countryCode =
    typeof input.countryCode === "string" ? input.countryCode.trim().toUpperCase() : "";

  if (
    serviceCode.length === 0 ||
    serviceCode.length > DIMENSION_CODE_MAX_LENGTH ||
    !DIMENSION_CODE_PATTERN.test(serviceCode)
  ) {
    violations.push({ field: "serviceCode", code: "INVALID_SERVICE_CODE" });
  }
  if (!ISO2_COUNTRY_PATTERN.test(countryCode)) {
    violations.push({ field: "countryCode", code: "INVALID_COUNTRY_CODE" });
  }
  if (
    operatorCode.length === 0 ||
    operatorCode.length > DIMENSION_CODE_MAX_LENGTH ||
    !DIMENSION_CODE_PATTERN.test(operatorCode)
  ) {
    violations.push({ field: "operatorCode", code: "INVALID_OPERATOR_CODE" });
  }

  const overrides: Record<string, number | null> = {};
  for (const { field, minimum } of PRICE_OVERRIDE_FIELDS) {
    const value = normalizeOptionalNumber(input[field]);
    overrides[field] = value;
    if (value === null) continue;
    if (!Number.isSafeInteger(value) || value < minimum || value > INT4_MAX) {
      violations.push({ field, code: "INVALID_PRICE_OVERRIDE" });
    }
  }

  // Only meaningful when BOTH bounds are overridden; a half-override inherits
  // the other bound from the global config, which is already consistent.
  const min = overrides.minBasePriceIdr;
  const max = overrides.maxBasePriceIdr;
  if (min !== null && max !== null && Number.isSafeInteger(min) && Number.isSafeInteger(max) && max < min) {
    violations.push({ field: "maxBasePriceIdr", code: "INVALID_PRICE_GUARDRAIL_ORDER" });
  }

  const trimmedNote = typeof input.note === "string" ? input.note.trim() : "";
  if (trimmedNote.length > DIMENSION_NOTE_MAX_LENGTH) {
    violations.push({ field: "note", code: "INVALID_NOTE" });
  }

  if (violations.length > 0) {
    return Object.freeze({ valid: false, violations: Object.freeze(violations) });
  }
  return Object.freeze({
    valid: true,
    declaration: Object.freeze({
      serviceCode,
      countryCode,
      operatorCode,
      enabled: input.enabled,
      minBasePriceIdr: overrides.minBasePriceIdr,
      maxBasePriceIdr: overrides.maxBasePriceIdr,
      fixedFeeIdr: overrides.fixedFeeIdr,
      markupBps: overrides.markupBps,
      roundToIdr: overrides.roundToIdr,
      note: trimmedNote.length === 0 ? null : trimmedNote,
    }),
  });
}

/**
 * Whether each pricing input of a dimension is overridden or inherited.
 *
 * Purely derived from the row, so the admin read view can show an operator what
 * a dimension actually charges without duplicating the `?? config` resolution
 * that {@link resolveDimensionPricing} owns.
 */
export function describeDimensionOverrides(
  dimension: CatalogDimension,
): Readonly<Record<string, boolean>> {
  const described: Record<string, boolean> = {};
  for (const { field } of PRICE_OVERRIDE_FIELDS) {
    described[field] = (dimension[field] ?? null) !== null;
  }
  return Object.freeze(described);
}

export interface OfferInput {
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly basePriceIdr: number;
  readonly status: OfferStatus;
}

export interface ValidatedOffer extends OfferInput {
  readonly pricing: PricingResult;
  readonly configVersion: number;
}

/**
 * Validate an offer against the partner's status and the served catalog.
 *
 * The offer's dimension is checked by MEMBERSHIP of `dimensions` (any enabled
 * dimension is acceptable), not by equality with the config's own dimension, so
 * a partner may offer any dimension the platform currently serves. Pricing is
 * computed from the config with that dimension's overrides applied, so an
 * offer on a dimension carrying an override is priced by the override while a
 * dimension without one keeps the global price.
 *
 * `dimensions` defaults to the config's own dimension, which reproduces the
 * previous single-dimension behaviour exactly for callers that do not supply a
 * catalog. A dimension that is absent or disabled keeps the existing
 * `INVALID_OFFER_CATALOG` error code.
 */
export function validateOffer(
  partnerStatus: PartnerStatus,
  offer: OfferInput,
  config: PricingConfig = MVP_PRICING_CONFIG,
  dimensions: readonly CatalogDimension[] = [configDimension(config)],
): ValidatedOffer {
  validatePricingConfig(config);
  if (partnerStatus !== "approved") {
    throw new Task52DomainError("PARTNER_NOT_APPROVED", "Only approved partners may create offers");
  }
  const dimension = findEnabledDimension(dimensions, offer);
  if (dimension === null) {
    throw new Task52DomainError(
      "INVALID_OFFER_CATALOG",
      "Offer dimensions must match an enabled catalog dimension",
    );
  }
  const pricingConfig = resolveDimensionPricing(dimension, config);
  return Object.freeze({
    ...offer,
    pricing: calculateAuthoritativePricing({ basePriceIdr: offer.basePriceIdr }, pricingConfig),
    configVersion: config.version,
  });
}

export interface InventoryFilter {
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
}

export interface InventoryCandidate {
  readonly numberId: string;
  readonly partnerStatus: PartnerStatus;
  readonly device: DeviceState;
  readonly number: {
    readonly status: NumberStatus;
    readonly enabled: boolean;
    readonly countryCode: string;
    readonly operatorCode: string;
    readonly hasActiveOrder?: boolean;
  };
  readonly offer: OfferInput;
}

export function isInventoryCandidateEligible(
  candidate: InventoryCandidate,
  filter: InventoryFilter,
  nowServer: Date,
  heartbeatTimeoutSeconds = MVP_HEARTBEAT_TIMEOUT_SECONDS,
): boolean {
  return (
    candidate.partnerStatus === "approved" &&
    isDeviceLive(candidate.device, nowServer, heartbeatTimeoutSeconds) &&
    candidate.device.capabilities.sms &&
    candidate.number.status === "available" &&
    candidate.number.enabled &&
    candidate.number.hasActiveOrder !== true &&
    candidate.offer.status === "active" &&
    candidate.offer.serviceCode === filter.serviceCode &&
    candidate.offer.countryCode === filter.countryCode &&
    candidate.offer.operatorCode === filter.operatorCode &&
    candidate.number.countryCode === filter.countryCode &&
    candidate.number.operatorCode === filter.operatorCode
  );
}

export function selectEligibleInventory(
  candidates: readonly InventoryCandidate[],
  filter: InventoryFilter,
  nowServer: Date,
  heartbeatTimeoutSeconds = MVP_HEARTBEAT_TIMEOUT_SECONDS,
): InventoryCandidate | null {
  const eligible = candidates.filter((candidate) =>
    isInventoryCandidateEligible(candidate, filter, nowServer, heartbeatTimeoutSeconds),
  );
  eligible.sort((left, right) =>
    left.numberId < right.numberId ? -1 : left.numberId > right.numberId ? 1 : 0,
  );
  return eligible[0] ?? null;
}