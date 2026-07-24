import { describe, expect, it } from "vitest";

import {
  buildEarningsCsv,
  csvField,
  EARNINGS_CSV_HEADERS,
  type EarningExportRow,
} from "./earnings-csv";

const BOM = "﻿";
const HEADER = EARNINGS_CSV_HEADERS.join(",");

describe("csvField (RFC 4180 escaping)", () => {
  it("emits plain values verbatim", () => {
    expect(csvField("order-1")).toBe("order-1");
    expect(csvField("Tertahan")).toBe("Tertahan");
  });

  it("quotes and doubles internal quotes", () => {
    expect(csvField('a"b')).toBe('"a""b"');
  });

  it("quotes fields containing a comma, CR, or LF", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField("a\nb")).toBe('"a\nb"');
    expect(csvField("a\r\nb")).toBe('"a\r\nb"');
  });
});

describe("buildEarningsCsv", () => {
  const row = (over: Partial<EarningExportRow> = {}): EarningExportRow => ({
    orderId: "order-1",
    amountIdr: 1000,
    status: "available",
    availableAtEpochMs: Date.UTC(2026, 6, 24, 5, 0, 0),
    ...over,
  });

  it("returns a BOM + header-only document for no earnings", () => {
    const csv = buildEarningsCsv([]);
    expect(csv).toBe(`${BOM}${HEADER}\r\n`);
  });

  it("starts with a UTF-8 BOM and ends with a trailing CRLF", () => {
    const csv = buildEarningsCsv([row()]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("serializes the raw IDR integer, the Indonesian status label, and a Jakarta time", () => {
    const csv = buildEarningsCsv([row({ orderId: "ord-9", amountIdr: 12500, status: "paid" })]);
    const [, dataLine] = csv.replace(BOM, "").split("\r\n");
    const cells = dataLine.split(",");
    expect(cells[0]).toBe("ord-9");
    expect(cells[1]).toBe("12500"); // raw integer, not "Rp12.500"
    expect(cells[2]).toBe("Dibayar");
    // Asia/Jakarta (UTC+7): 05:00 UTC -> 12:00 local; formatter output is non-empty.
    expect(cells[3].length).toBeGreaterThan(0);
  });

  it("falls back to the raw status when unknown", () => {
    const csv = buildEarningsCsv([row({ status: "mystery" })]);
    expect(csv).toContain(",mystery,");
  });

  it("has one header line plus one line per earning", () => {
    const csv = buildEarningsCsv([row(), row({ orderId: "order-2" })]);
    const lines = csv.replace(BOM, "").trimEnd().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(HEADER);
  });
});
