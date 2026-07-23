/**
 * Private-beta client simulator request builders (task 11.4).
 *
 * The simulator is NOT a dedicated anonymous endpoint. It is an authenticated
 * *client* of the same Agent API v1 (`/api/agent/v1`) that real hardware uses,
 * with device type `simulator` (design section 6; requirements 17.1–17.3,
 * 21.1). This module owns only the pure, side-effect-free construction of the
 * authenticated request specs the simulator sends — the exact same endpoints,
 * credential scheme, and replay/idempotency headers a modem or APK would use.
 * Because it targets the shared endpoints, the simulator provably runs the same
 * domain logic as hardware (requirement 17.2); there is deliberately no bypass
 * endpoint, APK, modem, GoIP, notification listener, resend, or direct supplier
 * API here.
 *
 * Runtime concerns (the clock, the CSPRNG that mints nonces/idempotency keys,
 * and the network transport) live in the infrastructure adapter; this pure
 * layer receives the timestamp/nonce/idempotency key as inputs so it stays
 * deterministic and unit-testable. Credential + number + payload shape is
 * validated by reusing the very same task 11.1 / task 5.2 domain the server
 * uses to *accept* these requests, so a spec that this builder emits is one the
 * Agent API will parse.
 */
import {
  AGENT_API_HEADERS,
  isValid128BitNonce,
  parseAgentAuthorizationHeader,
} from "@domain/task-11-1/agent-api-auth";
import { normalizeIndonesianNumber } from "@domain/task-5-2-device-inventory-pricing";
import {
  decideSimulatorCreation,
  type SimulatorCreationDecision,
  type SimulatorCreationInput,
} from "@domain/task-5-7/simulator";

/** Base path shared by every Agent API v1 endpoint (design section 6). */
export const AGENT_API_BASE_PATH = "/api/agent/v1";

/**
 * Maximum SMS body size accepted by `POST /sms` (design section 6). Enforced on
 * the SMS text field specifically; the whole request is additionally bounded by
 * the Agent API's 16 KiB payload limit server-side.
 */
export const SIMULATOR_SMS_MAX_BODY_BYTES = 4 * 1024;

/** The availability a simulator may request; the domain resolves the state. */
export type SimulatorRequestedAvailability = "available" | "offline" | "disabled";

export type SimulatorClientErrorCode =
  | "INVALID_CREDENTIAL"
  | "INVALID_REPLAY_CONTEXT"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "INVALID_SMS_PAYLOAD"
  | "INVALID_NUMBER_ID"
  | "SIMULATOR_NOT_ALLOWED";

/** Domain error for the simulator client, mirroring the repo's convention. */
export class SimulatorClientError extends Error {
  constructor(
    public readonly code: SimulatorClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SimulatorClientError";
  }
}

/**
 * A device credential issued once by task 8.1 and held by the simulator. Only
 * the public id + secret are ever needed to authenticate; the server stores a
 * hash, never the secret (design section 6).
 */
export interface SimulatorDeviceCredential {
  readonly publicId: string;
  readonly secret: string;
}

/**
 * The replay envelope for a single request. `timestampSeconds` + `nonce` are
 * always required (every mutation is replay-protected); `idempotencyKey` is
 * required for SMS and inventory mutations and omitted for heartbeat.
 */
export interface SimulatorReplayContext {
  readonly timestampSeconds: number;
  readonly nonce: string;
  readonly idempotencyKey?: string;
}

