import { describe, expect, it } from "vitest";

import { AccountSecurityError } from "./errors";
import {
  canResetTwoFactor,
  isPasswordRotationDue,
  OPERATION_SCOPE,
  PASSWORD_MAX_AGE_MS,
  requiresSecondFactor,
  type SensitiveOperation,
  type TwoFactorScope,
  type TwoFactorState,
} from "./two-factor-scope";

// Roadmap item 7: 2FA terpisah operasi finansial vs login (policy layer).
// See .agents/RESEARCH-HEROSMS-PARTNERS.md §6 "Keamanan akun".

const FINANCIAL_OPERATIONS: readonly SensitiveOperation[] = [
  "withdrawal",
  "change_payout_destination",
  "change_email",
  "reset_2fa",
  "change_password",
];

function state(overrides: Partial<TwoFactorState> = {}): TwoFactorState {
  return {
    loginEnabled: false,
    financialEnabled: false,
    securityQuestionSet: false,
    ...overrides,
  };
}

describe("OPERATION_SCOPE mapping", () => {
  it("maps login to the login scope", () => {
    expect(OPERATION_SCOPE.login).toBe("login");
  });

  it("maps money-movement and high-value security operations to financial", () => {
    for (const operation of FINANCIAL_OPERATIONS) {
      expect(OPERATION_SCOPE[operation]).toBe("financial");
    }
  });

  it("covers exactly the six sensitive operations", () => {
    expect(Object.keys(OPERATION_SCOPE).sort()).toEqual(
      [
        "change_email",
        "change_password",
        "change_payout_destination",
        "login",
        "reset_2fa",
        "withdrawal",
      ].sort(),
    );
  });

  it("is frozen", () => {
    expect(Object.isFrozen(OPERATION_SCOPE)).toBe(true);
  });
});

