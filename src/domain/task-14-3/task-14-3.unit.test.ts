import { describe, expect, it } from "vitest";

import {
  decidePayoutDestination,
  INDONESIAN_BANK_CODES,
  isIndonesianBankCode,
  MAX_ACCOUNT_HOLDER_LENGTH,
  normalizeBankCode,
} from "./payout-destination";

// **Validates: Requirements 14.7, 23.3**
describe("decidePayoutDestination", () => {
  const base = {
    bankCode: "BCA",
    accountNumber: "1234567890",
    accountHolderName: "Budi Santoso",
  };

  it("accepts a valid Indonesian bank destination and derives last4", () => {
    const decision = decidePayoutDestination(base);
    expect(decision.kind).toBe("valid");
    if (decision.kind !== "valid") return;
    expect(decision.destination).toEqual({
      bankCode: "BCA",
      accountNumber: "1234567890",
      accountNumberLast4: "7890",
      accountHolderName: "Budi Santoso",
    });
  });

  it("normalises the bank code (trim + uppercase)", () => {
    const decision = decidePayoutDestination({ ...base, bankCode: "  mandiri " });
    expect(decision.kind).toBe("valid");
    if (decision.kind !== "valid") return;
    expect(decision.destination.bankCode).toBe("MANDIRI");
  });

  it("strips spaces and dashes from the account number before validating", () => {
    const decision = decidePayoutDestination({
      ...base,
      accountNumber: "1234-5678 90",
    });
    expect(decision.kind).toBe("valid");
    if (decision.kind !== "valid") return;
    expect(decision.destination.accountNumber).toBe("1234567890");
    expect(decision.destination.accountNumberLast4).toBe("7890");
  });

  it("trims the account holder name", () => {
    const decision = decidePayoutDestination({
      ...base,
      accountHolderName: "  Siti Aminah  ",
    });
    expect(decision.kind).toBe("valid");
    if (decision.kind !== "valid") return;
    expect(decision.destination.accountHolderName).toBe("Siti Aminah");
  });

  it("rejects an unrecognised (non-Indonesian) bank code", () => {
    const decision = decidePayoutDestination({ ...base, bankCode: "PAYPAL" });
    expect(decision).toEqual({ kind: "reject", code: "invalid_bank_code" });
  });

  it("rejects a non-numeric account number", () => {
    const decision = decidePayoutDestination({ ...base, accountNumber: "12AB567890" });
    expect(decision).toEqual({ kind: "reject", code: "invalid_account_number" });
  });

  it("rejects an account number that is too short", () => {
    const decision = decidePayoutDestination({ ...base, accountNumber: "1234567" });
    expect(decision).toEqual({ kind: "reject", code: "invalid_account_number" });
  });

  it("rejects an account number that is too long", () => {
    const decision = decidePayoutDestination({
      ...base,
      accountNumber: "1".repeat(21),
    });
    expect(decision).toEqual({ kind: "reject", code: "invalid_account_number" });
  });

  it("rejects a blank account holder name", () => {
    const decision = decidePayoutDestination({ ...base, accountHolderName: "   " });
    expect(decision).toEqual({ kind: "reject", code: "invalid_account_holder" });
  });

  it("rejects an over-long account holder name", () => {
    const decision = decidePayoutDestination({
      ...base,
      accountHolderName: "a".repeat(MAX_ACCOUNT_HOLDER_LENGTH + 1),
    });
    expect(decision).toEqual({ kind: "reject", code: "invalid_account_holder" });
  });
});

describe("bank code helpers", () => {
  it("recognises the core Indonesian banks", () => {
    for (const code of ["BCA", "BRI", "BNI", "MANDIRI", "BSI", "BTN"]) {
      expect(isIndonesianBankCode(code)).toBe(true);
      expect(INDONESIAN_BANK_CODES.has(code)).toBe(true);
    }
  });

  it("rejects unknown codes after normalisation", () => {
    expect(isIndonesianBankCode(normalizeBankCode("not-a-bank"))).toBe(false);
  });
});
