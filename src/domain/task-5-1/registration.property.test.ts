import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  OwnerMemberRecord,
  PendingPartnerRecord,
  RegisterPartnerCommand,
  RegistrationTransactionPort,
  RegistrationUnitOfWorkPort,
  registerPartner,
} from "@domain/task-5-1/registration";

// Feature: partner-platform, Property 1: Registrasi tenant atomik
//
// For all payload registrasi valid, hasilnya mempunyai tepat satu Partner
// berstatus `pending` dan tepat satu PartnerMember `owner` yang merujuk Partner
// tersebut; untuk setiap kegagalan transaksi, tidak satu pun dari keduanya
// tersimpan.
//
// Validates: Requirements 2.1
//
// Design references:
// - Registrasi membuat Partner(pending) + PartnerMember(owner) dalam satu
//   transaksi (Components §1).
// - Pure domain test tidak memakai DB/network; unit-of-work dipalsukan dengan
//   failure injection deterministik (Testing Strategy §Property-Based Testing).
// - numRuns minimum 100 (Property 1 bukan bagian target 500-run parser/pricing/
//   state machine/ledger).

const NUM_RUNS = 100;

/**
 * Titik kegagalan yang dapat diinjeksikan ke dalam unit-of-work palsu.
 * - `none`   : transaksi commit penuh (jalur sukses).
 * - `partner`: createPartner gagal sebelum apa pun tersimpan.
 * - `owner`  : createPartner sukses secara staging, tetapi createOwner gagal
 *              sehingga transaksi harus rollback keduanya.
 */
type FailurePoint = "none" | "partner" | "owner";

/**
 * Unit-of-work palsu yang meniru semantik transaksi atomik: record hanya
 * ter-commit ke store ketika keseluruhan `work` selesai tanpa melempar. Bila
 * ada tahap yang melempar, tidak ada record yang ter-commit.
 */
class FailInjectingUnitOfWork implements RegistrationUnitOfWorkPort {
  readonly committedPartners: PendingPartnerRecord[] = [];
  readonly committedOwners: OwnerMemberRecord[] = [];

  constructor(private readonly failAt: FailurePoint) {}

  async execute<T>(
    work: (transaction: RegistrationTransactionPort) => Promise<T>,
  ): Promise<T> {
    const stagedPartners: PendingPartnerRecord[] = [];
    const stagedOwners: OwnerMemberRecord[] = [];

    const transaction: RegistrationTransactionPort = {
      createPartner: async (input) => {
        if (this.failAt === "partner") {
          throw new Error("PARTNER_INSERT_FAILED");
        }
        stagedPartners.push(input);
        return input;
      },
      createOwner: async (input) => {
        if (this.failAt === "owner") {
          throw new Error("OWNER_INSERT_FAILED");
        }
        stagedOwners.push(input);
        return input;
      },
    };

    // If `work` throws the staged records are discarded (rollback).
    const result = await work(transaction);
    this.committedPartners.push(...stagedPartners);
    this.committedOwners.push(...stagedOwners);
    return result;
  }
}

const passwordHashPort = {
  // Deterministic non-identity hash: never empty and never equal to the input,
  // satisfying the domain's PASSWORD_HASH_INVALID guard.
  hash: async (password: string) => `argon2id$${password.length.toString(36)}$hash`,
};

// A single printable code point per element keeps Array.from() code-point
// counting equal to the array length, so password length bounds stay exact even
// with astral characters.
const passwordUnitArbitrary = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !@#$%^&*()-_=+".split(
    "",
  ),
  "🔐",
  "é",
  "λ",
);

const validPasswordArbitrary = fc
  .array(passwordUnitArbitrary, { minLength: 12, maxLength: 128 })
  .map((units) => units.join(""));

const nameArbitrary = fc
  .string({ minLength: 0, maxLength: 32 })
  .map((suffix) => `PT ${suffix}`);

const validCommandArbitrary: fc.Arbitrary<RegisterPartnerCommand> = fc.record({
  partnerId: fc.uuid(),
  ownerMemberId: fc.uuid(),
  legalName: nameArbitrary,
  displayName: nameArbitrary,
  ownerEmail: fc.emailAddress(),
  ownerPassword: validPasswordArbitrary,
  createdAtEpochMs: fc.integer({ min: 0, max: 4_102_444_800_000 }),
});

const failurePointArbitrary = fc.constantFrom<FailurePoint>(
  "none",
  "partner",
  "owner",
);

describe("Property 1: Registrasi tenant atomik", () => {
  it("commits exactly one pending Partner + owner on success and nothing on any failure", async () => {
    await fc.assert(
      fc.asyncProperty(
        validCommandArbitrary,
        failurePointArbitrary,
        async (command, failAt) => {
          const unitOfWork = new FailInjectingUnitOfWork(failAt);
          const dependencies = {
            passwordHash: passwordHashPort,
            unitOfWork,
          };

          if (failAt === "none") {
            const result = await registerPartner(command, dependencies);

            // Exactly one Partner and one owner are persisted.
            expect(unitOfWork.committedPartners).toHaveLength(1);
            expect(unitOfWork.committedOwners).toHaveLength(1);

            const [partner] = unitOfWork.committedPartners;
            const [owner] = unitOfWork.committedOwners;

            // Partner is pending and matches the command identity.
            expect(partner.status).toBe("pending");
            expect(partner.id).toBe(command.partnerId);

            // Owner references the created Partner with the owner role.
            expect(owner.role).toBe("owner");
            expect(owner.partnerId).toBe(partner.id);
            expect(owner.id).toBe(command.ownerMemberId);

            // The returned result mirrors the committed records.
            expect(result.partner).toBe(partner);
            expect(result.owner).toBe(owner);
          } else {
            // Any transaction failure must persist neither record.
            await expect(registerPartner(command, dependencies)).rejects.toThrow(
              failAt === "partner"
                ? "PARTNER_INSERT_FAILED"
                : "OWNER_INSERT_FAILED",
            );
            expect(unitOfWork.committedPartners).toHaveLength(0);
            expect(unitOfWork.committedOwners).toHaveLength(0);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
