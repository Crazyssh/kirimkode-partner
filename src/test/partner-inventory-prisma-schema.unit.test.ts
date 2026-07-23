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

// **Validates: Requirements 5.3, 6.1, 7.1, 7.2, 7.3, 7.6, 8.1, 9.2, 9.5, 11.2, 12.1**
describe("Task 3.2 Partner inventory Prisma schema", () => {
  it("defines the inventory, order, SMS, and idempotency model boundary", () => {
    const uuidModels = [
      "PartnerDevice", "DeviceHeartbeat", "PartnerNumber", "NumberStateHistory",
      "PartnerOffer", "PartnerOrder", "OrderTransition", "PartnerSms",
      "IdempotencyRecord", "ReplayNonce",
    ];

    for (const model of uuidModels) {
      expect(block("model", model)).toMatch(
        /\bid\s+String\s+@id\s+@default\(uuid\(\)\)\s+@db\.Uuid/,
      );
    }
    expect(block("model", "OrderSnapshot")).toMatch(/orderId\s+String\s+@id\s+@db\.Uuid/);
  });

  it("defines the exact Device, number, and order lifecycle enums", () => {
    expect(block("enum", "PartnerDeviceType")).toMatch(
      /SIMULATOR[\s\S]*ANDROID[\s\S]*MODEM[\s\S]*GOIP[\s\S]*API/,
    );
    expect(block("enum", "PartnerDeviceStatus")).toMatch(/OFFLINE[\s\S]*ONLINE[\s\S]*DISABLED/);
    expect(block("enum", "PartnerNumberStatus")).toMatch(
      /OFFLINE[\s\S]*AVAILABLE[\s\S]*RESERVED[\s\S]*BUSY[\s\S]*DISABLED/,
    );
    expect(block("enum", "PartnerOrderStatus")).toMatch(
      /CREATED[\s\S]*RESERVED[\s\S]*WAITING_SMS[\s\S]*SUCCESS[\s\S]*CANCELLED[\s\S]*TIMEOUT[\s\S]*FAILED/,
    );
  });
  it("normalizes the existing Device anchor and binds inventory to its tenant", () => {
    const device = block("model", "PartnerDevice");
    const number = block("model", "PartnerNumber");
    const offer = block("model", "PartnerOffer");
    const order = block("model", "PartnerOrder");

    expect((schema.match(/^model PartnerDevice \{/gm) ?? [])).toHaveLength(1);
    for (const field of ["type", "label", "effectiveStatus", "lastSeenAt", "capabilitiesJson"]) {
      expect(device).toMatch(new RegExp(`\\b${field}\\b`));
    }
    expect(number).toMatch(
      /device\s+PartnerDevice\s+@relation\(fields: \[deviceId, partnerId\], references: \[id, partnerId\]/,
    );
    expect(offer).toMatch(/partner\s+Partner\s+@relation\(fields: \[partnerId\]/);
    expect(order).toMatch(
      /number\s+PartnerNumber\s+@relation\("NumberOrders", fields: \[numberId, partnerId\], references: \[id, partnerId\]/,
    );
    expect(order).toMatch(
      /offer\s+PartnerOffer\s+@relation\(fields: \[offerId, partnerId\], references: \[id, partnerId\]/,
    );
  });

  it("provides eligibility, liveness, active-order, and expiry indexes", () => {
    expect(block("model", "PartnerDevice")).toMatch(
      /@@index\(\[partnerId, effectiveStatus, lastSeenAt\]\)/,
    );
    expect(block("model", "PartnerNumber")).toMatch(
      /@@index\(\[status, enabled, countryCode, operatorCode, id\]\)/,
    );
    expect(block("model", "PartnerOffer")).toMatch(
      /@@index\(\[status, serviceCode, countryCode, operatorCode, partnerId\]\)/,
    );
    expect(block("model", "PartnerOrder")).toMatch(/@@index\(\[numberId, status, createdAt\]\)/);
    expect(block("model", "PartnerOrder")).toMatch(/@@index\(\[status, expiresAt\]\)/);
    expect(block("model", "ReplayNonce")).toMatch(/@@index\(\[expiresAt\]\)/);
  });

  it("expresses active-number, SMS, idempotency, and replay uniqueness", () => {
    expect(block("model", "PartnerNumber")).toMatch(
      /activeCanonicalNumber\s+String\?\s+@unique/,
    );
    expect(block("model", "PartnerSms")).toMatch(/@@unique\(\[deviceId, messageId\]\)/);
    expect(block("model", "PartnerSms")).toMatch(/@@unique\(\[deviceId, idempotencyKey\]\)/);
    expect(block("model", "IdempotencyRecord")).toMatch(
      /@@unique\(\[scope, principalId, key\]\)/,
    );
    expect(block("model", "ReplayNonce")).toMatch(
      /@@unique\(\[principalId, nonceHash\]\)/,
    );
  });

  it("models the immutable snapshot and current-order boundary explicitly", () => {
    const number = block("model", "PartnerNumber");
    const snapshot = block("model", "OrderSnapshot");

    expect(number).toMatch(/currentOrderId\s+String\?\s+@unique\s+@db\.Uuid/);
    expect(number).toMatch(/currentOrder\s+PartnerOrder\?\s+@relation\("CurrentNumberOrder"/);
    expect(snapshot).not.toMatch(/\bid\s+String|updatedAt/);
    for (const field of [
      "serviceCode", "countryCode", "operatorCode", "canonicalNumber", "basePriceIdr",
      "retailPriceIdr", "payoutIdr", "platformMarginIdr", "currency", "configVersion",
    ]) {
      expect(snapshot).toMatch(new RegExp(`\\b${field}\\b`));
    }
    expect(schema).toContain("Task 3.4 SQL must add UPDATE/DELETE protection");
  });

  it("reserves unsupported PostgreSQL checks and partial uniqueness for Task 3.4 SQL", () => {
    expect(schema).toContain("CHECK non-negative monetary values");
    expect(schema).toContain("CHECK activeCanonicalNumber mirrors canonicalNumber");
    expect(schema).toContain("Partial UNIQUE PartnerOrder(numberId)");
    expect(schema).toContain("status IN (created,reserved,waiting_sms)");
    expect(schema).toContain("Trigger/privilege guard preventing UPDATE or DELETE of OrderSnapshot");
  });
});
