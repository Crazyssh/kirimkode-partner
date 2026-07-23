import { describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma";
import type { EncryptedSmsRecord } from "@application/sms";

import type { PartnerTransactionClient } from "./client";
import { PrismaPartnerSmsGateway } from "./partner-sms-gateway";
import { ResourceNotFoundError } from "./repository-errors";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Row = Record<string, unknown>;

/**
 * Minimal in-memory PartnerSms + PartnerDevice delegates that honour the two
 * `(deviceId, messageId)` / `(deviceId, idempotencyKey)` unique constraints so
 * a replay throws the same P2002 the real Prisma client would.
 */
function fakeTx(options: { readonly ownedDeviceIds: readonly string[] }): {
  tx: PartnerTransactionClient;
  smsRows: Row[];
} {
  const smsRows: Row[] = [];
  const partnerDevice = {
    async findFirst(args: { where: Row }) {
      const { id, partnerId } = args.where as { id: string; partnerId: string };
      const owned = options.ownedDeviceIds.includes(id) && partnerId === TENANT_A;
      return owned ? { id } : null;
    },
  };
  const partnerSms = {
    async create(args: { data: Row }) {
      const data = args.data;
      const clash = smsRows.find(
        (row) =>
          row.deviceId === data.deviceId &&
          (row.messageId === data.messageId || row.idempotencyKey === data.idempotencyKey),
      );
      if (clash !== undefined) {
        const target =
          clash.messageId === data.messageId
            ? ["deviceId", "messageId"]
            : ["deviceId", "idempotencyKey"];
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
          meta: { target },
        });
      }
      const row: Row = {
        ...data,
        matchStatus: "PENDING",
        matchedOrderId: null,
        receivedAtServer: new Date(1_000),
        extractedAt: null,
        redactedAt: null,
      };
      smsRows.push(row);
      return row;
    },
  };
  const tx = { partnerDevice, partnerSms } as unknown as PartnerTransactionClient;
  return { tx, smsRows };
}

function record(overrides: Partial<EncryptedSmsRecord> = {}): EncryptedSmsRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    deviceId: DEVICE_A,
    numberId: "22222222-2222-4222-8222-222222222222",
    messageId: "msg-1",
    idempotencyKey: "idem-1",
    senderCiphertext: Uint8Array.from([1, 2, 3]),
    bodyCiphertext: Uint8Array.from([4, 5, 6]),
    keyVersion: 1,
    bodyFingerprint: "a".repeat(64),
    receivedAtDeviceEpochMs: 500,
    ...overrides,
  };
}

// **Validates: Requirements 11.2, 11.3, 19.3**
describe("PrismaPartnerSmsGateway", () => {
  it("inserts an encrypted SMS and returns only the redaction-safe view", async () => {
    const gateway = new PrismaPartnerSmsGateway();
    const { tx } = fakeTx({ ownedDeviceIds: [DEVICE_A] });

    const result = await gateway.insertEncryptedSms(tx, TENANT_A, record());

    expect(result.kind).toBe("inserted");
    if (result.kind !== "inserted") return;
    // The safe view exposes identifiers, key version, fingerprint, and lifecycle
    // fields only — never ciphertext or plaintext.
    expect(result.sms).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      deviceId: DEVICE_A,
      messageId: "msg-1",
      keyVersion: 1,
      bodyFingerprint: "a".repeat(64),
      matchStatus: "pending",
      matchedOrderId: null,
      receivedAtDeviceEpochMs: 500,
    });
    expect(JSON.stringify(result.sms)).not.toContain("Ciphertext");
    expect(Object.keys(result.sms)).not.toContain("bodyCiphertext");
    expect(Object.keys(result.sms)).not.toContain("senderCiphertext");
  });

  it("resolves a messageId replay to a duplicate rather than a second row", async () => {
    const gateway = new PrismaPartnerSmsGateway();
    const { tx, smsRows } = fakeTx({ ownedDeviceIds: [DEVICE_A] });

    await gateway.insertEncryptedSms(tx, TENANT_A, record());
    const replay = await gateway.insertEncryptedSms(
      tx,
      TENANT_A,
      record({ idempotencyKey: "idem-2" }),
    );

    expect(replay).toEqual({ kind: "duplicate", matchedBy: "message_id" });
    expect(smsRows).toHaveLength(1);
  });

  it("resolves an idempotencyKey replay to a duplicate", async () => {
    const gateway = new PrismaPartnerSmsGateway();
    const { tx, smsRows } = fakeTx({ ownedDeviceIds: [DEVICE_A] });

    await gateway.insertEncryptedSms(tx, TENANT_A, record());
    const replay = await gateway.insertEncryptedSms(
      tx,
      TENANT_A,
      record({ messageId: "msg-2" }),
    );

    expect(replay).toEqual({ kind: "duplicate", matchedBy: "idempotency_key" });
    expect(smsRows).toHaveLength(1);
  });

  it("maps a cross-tenant or missing device to RESOURCE_NOT_FOUND", async () => {
    const gateway = new PrismaPartnerSmsGateway();
    const { tx, smsRows } = fakeTx({ ownedDeviceIds: [] });

    await expect(
      gateway.insertEncryptedSms(tx, TENANT_A, record()),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    // A rejected insert never touches the SMS table.
    expect(smsRows).toHaveLength(0);
  });
});