/** A fully-assembled, ready-to-send Agent API request. */
export interface SimulatorRequestSpec {
  readonly method: "POST";
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Optional non-authoritative heartbeat sample. */
export interface SimulatorHeartbeatPayload {
  readonly metadata?: unknown;
  readonly capabilities?: unknown;
}

/** A `+62` number registration; the number is canonicalised to E.164. */
export interface SimulatorRegisterNumberInput {
  readonly number: string;
  readonly operator?: string;
}

/** An SMS to submit through `POST /sms`. */
export interface SimulatorSmsInput {
  readonly messageId: string;
  readonly number: string;
  readonly sender: string;
  /** ISO-8601 receive time as reported by the simulated device. */
  readonly receivedAt: string;
  readonly body: string;
}

/**
 * Decide whether a `simulator` device may be created. Reuses the single task
 * 5.7 policy so creation is gated identically everywhere: allowed only when the
 * environment is not production, or when the partner has been explicitly
 * allowlisted via `simulatorAllowed` for the private beta (requirements 17.1,
 * 17.3). This never grants extra rights — it only gates creation.
 */
export function decideSimulatorClientCreation(
  input: SimulatorCreationInput,
): SimulatorCreationDecision {
  return decideSimulatorCreation(input);
}

/**
 * Assert a simulator may be created, throwing `SIMULATOR_NOT_ALLOWED` when the
 * environment/allowlist policy forbids it. Returns the granting decision so a
 * caller can log the reason.
 */
export function assertSimulatorCreationAllowed(
  input: SimulatorCreationInput,
): Extract<SimulatorCreationDecision, { allowed: true }> {
  const decision = decideSimulatorCreation(input);
  if (!decision.allowed) {
    throw new SimulatorClientError(
      "SIMULATOR_NOT_ALLOWED",
      "Simulator creation is only allowed outside production or when partner.simulatorAllowed is set.",
    );
  }
  return decision;
}

/** Build the `Device <publicId>.<secret>` authorization value, validated. */
function formatDeviceAuthorization(credential: SimulatorDeviceCredential): string {
  const header = `Device ${credential.publicId}.${credential.secret}`;
  // Reuse the server's parser so a credential we would send is one the Agent
  // API can parse; a malformed credential fails here, never on the wire.
  if (parseAgentAuthorizationHeader(header) === null) {
    throw new SimulatorClientError(
      "INVALID_CREDENTIAL",
      "Device credential is malformed.",
    );
  }
  return header;
}

/** UTF-8 byte length without depending on a node runtime primitive. */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

interface HeaderOptions {
  readonly requireIdempotencyKey: boolean;
}

/**
 * Assemble the shared Agent API headers: the device credential, the replay
 * timestamp/nonce, `Content-Type`, and — for mutations — the idempotency key.
 */
function buildHeaders(
  credential: SimulatorDeviceCredential,
  replay: SimulatorReplayContext,
  options: HeaderOptions,
): Record<string, string> {
  if (
    !Number.isSafeInteger(replay.timestampSeconds) ||
    replay.timestampSeconds < 0
  ) {
    throw new SimulatorClientError(
      "INVALID_REPLAY_CONTEXT",
      "Replay timestamp must be a non-negative unix-seconds integer.",
    );
  }
  if (typeof replay.nonce !== "string" || !isValid128BitNonce(replay.nonce)) {
    throw new SimulatorClientError(
      "INVALID_REPLAY_CONTEXT",
      "Replay nonce must be a 128-bit value.",
    );
  }

  const headers: Record<string, string> = {
    [AGENT_API_HEADERS.authorization]: formatDeviceAuthorization(credential),
    [AGENT_API_HEADERS.timestamp]: String(replay.timestampSeconds),
    [AGENT_API_HEADERS.nonce]: replay.nonce,
    "content-type": "application/json",
  };

  const hasKey =
    typeof replay.idempotencyKey === "string" && replay.idempotencyKey.length > 0;
  if (hasKey) {
    headers[AGENT_API_HEADERS.idempotencyKey] = replay.idempotencyKey as string;
  } else if (options.requireIdempotencyKey) {
    throw new SimulatorClientError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "This mutation requires an idempotency key.",
    );
  }

  return headers;
}

/**
 * Build `POST /heartbeat`. Heartbeat carries no idempotency key; the metadata
 * is non-authoritative and validated server-side (requirement 6.4).
 */
