/**
 * Pure CSV builder for the partner earnings export (portal feature).
 *
 * Server-only, side-effect free: the route handler resolves the tenant's
 * earnings and hands the rows here to serialize. RFC 4180 quoting, CRLF line
 * endings, and a leading UTF-8 BOM so Excel opens the Indonesian labels and the
 * `+62` order references correctly. Money is emitted as the raw IDR integer
 * (spreadsheet-friendly), and the release time as an Asia/Jakarta timestamp,
 * reusing the same domain formatter the Earning page renders (requirement 15.4).
 */
import { formatJakartaTimestamp } from "@domain/task-5-7";

/** One earning as needed for the export (mirrors the operational earnings view). */
export interface EarningExportRow {
  readonly orderId: string;
  readonly amountIdr: number;
  readonly status: string;
  readonly availableAtEpochMs: number;
}

/** Indonesian status labels, matching the Earning page pills. */
const STATUS_LABEL: Readonly<Record<string, string>> = {
  pending: "Tertahan",
  available: "Tersedia",
  requested: "Diajukan payout",
  paid: "Dibayar",
  reversed: "Dibatalkan",
};

/**
 * Escape one field per RFC 4180: a field containing a quote, comma, CR, or LF is
 * wrapped in double quotes with any internal quote doubled. Anything else is
 * emitted verbatim.
 */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Join one row of raw cell values into an escaped CSV line. */
function csvLine(cells: readonly string[]): string {
  return cells.map(csvField).join(",");
}

/** The export column headers (stable order). */
export const EARNINGS_CSV_HEADERS = [
  "Order ID",
  "Jumlah (IDR)",
  "Status",
  "Tersedia sejak",
] as const;

/**
 * Serialize the earnings into a CSV document. The header row is always present
 * (an export with no earnings is a valid, header-only file). The result starts
 * with a UTF-8 BOM and uses CRLF line endings, ending with a trailing CRLF.
 */
export function buildEarningsCsv(earnings: readonly EarningExportRow[]): string {
  const lines = [
    csvLine(EARNINGS_CSV_HEADERS),
    ...earnings.map((earning) =>
      csvLine([
        earning.orderId,
        String(earning.amountIdr),
        STATUS_LABEL[earning.status] ?? earning.status,
        formatJakartaTimestamp(earning.availableAtEpochMs),
      ]),
    ),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}
