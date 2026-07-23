import { Task57DomainError } from "./errors";

/**
 * Asia/Jakarta (WIB) is a fixed UTC+7 offset with no daylight saving, so the
 * offset can be applied deterministically without relying on the host ICU
 * timezone database (Property 32).
 */
export const JAKARTA_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
export const JAKARTA_TZ_LABEL = "WIB" as const;

/**
 * Format an integer IDR amount as Indonesian Rupiah with no fraction digits,
 * e.g. `1000 -> "Rp1.000"`, `-1400 -> "-Rp1.400"` (Req 15.4). Non-integer or
 * unsafe values are rejected — money is always an integer number of Rupiah.
 */
export function formatIdr(amountIdr: number): string {
  if (!Number.isSafeInteger(amountIdr)) {
    throw new Task57DomainError(
      "INVALID_AMOUNT",
      "IDR amount must be a safe integer (no decimals)",
    );
  }
  const negative = amountIdr < 0;
  const digits = Math.abs(amountIdr).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}Rp${grouped}`;
}

export interface JakartaDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function toEpochMs(source: Date | number): number {
  const epochMs = typeof source === "number" ? source : source.getTime();
  if (!Number.isFinite(epochMs)) {
    throw new Task57DomainError(
      "INVALID_TIMESTAMP",
      "Timestamp source must be a valid Date or finite epoch (ms)",
    );
  }
  return epochMs;
}

/**
 * Convert a UTC instant to Asia/Jakarta wall-clock parts. The source instant is
 * never mutated: a Date input is read via `getTime()` only (Req 15.4 — UTC
 * source immutable).
 */
export function toJakartaParts(source: Date | number): JakartaDateParts {
  const shifted = new Date(toEpochMs(source) + JAKARTA_UTC_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

function pad(value: number, length = 2): string {
  return value.toString().padStart(length, "0");
}

/**
 * Format a UTC instant as an Asia/Jakarta timestamp
 * `YYYY-MM-DD HH:mm:ss WIB` (Req 15.4). Deterministic and non-mutating.
 */
export function formatJakartaTimestamp(source: Date | number): string {
  const parts = toJakartaParts(source);
  const date = `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
  const time = `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
  return `${date} ${time} ${JAKARTA_TZ_LABEL}`;
}
