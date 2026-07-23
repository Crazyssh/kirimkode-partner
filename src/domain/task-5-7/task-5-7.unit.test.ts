import { describe, expect, it } from "vitest";

import {
  assertValidPlatformConfig,
  DEFAULT_PLATFORM_CONFIG,
  DEFAULT_RETENTION_CONFIG,
  type PlatformConfigInput,
  validatePlatformConfig,
} from "./config";
import {
  authorizeRawSmsAccess,
  createAuditEvent,
  RAW_SMS_PERMISSION,
  RAW_SMS_REAUTH_WINDOW_MS,
} from "./audit";
import { decideRetention, isProtectedEvidence } from "./retention";
import { reconcile } from "./reconciliation";
import {
  declareCapabilities,
  type DeclareCapabilitiesInput,
  decideDeviceCreation,
  decideSimulatorCreation,
  supportsCapability,
} from "./simulator";
import {
  formatIdr,
  formatJakartaTimestamp,
  JAKARTA_UTC_OFFSET_MS,
  toJakartaParts,
} from "./formatter";
import { Task57DomainError } from "./errors";
import { createLedgerTransaction } from "../task-5-6/ledger";

// ---------------------------------------------------------------------------
// Config invariants (Req 16.5, 19.4)
// ---------------------------------------------------------------------------

function config(overrides: Partial<PlatformConfigInput> = {}): PlatformConfigInput {
  return { ...DEFAULT_PLATFORM_CONFIG, ...overrides };
}

