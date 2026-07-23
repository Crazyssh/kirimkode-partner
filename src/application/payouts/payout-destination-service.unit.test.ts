import { describe, expect, it } from "vitest";

import type { AuthenticatedPrincipal } from "@domain/task-7-2";

import { toSessionContext, type SessionContext } from "../authorization/session-context";
import { PayoutDestinationService } from "./payout-destination-service";
import type {
  AuditWriteInput,
  EncryptedField,
  NewPayoutDestination,
  PayoutDestinationGateway,
  PayoutDestinationTransaction,
  PayoutDestinationView,
  PayoutSecretCipher,
} from "./ports";

const PARTNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const DESTINATION_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

/** Records what the cipher was asked to encrypt; returns deterministic bytes. */
class FakeCipher implements PayoutSecretCipher {
  public readonly encrypted: string[] = [];
  readonly keyVersion = 7;

  encrypt(plaintext: string): EncryptedField {
    this.encrypted.push(plaintext);
    return {
      ciphertext: Uint8Array.from(Buffer.from(`enc:${plaintext}`, "utf8")),
      keyVersion: this.keyVersion,
    };
  }

  async decrypt(): Promise<string | null> {
    throw new Error("not used");
  }
}

/** In-memory destination gateway capturing the inserted row + audit event. */
class FakeGateway implements PayoutDestinationGateway {
  public inserted: NewPayoutDestination | null = null;
  public audit: AuditWriteInput | null = null;

  async runInTenant<T>(
    _tenant: unknown,
    work: (tx: PayoutDestinationTransaction) => Promise<T>,
  ): Promise<T> {
    const tx: PayoutDestinationTransaction = {
      insertDestination: async (
        record: NewPayoutDestination,
      ): Promise<PayoutDestinationView> => {
        this.inserted = record;
        return {
          id: record.id,
          partnerId: PARTNER_A,
          bankCode: record.bankCode,
          accountNumberLast4: record.accountNumberLast4,
          accountHolderName: record.accountHolderName,
          status: "active",
        };
      },
      recordAudit: async (input: AuditWriteInput): Promise<void> => {
        this.audit = input;
      },
    };
    return work(tx);
  }
}

function principal(over: Partial<AuthenticatedPrincipal> = {}): AuthenticatedPrincipal {
  return { memberId: OWNER_ID, partnerId: PARTNER_A, role: "owner", securityVersion: 1, ...over };
}

function context(over: Partial<AuthenticatedPrincipal> = {}): SessionContext {
  return toSessionContext(principal(over));
}

let idSeq = 0;
function makeService(gateway: FakeGateway, cipher: FakeCipher): PayoutDestinationService {
  idSeq = 0;
  return new PayoutDestinationService({
    gateway,
    cipher,
    clock: { nowEpochMs: () => 1_700_000_000_000 },
    idGenerator: { uuid: () => (idSeq === 0 ? ((idSeq += 1), DESTINATION_ID) : `id-${(idSeq += 1)}`) },
  });
}

// **Validates: Requirements 14.7, 23.3**
describe("PayoutDestinationService.createDestination", () => {
  it("encrypts the account number, stores only last4, and audits the change", async () => {
    const gateway = new FakeGateway();
    const cipher = new FakeCipher();
    const service = makeService(gateway, cipher);

    const result = await service.createDestination({
      caller: context(),
      bankCode: "bca",
      accountNumber: "1234-5678-90",
      accountHolderName: "  Budi Santoso ",
      requestId: REQUEST_ID,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.destination).toMatchObject({
      id: DESTINATION_ID,
      bankCode: "BCA",
      accountNumberLast4: "7890",
      accountHolderName: "Budi Santoso",
      status: "active",
    });

    // Only the sanitised digits were encrypted; the raw number is never stored.
    expect(cipher.encrypted).toEqual(["1234567890"]);
    expect(gateway.inserted).not.toBeNull();
    expect(gateway.inserted?.accountNumberLast4).toBe("7890");
    expect(gateway.inserted?.keyVersion).toBe(7);
    expect(Buffer.from(gateway.inserted!.accountNumberCiphertext).toString("utf8")).toBe(
      "enc:1234567890",
    );

    // Audit metadata carries last4 but never the full number.
    const meta = gateway.audit?.descriptor.safeMetadata as Record<string, unknown>;
    expect(gateway.audit?.descriptor.action).toBe("payout.changed");
    expect(gateway.audit?.descriptor.targetType).toBe("payout_destination");
    expect(meta.accountNumberLast4).toBe("7890");
    expect(JSON.stringify(meta)).not.toContain("1234567890");
  });

  it("forbids a member without the manage_payout_destination permission", async () => {
    const gateway = new FakeGateway();
    const service = makeService(gateway, new FakeCipher());

    const result = await service.createDestination({
      caller: context({ role: "member", memberId: MEMBER_ID }),
      bankCode: "BCA",
      accountNumber: "1234567890",
      accountHolderName: "Budi",
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(gateway.inserted).toBeNull();
  });

  it("rejects an invalid bank code as a validation failure", async () => {
    const gateway = new FakeGateway();
    const service = makeService(gateway, new FakeCipher());

    const result = await service.createDestination({
      caller: context(),
      bankCode: "PAYPAL",
      accountNumber: "1234567890",
      accountHolderName: "Budi",
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ ok: false, reason: "validation", code: "invalid_bank_code" });
    expect(gateway.inserted).toBeNull();
  });
});