describe("requiresSecondFactor", () => {
  it("requires the login factor for login when login 2FA is enabled", () => {
    const decision = requiresSecondFactor("login", state({ loginEnabled: true }));
    expect(decision).toEqual({ required: true, scope: "login" });
  });

  it("does not require a factor for login when login 2FA is disabled", () => {
    const decision = requiresSecondFactor(
      "login",
      state({ loginEnabled: false, financialEnabled: true }),
    );
    expect(decision).toEqual({ required: false, reason: "scope_disabled" });
  });

  it("requires the financial factor for each financial operation when financial 2FA is enabled", () => {
    for (const operation of FINANCIAL_OPERATIONS) {
      const decision = requiresSecondFactor(
        operation,
        state({ financialEnabled: true }),
      );
      expect(decision).toEqual({ required: true, scope: "financial" });
    }
  });

  it("does not require a factor for financial operations when financial 2FA is disabled", () => {
    for (const operation of FINANCIAL_OPERATIONS) {
      const decision = requiresSecondFactor(
        operation,
        state({ financialEnabled: false, loginEnabled: true }),
      );
      expect(decision).toEqual({ required: false, reason: "scope_disabled" });
    }
  });

  it("keys the financial decision on financialEnabled only (login toggle is independent)", () => {
    // login enabled but financial disabled -> withdrawal not required.
    expect(
      requiresSecondFactor("withdrawal", state({ loginEnabled: true })),
    ).toEqual({ required: false, reason: "scope_disabled" });
    // financial enabled but login disabled -> login not required.
    expect(
      requiresSecondFactor("login", state({ financialEnabled: true })),
    ).toEqual({ required: false, reason: "scope_disabled" });
  });

  it("returns a frozen decision object", () => {
    const required = requiresSecondFactor("login", state({ loginEnabled: true }));
    const notRequired = requiresSecondFactor("login", state());
    expect(Object.isFrozen(required)).toBe(true);
    expect(Object.isFrozen(notRequired)).toBe(true);
  });

  it("rejects an unknown operation with INVALID_SCOPE", () => {
    const unknown = "delete_account" as SensitiveOperation;
    expect(() => requiresSecondFactor(unknown, state({ financialEnabled: true }))).toThrow(
      AccountSecurityError,
    );
    try {
      requiresSecondFactor(unknown, state({ financialEnabled: true }));
      expect.unreachable("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AccountSecurityError);
      expect((error as AccountSecurityError).code).toBe("INVALID_SCOPE");
    }
  });
});

describe("isPasswordRotationDue", () => {
  it("documents the default 6-month (182 day) threshold", () => {
    expect(PASSWORD_MAX_AGE_MS).toBe(182 * 24 * 60 * 60 * 1000);
  });

  it("is due exactly at the 6-month boundary (inclusive)", () => {
    const lastChangedAtEpochMs = 1_000_000_000_000;
    expect(
      isPasswordRotationDue({
        lastChangedAtEpochMs,
        nowEpochMs: lastChangedAtEpochMs + PASSWORD_MAX_AGE_MS,
      }),
    ).toBe(true);
  });

  it("is not due one millisecond before the boundary", () => {
    const lastChangedAtEpochMs = 1_000_000_000_000;
    expect(
      isPasswordRotationDue({
        lastChangedAtEpochMs,
        nowEpochMs: lastChangedAtEpochMs + PASSWORD_MAX_AGE_MS - 1,
      }),
    ).toBe(false);
  });

  it("is not due for a freshly changed password", () => {
    const lastChangedAtEpochMs = 1_000_000_000_000;
    expect(
      isPasswordRotationDue({ lastChangedAtEpochMs, nowEpochMs: lastChangedAtEpochMs }),
    ).toBe(false);
  });

  it("honours a custom maxAgeMs override", () => {
    const lastChangedAtEpochMs = 1_000_000_000_000;
    const maxAgeMs = 1_000;
    expect(
      isPasswordRotationDue({
        lastChangedAtEpochMs,
        nowEpochMs: lastChangedAtEpochMs + 999,
        maxAgeMs,
      }),
    ).toBe(false);
    expect(
      isPasswordRotationDue({
        lastChangedAtEpochMs,
        nowEpochMs: lastChangedAtEpochMs + 1_000,
        maxAgeMs,
      }),
    ).toBe(true);
  });

  it("throws INVALID_INPUT for a non-integer or negative timestamp", () => {
    expect(() =>
      isPasswordRotationDue({ lastChangedAtEpochMs: -1, nowEpochMs: 10 }),
    ).toThrow(AccountSecurityError);
    expect(() =>
      isPasswordRotationDue({ lastChangedAtEpochMs: 0, nowEpochMs: 1.5 }),
    ).toThrow(AccountSecurityError);
  });

  it("throws INVALID_INPUT for a non-positive maxAgeMs", () => {
    try {
      isPasswordRotationDue({
        lastChangedAtEpochMs: 0,
        nowEpochMs: 10,
        maxAgeMs: 0,
      });
      expect.unreachable("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AccountSecurityError);
      expect((error as AccountSecurityError).code).toBe("INVALID_INPUT");
    }
  });

  it("throws INVALID_INPUT when now precedes the last change (clock skew)", () => {
    try {
      isPasswordRotationDue({ lastChangedAtEpochMs: 100, nowEpochMs: 99 });
      expect.unreachable("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AccountSecurityError);
      expect((error as AccountSecurityError).code).toBe("INVALID_INPUT");
    }
  });
});

describe("canResetTwoFactor", () => {
  it("is true only when the security question is set (sole 2FA reset path)", () => {
    expect(canResetTwoFactor(state({ securityQuestionSet: true }))).toBe(true);
  });

  it("is false when the security question is not set, regardless of 2FA toggles", () => {
    expect(
      canResetTwoFactor(
        state({ loginEnabled: true, financialEnabled: true, securityQuestionSet: false }),
      ),
    ).toBe(false);
  });
});

describe("type surface", () => {
  it("exposes the two scopes and full operation set through the map", () => {
    const scopes: readonly TwoFactorScope[] = ["login", "financial"];
    for (const scope of Object.values(OPERATION_SCOPE)) {
      expect(scopes).toContain(scope);
    }
  });
});