export function buildHeartbeatRequest(
  credential: SimulatorDeviceCredential,
  replay: SimulatorReplayContext,
  payload: SimulatorHeartbeatPayload = {},
): SimulatorRequestSpec {
  const body: Record<string, unknown> = {};
  if (payload.metadata !== undefined) body.metadata = payload.metadata;
  if (payload.capabilities !== undefined) body.capabilities = payload.capabilities;

  return Object.freeze({
    method: "POST",
    path: `${AGENT_API_BASE_PATH}/heartbeat`,
    headers: Object.freeze(buildHeaders(credential, replay, { requireIdempotencyKey: false })),
    body: JSON.stringify(body),
  });
}

/**
 * Build `POST /numbers/register` for a `+62` number. The number is canonicalised
 * to E.164 with the same task 5.2 domain the server uses, so an invalid number
 * fails locally rather than on the wire. Inventory mutations require an
 * idempotency key.
 */
export function buildRegisterNumberRequest(
  credential: SimulatorDeviceCredential,
  replay: SimulatorReplayContext,
  input: SimulatorRegisterNumberInput,
): SimulatorRequestSpec {
  const canonicalNumber = normalizeIndonesianNumber(input.number);
  const body: Record<string, unknown> = { number: canonicalNumber };
  if (input.operator !== undefined) body.operator = input.operator;

  return Object.freeze({
    method: "POST",
    path: `${AGENT_API_BASE_PATH}/numbers/register`,
    headers: Object.freeze(buildHeaders(credential, replay, { requireIdempotencyKey: true })),
    body: JSON.stringify(body),
  });
}

/**
 * Build `POST /numbers/{id}/availability`. The simulator only *requests* a
 * state; the domain resolves the effective status server-side (requirement
 * 7.3). Inventory mutations require an idempotency key.
 */
export function buildSetAvailabilityRequest(
  credential: SimulatorDeviceCredential,
  numberId: string,
  replay: SimulatorReplayContext,
  requested: SimulatorRequestedAvailability,
): SimulatorRequestSpec {
  if (typeof numberId !== "string" || numberId.trim().length === 0) {
    throw new SimulatorClientError("INVALID_NUMBER_ID", "Number id is required.");
  }

  return Object.freeze({
    method: "POST",
    path: `${AGENT_API_BASE_PATH}/numbers/${encodeURIComponent(numberId)}/availability`,
    headers: Object.freeze(buildHeaders(credential, replay, { requireIdempotencyKey: true })),
    body: JSON.stringify({ requested }),
  });
}

/**
 * Build `POST /sms`. The receiving number is canonicalised to `+62` E.164 and
 * the SMS body is bounded at 4 KiB (design section 6). SMS submission requires
 * an idempotency key so a retry never double-delivers (requirement 11.3).
 */
export function buildSubmitSmsRequest(
  credential: SimulatorDeviceCredential,
  replay: SimulatorReplayContext,
  input: SimulatorSmsInput,
): SimulatorRequestSpec {
  for (const [field, value] of [
    ["messageId", input.messageId],
    ["sender", input.sender],
    ["receivedAt", input.receivedAt],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new SimulatorClientError("INVALID_SMS_PAYLOAD", `SMS ${field} is required.`);
    }
  }
  if (typeof input.body !== "string" || input.body.length === 0) {
    throw new SimulatorClientError("INVALID_SMS_PAYLOAD", "SMS body is required.");
  }
  if (utf8ByteLength(input.body) > SIMULATOR_SMS_MAX_BODY_BYTES) {
    throw new SimulatorClientError(
      "INVALID_SMS_PAYLOAD",
      `SMS body exceeds ${SIMULATOR_SMS_MAX_BODY_BYTES} bytes.`,
    );
  }

  const canonicalNumber = normalizeIndonesianNumber(input.number);

  return Object.freeze({
    method: "POST",
    path: `${AGENT_API_BASE_PATH}/sms`,
    headers: Object.freeze(buildHeaders(credential, replay, { requireIdempotencyKey: true })),
    body: JSON.stringify({
      messageId: input.messageId,
      number: canonicalNumber,
      sender: input.sender,
      receivedAt: input.receivedAt,
      body: input.body,
    }),
  });
}