describe("PlatformConfig invariants", () => {
  it("accepts the MVP default config", () => {
    const result = validatePlatformConfig(DEFAULT_PLATFORM_CONFIG);
    expect(result.valid).toBe(true);
  });

  it("rejects an unordered guardrail (min > max)", () => {
    const result = validatePlatformConfig(
      config({ minBasePriceIdr: 6000, maxBasePriceIdr: 5000 }),
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.violations.map((v) => v.code)).toContain("guardrail_not_ordered");
  });

  it("rejects cancel minimum >= order timeout", () => {
    const result = validatePlatformConfig(
      config({ cancelMinimumMs: 20 * 60 * 1000, orderTimeoutMs: 20 * 60 * 1000 }),
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.violations.map((v) => v.code)).toContain(
      "cancel_minimum_not_below_order_timeout",
    );
  });

  it("rejects heartbeat timeout <= interval", () => {
    const result = validatePlatformConfig(
      config({ heartbeatIntervalMs: 90_000, heartbeatTimeoutMs: 90_000 }),
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.violations.map((v) => v.code)).toContain(
      "heartbeat_timeout_not_above_interval",
    );
  });

  it("rejects a non-positive minimum payout", () => {
    const result = validatePlatformConfig(config({ minimumPayoutIdr: 0 }));
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.violations.map((v) => v.code)).toContain(
      "minimum_payout_not_positive",
    );
  });

  it("rejects negative retention windows", () => {
    const result = validatePlatformConfig(
      config({ retention: { ...DEFAULT_RETENTION_CONFIG, smsRawMs: -1 } }),
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.violations.map((v) => v.code)).toContain("retention_negative");
  });

  it("assertValidPlatformConfig throws on an invalid config", () => {
    expect(() =>
      assertValidPlatformConfig(config({ minimumPayoutIdr: -5 })),
    ).toThrowError(Task57DomainError);
  });

  it("assertValidPlatformConfig returns a frozen config when valid", () => {
    const frozen = assertValidPlatformConfig(DEFAULT_PLATFORM_CONFIG);
    expect(Object.isFrozen(frozen)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Audit descriptors + raw SMS access (Req 19.1, 19.2, 19.3)
// ---------------------------------------------------------------------------

describe("audit event descriptor completeness", () => {
  it("builds a complete descriptor with safe metadata", () => {
    const event = createAuditEvent({
      actorType: "partner_admin",
      actorRef: "admin-1",
      action: "payout.changed",
      targetType: "payout",
      targetId: "payout-1",
      result: "success",
      occurredAtEpochMs: 1_700_000_000_000,
      metadata: { fromStatus: "requested", toStatus: "approved" },
    });
    expect(event.actorRef).toBe("admin-1");
    expect(event.action).toBe("payout.changed");
    expect(event.safeMetadata).toEqual({
      fromStatus: "requested",
      toStatus: "approved",
    });
    expect(Object.isFrozen(event)).toBe(true);
  });

  it("redacts sensitive metadata before storing", () => {
    const event = createAuditEvent({
      actorType: "system",
      actorRef: "system",
      action: "credential.changed",
      targetType: "device_credential",
      targetId: "dc-1",
      result: "success",
      occurredAtEpochMs: 1_700_000_000_000,
      metadata: { secret: "super-secret", otp: "123456", note: "rotated" },
    });
    expect(event.safeMetadata.secret).toBe("[REDACTED]");
    expect(event.safeMetadata.otp).toBe("[REDACTED]");
    expect(event.safeMetadata.note).toBe("rotated");
  });

  it("rejects an incomplete descriptor (missing target)", () => {
    expect(() =>
      createAuditEvent({
        actorType: "partner_admin",
        actorRef: "admin-1",
        action: "payout.changed",
        targetType: "payout",
        targetId: "  ",
        result: "success",
        occurredAtEpochMs: 1_700_000_000_000,
      }),
    ).toThrowError(Task57DomainError);
  });

  it("rejects an unknown action", () => {
    expect(() =>
      createAuditEvent({
        actorType: "partner_admin",
        actorRef: "admin-1",
        // @ts-expect-error unknown action
        action: "not.an.action",
        targetType: "payout",
        targetId: "payout-1",
        result: "success",
        occurredAtEpochMs: 1_700_000_000_000,
      }),
    ).toThrowError(Task57DomainError);
  });
});

describe("least-privilege raw SMS access", () => {
  const base = {
    adminRef: "admin-1",
    permissions: [RAW_SMS_PERMISSION],
    reason: "buyer complaint #42",
    reauthenticatedAtEpochMs: 1_700_000_000_000,
    nowEpochMs: 1_700_000_000_000 + 60_000,
    targetSmsId: "sms-1",
  };

  it("grants access with permission, reason, and fresh re-auth, emitting audit", () => {
    const decision = authorizeRawSmsAccess(base);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.audit.action).toBe("sms.raw_accessed");
    expect(decision.audit.targetId).toBe("sms-1");
  });

  it("denies when the sms:raw permission is missing", () => {
    const decision = authorizeRawSmsAccess({ ...base, permissions: ["other"] });
    expect(decision).toMatchObject({ allowed: false, code: "missing_permission" });
  });

  it("denies when no reason is supplied", () => {
    const decision = authorizeRawSmsAccess({ ...base, reason: "   " });
    expect(decision).toMatchObject({ allowed: false, code: "missing_reason" });
  });

  it("denies when the re-auth is stale", () => {
    const decision = authorizeRawSmsAccess({
      ...base,
      nowEpochMs: base.reauthenticatedAtEpochMs + RAW_SMS_REAUTH_WINDOW_MS + 1,
    });
    expect(decision).toMatchObject({ allowed: false, code: "reauth_required" });
  });
});

// ---------------------------------------------------------------------------
// Retention (Req 19.4, 19.5)
// ---------------------------------------------------------------------------

describe("retention decisions", () => {
  const now = 10 * 365 * 24 * 60 * 60 * 1000; // well past every window

  it("redacts raw SMS only after 7 days", () => {
    const justBefore = decideRetention({
      category: "sms_raw",
      referenceEpochMs: now - (DEFAULT_RETENTION_CONFIG.smsRawMs - 1),
      nowEpochMs: now,
      retention: DEFAULT_RETENTION_CONFIG,
    });
    expect(justBefore.action).toBe("retain");

    const atBoundary = decideRetention({
      category: "sms_raw",
      referenceEpochMs: now - DEFAULT_RETENTION_CONFIG.smsRawMs,
      nowEpochMs: now,
      retention: DEFAULT_RETENTION_CONFIG,
    });
    expect(atBoundary.action).toBe("redact");
  });

  it("deletes heartbeat metadata after 30 days", () => {
    const decision = decideRetention({
      category: "heartbeat_metadata",
      referenceEpochMs: now - DEFAULT_RETENTION_CONFIG.heartbeatMetadataMs,
      nowEpochMs: now,
      retention: DEFAULT_RETENTION_CONFIG,
    });
    expect(decision.action).toBe("delete");
  });

  it("always retains protected financial/audit evidence", () => {
    for (const category of ["audit", "ledger", "payout"] as const) {
      const decision = decideRetention({
        category,
        referenceEpochMs: 0,
        nowEpochMs: now,
        retention: DEFAULT_RETENTION_CONFIG,
      });
      expect(decision.action).toBe("retain");
      expect(decision.protectedEvidence).toBe(true);
      expect(isProtectedEvidence(category)).toBe(true);
    }
  });

  it("redacts OTP 24h after terminal", () => {
    const decision = decideRetention({
      category: "otp",
      referenceEpochMs: now - DEFAULT_RETENTION_CONFIG.otpAfterTerminalMs,
      nowEpochMs: now,
      retention: DEFAULT_RETENTION_CONFIG,
    });
    expect(decision.action).toBe("redact");
  });
});

// ---------------------------------------------------------------------------
// Reconciliation (Req 20.6)
// ---------------------------------------------------------------------------

describe("reconciliation detector", () => {
  const successTx = createLedgerTransaction({
    eventType: "order-success",
    eventKey: "order-success:order-1",
    referenceType: "order",
    referenceId: "order-1",
    entries: [
      { bucket: "platform_partner_payable", amountIdrSigned: -1000 },
      { bucket: "partner_pending", amountIdrSigned: 1000 },
    ],
  });

  it("reports no issues for consistent state", () => {
    const report = reconcile({
      ledgerTransactions: [successTx],
      earnings: [{ id: "earn-1", orderId: "order-1", amountIdr: 1000, status: "pending" }],
      orderSnapshots: [{ orderId: "order-1", payoutIdr: 1000 }],
      payouts: [],
    });
    expect(report.consistent).toBe(true);
    expect(report.issues).toHaveLength(0);
  });

  it("detects an earning that mismatches the snapshot payout", () => {
    const report = reconcile({
      earnings: [{ id: "earn-1", orderId: "order-1", amountIdr: 999, status: "pending" }],
      orderSnapshots: [{ orderId: "order-1", payoutIdr: 1000 }],
    });
    expect(report.issues.map((i) => i.type)).toContain("earning_snapshot_mismatch");
  });

  it("detects duplicate earnings for one order", () => {
    const report = reconcile({
      earnings: [
        { id: "earn-1", orderId: "order-1", amountIdr: 1000, status: "pending" },
        { id: "earn-2", orderId: "order-1", amountIdr: 1000, status: "pending" },
      ],
    });
    expect(report.issues.map((i) => i.type)).toContain("duplicate_earning_for_order");
  });

  it("detects a payout whose amount != sum of allocations", () => {
    const report = reconcile({
      payouts: [
        {
          id: "payout-1",
          amountIdr: 3000,
          allocations: [
            { earningId: "earn-1", amountIdr: 1000 },
            { earningId: "earn-2", amountIdr: 1500 },
          ],
        },
      ],
    });
    expect(report.issues.map((i) => i.type)).toContain("payout_allocation_mismatch");
  });

  it("detects an earning allocated to more than one payout", () => {
    const report = reconcile({
      payouts: [
        { id: "p-1", amountIdr: 1000, allocations: [{ earningId: "earn-1", amountIdr: 1000 }] },
        { id: "p-2", amountIdr: 1000, allocations: [{ earningId: "earn-1", amountIdr: 1000 }] },
      ],
    });
    expect(report.issues.map((i) => i.type)).toContain(
      "duplicate_allocation_for_earning",
    );
  });

  it("detects a non zero-sum ledger transaction without repairing it", () => {
    const badTx = {
      eventType: "order-success" as const,
      eventKey: "order-success:bad",
      referenceType: "order",
      referenceId: "bad",
      entries: [
        { bucket: "platform_partner_payable" as const, amountIdrSigned: -1000 },
        { bucket: "partner_pending" as const, amountIdrSigned: 900 },
      ],
    };
    const report = reconcile({ ledgerTransactions: [badTx] });
    const types = report.issues.map((i) => i.type);
    expect(types).toContain("ledger_transaction_not_zero_sum");
    expect(types).toContain("ledger_global_imbalance");
    // The reconciler is read-only: the input transaction is untouched.
    expect(badTx.entries[1].amountIdrSigned).toBe(900);
  });

  it("detects order/number pairing mismatch", () => {
    const report = reconcile({
      orderNumberPairs: [
        { orderId: "order-1", orderStatus: "waiting_sms", numberId: "num-1", numberStatus: "available" },
      ],
    });
    expect(report.issues.map((i) => i.type)).toContain(
      "order_number_pairing_mismatch",
    );
  });

  it("detects a stale online device", () => {
    const report = reconcile({
      devices: [{ id: "dev-1", effectiveStatus: "online", lastSeenAtEpochMs: 0 }],
      nowEpochMs: 200_000,
      heartbeatTimeoutMs: 90_000,
    });
    expect(report.issues.map((i) => i.type)).toContain("stale_online_device");
  });

  it("detects projection vs ledger balance mismatch", () => {
    const report = reconcile({
      ledgerTransactions: [successTx],
      projectionBalances: { partner_pending: 999 },
    });
    expect(report.issues.map((i) => i.type)).toContain("projection_ledger_mismatch");
  });
});

// ---------------------------------------------------------------------------
// Simulator + capability policy (Req 17.1, 17.2, 21.1, 21.4)
// ---------------------------------------------------------------------------

describe("simulator creation policy", () => {
  it("allows simulator creation outside production", () => {
    expect(
      decideSimulatorCreation({ environment: "development", partnerSimulatorAllowed: false }),
    ).toMatchObject({ allowed: true, reason: "non_production_environment" });
  });

  it("allows simulator in production only when partner is allowlisted", () => {
    expect(
      decideSimulatorCreation({ environment: "production", partnerSimulatorAllowed: true }),
    ).toMatchObject({ allowed: true, reason: "partner_simulator_allowed" });
    expect(
      decideSimulatorCreation({ environment: "production", partnerSimulatorAllowed: false }),
    ).toMatchObject({ allowed: false, code: "simulator_not_allowed" });
  });

  it("does not gate non-simulator device types by simulator policy", () => {
    expect(
      decideDeviceCreation("android", { environment: "production", partnerSimulatorAllowed: false }),
    ).toMatchObject({ allowed: true });
  });
});

describe("explicit device capabilities", () => {
  it("declares and freezes a validated capability set", () => {
    const caps = declareCapabilities({
      sms: true,
      notification: false,
      resend: false,
      operator: "any",
      slots: 1,
    });
    expect(supportsCapability(caps, "sms")).toBe(true);
    expect(supportsCapability(caps, "notification")).toBe(false);
    expect(caps.operator).toBe("any");
    expect(Object.isFrozen(caps)).toBe(true);
  });

  it("requires capabilities to be declared explicitly (no defaults)", () => {
    const missingSms = {
      notification: false,
      resend: false,
      slots: 1,
    } as unknown as DeclareCapabilitiesInput;
    expect(() => declareCapabilities(missingSms)).toThrowError(Task57DomainError);
  });

  it("rejects a non-positive slot count", () => {
    expect(() =>
      declareCapabilities({ sms: true, notification: false, resend: false, slots: 0 }),
    ).toThrowError(Task57DomainError);
  });
});

// ---------------------------------------------------------------------------
// Formatter (Req 15.4)
// ---------------------------------------------------------------------------

describe("IDR and Asia/Jakarta formatter", () => {
  it("formats IDR as integer Rupiah with dot grouping", () => {
    expect(formatIdr(1000)).toBe("Rp1.000");
    expect(formatIdr(1400)).toBe("Rp1.400");
    expect(formatIdr(0)).toBe("Rp0");
    expect(formatIdr(1_234_567)).toBe("Rp1.234.567");
    expect(formatIdr(-1000)).toBe("-Rp1.000");
  });

  it("rejects non-integer amounts", () => {
    expect(() => formatIdr(10.5)).toThrowError(Task57DomainError);
  });

  it("formats a UTC instant as Asia/Jakarta (UTC+7) without mutating the source", () => {
    const source = new Date("2025-01-01T00:00:00.000Z");
    const before = source.getTime();
    expect(formatJakartaTimestamp(source)).toBe("2025-01-01 07:00:00 WIB");
    expect(source.getTime()).toBe(before);
  });

  it("rolls the date across midnight in Jakarta", () => {
    // 20:00 UTC -> 03:00 next day WIB
    expect(formatJakartaTimestamp(new Date("2025-01-01T20:00:00.000Z"))).toBe(
      "2025-01-02 03:00:00 WIB",
    );
  });

  it("toJakartaParts applies the fixed +7h offset", () => {
    const parts = toJakartaParts(0);
    expect(JAKARTA_UTC_OFFSET_MS).toBe(7 * 60 * 60 * 1000);
    expect(parts).toMatchObject({ year: 1970, month: 1, day: 1, hour: 7 });
  });
});
