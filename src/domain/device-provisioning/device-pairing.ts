/**
 * QR pairing-token lifecycle for the mobile-agent device provisioning flow.
 *
 * Roadmap item 10 from the HeroSMS Partners study
 * (`.agents/RESEARCH-HEROSMS-PARTNERS.md`, §7 "Implikasi untuk Partner Platform",
 * item 10: "QR pairing untuk mobile agent (worker -> scan QR) sebagai UX koneksi
 * device"). A worker (desktop / hardware controller) displays a short-lived QR
 * code and a mobile agent scans it to pair itself as a SIM-port device. The QR
 * encodes a single-use token with a limited validity window (research §3
 * "Mobile app (HeroSMS-Mobile)": "Login via scan QR dari worker ... QR ada masa
 * berlaku").
 *
 * This module mirrors the one-time-token pattern in
 * `src/domain/task-5-1/one-time-token.ts`: issue a hashed, expiring token, then
 * consume it exactly once behind worker-identity + hash checks. It is pure — no
 * I/O, no persistence, no ambient clock; every timestamp is injected as epoch
 * milliseconds and every result object is frozen.
 */
import { DeviceProvisioningError } from "./errors";

/**
 * QR pairing tokens are deliberately short-lived: 5 minutes. The worker QR only
 * needs to survive the scan-and-confirm handshake (research §3: QR "ada masa
 * berlaku"), so a tight TTL limits the replay window.
 */
export const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;

export interface PairingTokenRecord {
  readonly id: string;
  readonly workerId: string;
  readonly tokenHash: string;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  readonly consumedAtEpochMs: number | null;
}

export type PairingFailureCode =
  | "PAIRING_INVALID"
  | "PAIRING_EXPIRED"
  | "PAIRING_ALREADY_USED";

export interface IssuePairingInput {
  readonly id: string;
  readonly workerId: string;
  readonly tokenHash: string;
  readonly issuedAtEpochMs: number;
  readonly ttlMs?: number;
}

export interface ConsumePairingInput {
  readonly token: PairingTokenRecord;
  readonly expectedWorkerId: string;
  readonly presentedTokenHash: string;
  readonly nowEpochMs: number;
}

export type ConsumePairingResult =
  | { readonly consumed: true; readonly token: PairingTokenRecord }
  | { readonly consumed: false; readonly code: PairingFailureCode };

/** Lower/upper-case sha256 digest rendered as 64 hex characters. */
const SHA_256_HEX_PATTERN = /^[a-f\d]{64}$/iu;

function isValidEpoch(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Issue a pairing token the worker will render as a QR code. The raw token is
 * never stored — only its sha256 hex digest — matching one-time-token. The token
 * expires `ttlMs` after issuance (default {@link PAIRING_TOKEN_TTL_MS}).
 *
 * @throws DeviceProvisioningError `INVALID_PAIRING_DESCRIPTOR` when id/workerId
 * are empty, the hash is not a 64-char sha256 hex digest, or the TTL is not a
 * positive safe integer; `INVALID_TIME` when the issue time or computed expiry
 * is not a non-negative safe integer.
 */
export function issuePairingToken(input: IssuePairingInput): PairingTokenRecord {
  if (
    typeof input.id !== "string" ||
    input.id.length === 0 ||
    typeof input.workerId !== "string" ||
    input.workerId.length === 0 ||
    !SHA_256_HEX_PATTERN.test(input.tokenHash)
  ) {
    throw new DeviceProvisioningError(
      "INVALID_PAIRING_DESCRIPTOR",
      "Pairing token requires a non-empty id, a non-empty workerId, and a sha256 hex tokenHash",
    );
  }
  if (!isValidEpoch(input.issuedAtEpochMs)) {
    throw new DeviceProvisioningError(
      "INVALID_TIME",
      "issuedAtEpochMs must be a non-negative safe integer",
    );
  }

  const ttlMs = input.ttlMs ?? PAIRING_TOKEN_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new DeviceProvisioningError(
      "INVALID_PAIRING_DESCRIPTOR",
      "ttlMs must be a positive safe integer",
    );
  }

  const expiresAtEpochMs = input.issuedAtEpochMs + ttlMs;
  if (!Number.isSafeInteger(expiresAtEpochMs)) {
    throw new DeviceProvisioningError(
      "INVALID_TIME",
      "Pairing token expiry exceeds the safe integer range",
    );
  }

  return Object.freeze({
    id: input.id,
    workerId: input.workerId,
    tokenHash: input.tokenHash.toLowerCase(),
    issuedAtEpochMs: input.issuedAtEpochMs,
    expiresAtEpochMs,
    consumedAtEpochMs: null,
  });
}

/**
 * Consume a pairing token when the mobile agent presents the scanned value. The
 * token must belong to the expected worker, its presented hash must match
 * (case-insensitive), it must not have been consumed, and it must not have
 * expired. Rejection precedence mirrors one-time-token:
 * `PAIRING_INVALID` -> `PAIRING_ALREADY_USED` -> `PAIRING_EXPIRED`, so identity /
 * hash mismatches (which reveal a wrong or forged QR) are reported before the
 * benign single-use or expiry outcomes. On success the returned token carries
 * `consumedAtEpochMs = nowEpochMs`, making a second consume a no-op via
 * `PAIRING_ALREADY_USED`.
 */
export function consumePairingToken(
  input: ConsumePairingInput,
): ConsumePairingResult {
  if (
    !isValidEpoch(input.nowEpochMs) ||
    input.token.workerId !== input.expectedWorkerId ||
    !SHA_256_HEX_PATTERN.test(input.presentedTokenHash) ||
    input.token.tokenHash !== input.presentedTokenHash.toLowerCase()
  ) {
    return { consumed: false, code: "PAIRING_INVALID" };
  }
  if (input.token.consumedAtEpochMs !== null) {
    return { consumed: false, code: "PAIRING_ALREADY_USED" };
  }
  if (input.nowEpochMs >= input.token.expiresAtEpochMs) {
    return { consumed: false, code: "PAIRING_EXPIRED" };
  }

  return {
    consumed: true,
    token: Object.freeze({
      ...input.token,
      consumedAtEpochMs: input.nowEpochMs,
    }),
  };
}
