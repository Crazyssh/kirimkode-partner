import { readFile } from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

const schemaPath = path.resolve(process.cwd(), "prisma", "schema.prisma");
let schema = "";

function block(kind: "model" | "enum", name: string): string {
  const match = schema.match(new RegExp(`${kind} ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`${kind} ${name} is missing from the Partner Prisma schema`);
  return match[1];
}

beforeAll(async () => {
  schema = await readFile(schemaPath, "utf8");
});

// **Validates: Requirements 13.1, 13.2, 13.3, 13.5, 14.2, 14.3, 14.6, 20.6**
describe("Task 3.3 Partner finance and reconciliation Prisma schema", () => {
  it("defines every finance, payout, job, and reconciliation model once with UUID keys", () => {
    const models = [
      "PartnerEarning", "LedgerTransaction", "LedgerEntry", "PayoutDestination",
      "PartnerPayout", "PayoutAllocation", "PayoutTransition", "JobLease",
      "ReconciliationIssue",
    ];

    for (const model of models) {
      expect(block("model", model)).toMatch(
        /\bid\s+String\s+@id\s+@default\(uuid\(\)\)\s+@db\.Uuid/,
      );
      expect((schema.match(new RegExp(`^model ${model} \\{`, "gm")) ?? [])).toHaveLength(1);
    }
  });

  it("defines the required earning, ledger, payout, and reconciliation enums", () => {
    expect(block("enum", "PartnerEarningStatus")).toMatch(
      /PENDING[\s\S]*AVAILABLE[\s\S]*REQUESTED[\s\S]*PAID[\s\S]*REVERSED/,
    );
    expect(block("enum", "PartnerPayoutStatus")).toMatch(
      /REQUESTED[\s\S]*APPROVED[\s\S]*PROCESSING[\s\S]*PAID[\s\S]*REJECTED[\s\S]*FAILED/,
    );
    expect(block("enum", "LedgerBucket")).toMatch(
      /PLATFORM_PARTNER_PAYABLE[\s\S]*PARTNER_PENDING[\s\S]*PARTNER_AVAILABLE[\s\S]*PARTNER_PAYOUT_LOCKED[\s\S]*PARTNER_PAID[\s\S]*PARTNER_REVERSED/,
    );
    expect(block("enum", "PayoutPaymentMethod")).toMatch(/BANK_TRANSFER_MANUAL/);
    expect(block("enum", "ReconciliationIssueStatus")).toMatch(/OPEN[\s\S]*RESOLVED[\s\S]*DISMISSED/);
  });

  it("enforces retry and double-payment uniqueness at the Prisma boundary", () => {
    const earning = block("model", "PartnerEarning");
    const transaction = block("model", "LedgerTransaction");
    const payout = block("model", "PartnerPayout");
    const allocation = block("model", "PayoutAllocation");

    expect(earning).toMatch(/orderId\s+String\s+@unique\s+@db\.Uuid/);
    expect(transaction).toMatch(/eventKey\s+String\s+@unique/);
    expect(allocation).toMatch(/earningId\s+String\s+@unique\s+@db\.Uuid/);
    expect(payout).toMatch(/paymentReference\s+String\?\s+@unique/);
    expect(block("model", "PayoutTransition")).toMatch(/operationKey\s+String\s+@unique/);
    expect(block("model", "JobLease")).toMatch(/name\s+String\s+@unique/);
  });

  it("uses explicit tenant-safe composite relations for financial aggregates", () => {
    expect(block("model", "PartnerEarning")).toMatch(
      /order\s+PartnerOrder\s+@relation\(fields: \[orderId, partnerId\], references: \[id, partnerId\]/,
    );
    expect(block("model", "LedgerEntry")).toMatch(
      /transaction\s+LedgerTransaction\s+@relation\(fields: \[transactionId, partnerId\], references: \[id, partnerId\]/,
    );
    expect(block("model", "PartnerPayout")).toMatch(
      /destination\s+PayoutDestination\s+@relation\(fields: \[destinationId, partnerId\], references: \[id, partnerId\]/,
    );
    expect(block("model", "PartnerPayout")).toMatch(
      /createdByMember\s+PartnerMember\s+@relation\("PayoutCreatedByMember", fields: \[createdByMemberId, partnerId\], references: \[id, partnerId\]/,
    );
    expect(block("model", "PayoutAllocation")).toMatch(
      /earning\s+PartnerEarning\s+@relation\(fields: \[earningId, partnerId\], references: \[id, partnerId\]/,
    );
    expect(block("model", "PayoutTransition")).toMatch(
      /payout\s+PartnerPayout\s+@relation\(fields: \[payoutId, partnerId\], references: \[id, partnerId\]/,
    );
    expect(block("model", "ReconciliationIssue")).toMatch(
      /partner\s+Partner\s+@relation\(fields: \[partnerId\], references: \[id\]/,
    );
  });

  it("provides batch and financial-status indexes", () => {
    expect(block("model", "PartnerEarning")).toMatch(
      /@@index\(\[partnerId, status, availableAt\]\)/,
    );
    expect(block("model", "LedgerEntry")).toMatch(
      /@@index\(\[partnerId, bucket, createdAt\]\)/,
    );
    expect(block("model", "PartnerPayout")).toMatch(
      /@@index\(\[partnerId, status, requestedAt\]\)/,
    );
    expect(block("model", "PayoutTransition")).toMatch(
      /@@index\(\[toStatus, createdAt\]\)/,
    );
    expect(block("model", "JobLease")).toMatch(/@@index\(\[leaseUntil\]\)/);
    expect(block("model", "ReconciliationIssue")).toMatch(
      /@@index\(\[partnerId, status, severity, detectedAt\]\)/,
    );
  });

  it("keeps payout destination data encrypted and snapshots payout routing", () => {
    const destination = block("model", "PayoutDestination");
    const payout = block("model", "PartnerPayout");

    expect(destination).toMatch(/accountNumberCiphertext\s+Bytes/);
    expect(destination).toMatch(/accountNumberLast4\s+String/);
    expect(destination).not.toMatch(/^\s*accountNumber\s+/m);
    expect(payout).toMatch(/destinationSnapshotJsonEncrypted\s+Bytes/);
    expect(payout).toMatch(/paymentMethod\s+PayoutPaymentMethod/);
  });

  it("documents exact Task 3.4 SQL deferrals Prisma cannot express", () => {
    for (const deferredInvariant of [
      "PartnerEarning.amountIdr > 0",
      "signed sum is zero",
      "Append-only UPDATE/DELETE denial triggers",
      "PartnerEarning.amountIdr = OrderSnapshot.payoutIdr",
      "allocation to equal its whole Earning amount",
      "PartnerPayout.amountIdr to equal SUM(PayoutAllocation.amountIdr)",
      "PAID payouts to have paidAt",
      "constraint generated by @unique permits multiple NULLs",
      "preventing mutation of destinationSnapshotJsonEncrypted",
      "resolution AuditEvent to carry the same partnerId",
    ]) {
      expect(schema).toContain(deferredInvariant);
    }
  });
});
