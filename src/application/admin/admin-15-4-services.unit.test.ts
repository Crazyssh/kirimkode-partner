/**
 * Unit tests for the task 15.4 admin capabilities: config publishing, order
 * recovery, step-up re-auth, the raw SMS gate, and the audit browser bounds.
 * Every dependency is an in-memory fake so the pure service logic is exercised
 * without a database or crypto.
 */
import { describe, expect, it } from "vitest";

import type { AuthenticatedAdmin } from "@domain/task-7-5";

import { AuthRateLimiter } from "@application/auth/auth-rate-limiter";
import { InMemoryRateLimitStore } from "@infrastructure/auth/in-memory-rate-limit-store";

import { ADMIN_REAUTH_RATE_LIMIT } from "./admin-config";
import { AdminConfigService } from "./admin-config-service";
import type {
  ActivePlatformConfigRow,
  AdminConfigGateway,
  EditablePlatformConfigFields,
  PublishConfigVersionInput,
} from "./config-ports";
import { AdminRecoveryService } from "./admin-recovery-service";
import type {
  OrderRecoveryExecutor,
  RecoveryAuditWriter,
  TerminalResult,
} from "./recovery-ports";
import { AdminReauthService, InMemoryReauthRegistry } from "./admin-reauth-service";
import { AdminRawSmsService } from "./admin-raw-sms-service";
import type {
  EncryptedRawSmsRecord,
  RawSmsReadGateway,
} from "./raw-sms-ports";
import { AdminAuditService } from "./admin-audit-service";
import type { AuditBrowserReadGateway, AuditEventPage, AuditEventQuery } from "./audit-browser-ports";
import type { AdminAuthRecord, AdminIdentityGateway } from "./ports";

const NOW = 1_700_000_000_000;
const clock = { nowEpochMs: () => NOW };
let seq = 0;
const idGenerator = { uuid: () => `id-${(seq += 1)}` };

function admin(permissions: readonly string[]): AuthenticatedAdmin {
  return { adminId: "11111111-1111-4111-8111-111111111111", permissions, securityVersion: 1 };
}

const VALID_EDIT: EditablePlatformConfigFields = {
  minBasePriceIdr: 500,
  maxBasePriceIdr: 5_000,
  fixedFeeIdr: 250,
  markupBps: 1_500,
  roundToIdr: 50,
  orderTimeoutSeconds: 1_200,
  cancelMinimumSeconds: 180,
  heartbeatIntervalSeconds: 30,
  heartbeatTimeoutSeconds: 90,
  earningHoldSeconds: 86_400,
  minimumPayoutIdr: 1_000,
  smsRawRetentionDays: 7,
  otpRetentionHours: 24,
  heartbeatMetadataRetentionDays: 30,
  securityEventRetentionDays: 90,
  auditRetentionDays: 2_557,
  financialRetentionDays: 2_557,
};

const ACTIVE_ROW: ActivePlatformConfigRow = {
  version: 1,
  serviceCode: "wa",
  countryCode: "ID",
  operatorCode: "any",
  currency: "IDR",
  heartbeatSweepSeconds: 30,
  reservationRecoverySeconds: 30,
  simulatorAllowlist: { partnerIds: [] },
  ...VALID_EDIT,
};

class FakeConfigGateway implements AdminConfigGateway {
  published: PublishConfigVersionInput | null = null;
  constructor(private readonly active: ActivePlatformConfigRow | null) {}
  async loadActive(): Promise<ActivePlatformConfigRow | null> {
    return this.active;
  }
  async publishNewVersion(input: PublishConfigVersionInput): Promise<{ version: number }> {
    this.published = input;
    return { version: (this.active?.version ?? 0) + 1 };
  }
}

describe("AdminConfigService", () => {
  it("rejects an admin without config:admin", async () => {
    const gateway = new FakeConfigGateway(ACTIVE_ROW);
    const service = new AdminConfigService({ gateway, clock, idGenerator });
    const outcome = await service.updateConfig({
      admin: admin([]),
      edited: VALID_EDIT,
      reason: "x",
      requestId: "req-1",
    });
    expect(outcome).toEqual({ ok: false, reason: "forbidden" });
    expect(gateway.published).toBeNull();
  });

  it("rejects a config that violates an invariant without publishing", async () => {
    const gateway = new FakeConfigGateway(ACTIVE_ROW);
    const service = new AdminConfigService({ gateway, clock, idGenerator });
    const outcome = await service.updateConfig({
      admin: admin(["config:admin"]),
      // cancel minimum >= order timeout violates the invariant.
      edited: { ...VALID_EDIT, cancelMinimumSeconds: 5_000 },
      reason: "bad",
      requestId: "req-2",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === "invalid_config") {
      expect(outcome.violations.length).toBeGreaterThan(0);
    } else {
      throw new Error("expected invalid_config");
    }
    expect(gateway.published).toBeNull();
  });

  it("publishes a new immutable version with an audit event", async () => {
    const gateway = new FakeConfigGateway(ACTIVE_ROW);
    const service = new AdminConfigService({ gateway, clock, idGenerator });
    const outcome = await service.updateConfig({
      admin: admin(["config:admin"]),
      edited: { ...VALID_EDIT, maxBasePriceIdr: 6_000 },
      reason: "raise guardrail",
      requestId: "req-3",
    });
    expect(outcome).toEqual({ ok: true, version: 2 });
    expect(gateway.published?.edited.maxBasePriceIdr).toBe(6_000);
    // Carried-forward fields come from the active row, not the edit.
    expect(gateway.published?.carried.serviceCode).toBe("wa");
    expect(gateway.published?.auditDescriptor.action).toBe("config.changed");
  });

  it("fails when no active config exists", async () => {
    const gateway = new FakeConfigGateway(null);
    const service = new AdminConfigService({ gateway, clock, idGenerator });
    const outcome = await service.updateConfig({
      admin: admin(["config:admin"]),
      edited: VALID_EDIT,
      reason: "x",
      requestId: "req-4",
    });
    expect(outcome).toEqual({ ok: false, reason: "no_active_config" });
  });
});

function terminalOk(): TerminalResult {
  return {
    statusCode: 200,
    body: {
      data: {
        partnerOrderId: "order-1",
        status: "failed",
        terminalReason: "admin recovery",
        releaseDisposition: "available",
      },
    },
  };
}

function terminalError(): TerminalResult {
  return {
    statusCode: 422,
    body: { error: { code: "TERMINAL_STATE_CONFLICT", message: "no", retryable: false } },
  };
}

class FakeExecutor implements OrderRecoveryExecutor {
  calls: string[] = [];
  constructor(private readonly result: TerminalResult) {}
  async cancel(): Promise<TerminalResult> {
    this.calls.push("cancel");
    return this.result;
  }
  async timeout(): Promise<TerminalResult> {
    this.calls.push("timeout");
    return this.result;
  }
  async fail(): Promise<TerminalResult> {
    this.calls.push("fail");
    return this.result;
  }
}

class FakeAuditWriter implements RecoveryAuditWriter {
  records: { partnerId: string | null; action: string; result: string }[] = [];
  async record(input: {
    partnerId: string | null;
    descriptor: { action: string; result: string };
  }): Promise<void> {
    this.records.push({
      partnerId: input.partnerId,
      action: input.descriptor.action,
      result: input.descriptor.result,
    });
  }
}

const ORDER_ID = "22222222-2222-4222-8222-222222222222";

describe("AdminRecoveryService", () => {
  it("rejects an admin without recovery:admin", async () => {
    const executor = new FakeExecutor(terminalOk());
    const audit = new FakeAuditWriter();
    const service = new AdminRecoveryService({ executor, audit, clock, idGenerator });
    const outcome = await service.recover({
      admin: admin([]),
      orderId: ORDER_ID,
      operation: "fail",
      reason: "x",
      requestId: "req-1",
    });
    expect(outcome).toEqual({ ok: false, reason: "forbidden" });
    expect(executor.calls).toEqual([]);
  });

  it("rejects an unknown operation", async () => {
    const executor = new FakeExecutor(terminalOk());
    const audit = new FakeAuditWriter();
    const service = new AdminRecoveryService({ executor, audit, clock, idGenerator });
    const outcome = await service.recover({
      admin: admin(["recovery:admin"]),
      orderId: ORDER_ID,
      operation: "nuke",
      reason: "x",
      requestId: "req-2",
    });
    expect(outcome).toEqual({ ok: false, reason: "validation", code: "INVALID_OPERATION" });
    expect(executor.calls).toEqual([]);
  });

  it("runs the CAS command and audits a success", async () => {
    const executor = new FakeExecutor(terminalOk());
    const audit = new FakeAuditWriter();
    const service = new AdminRecoveryService({ executor, audit, clock, idGenerator });
    const outcome = await service.recover({
      admin: admin(["recovery:admin"]),
      orderId: ORDER_ID,
      operation: "fail",
      reason: "stuck",
      requestId: "req-3",
    });
    expect(outcome).toEqual({ ok: true, status: "failed", terminalReason: "admin recovery" });
    expect(executor.calls).toEqual(["fail"]);
    expect(audit.records[0]).toMatchObject({ action: "order.manual_transition", result: "success" });
  });

  it("maps a rejected transition to command_failed and audits a failure", async () => {
    const executor = new FakeExecutor(terminalError());
    const audit = new FakeAuditWriter();
    const service = new AdminRecoveryService({ executor, audit, clock, idGenerator });
    const outcome = await service.recover({
      admin: admin(["recovery:admin"]),
      orderId: ORDER_ID,
      operation: "cancel",
      reason: "try",
      requestId: "req-4",
    });
    expect(outcome).toEqual({
      ok: false,
      reason: "command_failed",
      code: "TERMINAL_STATE_CONFLICT",
      retryable: false,
    });
    expect(audit.records[0]).toMatchObject({ result: "failure" });
  });
});

class FakeIdentity implements AdminIdentityGateway {
  constructor(private readonly record: AdminAuthRecord | null) {}
  async findAdminByEmail(): Promise<AdminAuthRecord | null> {
    return this.record;
  }
  async findAdminById(): Promise<AdminAuthRecord | null> {
    return this.record;
  }
}

const HASHER = {
  decoyHash: "decoy",
  async verify(hash: string, password: string): Promise<boolean> {
    return hash === `hash:${password}`;
  },
};

const ADMIN_RECORD: AdminAuthRecord = {
  adminId: admin([]).adminId,
  passwordHash: "hash:secret",
  permissions: ["sms:raw"],
  securityVersion: 1,
  status: "active",
};

describe("AdminReauthService", () => {
  const REAUTH_LIMIT = ADMIN_REAUTH_RATE_LIMIT.limit;

  /** A service wired to a real fixed-window limiter over a mutable clock. */
  function makeReauthService() {
    let now = NOW;
    const mutableClock = {
      nowEpochMs: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    };
    const registry = new InMemoryReauthRegistry();
    const rateLimiter = new AuthRateLimiter(
      new InMemoryRateLimitStore(() => mutableClock.nowEpochMs()),
      mutableClock,
    );
    const service = new AdminReauthService({
      identity: new FakeIdentity(ADMIN_RECORD),
      passwordHasher: HASHER,
      registry,
      rateLimiter,
      clock: mutableClock,
    });
    return { service, registry, clock: mutableClock };
  }

  it("records a re-auth on the correct password", async () => {
    const { service, registry } = makeReauthService();
    const outcome = await service.reauthenticate({ adminId: ADMIN_RECORD.adminId, password: "secret" });
    expect(outcome).toEqual({ ok: true, reauthenticatedAtEpochMs: NOW });
    expect(registry.getLastReauthEpochMs(ADMIN_RECORD.adminId)).toBe(NOW);
  });

  it("fails and records nothing on a wrong password", async () => {
    const { service, registry } = makeReauthService();
    const outcome = await service.reauthenticate({ adminId: ADMIN_RECORD.adminId, password: "wrong" });
    expect(outcome).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(registry.getLastReauthEpochMs(ADMIN_RECORD.adminId)).toBeNull();
  });

  it("locks out with rate_limited after too many failures, refusing even the correct password", async () => {
    const { service, registry } = makeReauthService();
    for (let attempt = 0; attempt < REAUTH_LIMIT; attempt += 1) {
      const failed = await service.reauthenticate({ adminId: ADMIN_RECORD.adminId, password: "wrong" });
      expect(failed).toEqual({ ok: false, reason: "invalid_credentials" });
    }
    // Within the cooldown the correct password is still refused — brute force is blunted.
    const blocked = await service.reauthenticate({ adminId: ADMIN_RECORD.adminId, password: "secret" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.reason).toBe("rate_limited");
      if (blocked.reason === "rate_limited") {
        expect(blocked.retryAfterMs).toBeGreaterThan(0);
      }
    }
    // No re-auth was recorded while locked out, so the raw-SMS gate stays closed.
    expect(registry.getLastReauthEpochMs(ADMIN_RECORD.adminId)).toBeNull();
  });

  it("clears the failure counter after a successful re-auth", async () => {
    const { service } = makeReauthService();
    for (let attempt = 0; attempt < REAUTH_LIMIT - 1; attempt += 1) {
      await service.reauthenticate({ adminId: ADMIN_RECORD.adminId, password: "wrong" });
    }
    // A success within the window clears the accumulated failures...
    const ok = await service.reauthenticate({ adminId: ADMIN_RECORD.adminId, password: "secret" });
    expect(ok.ok).toBe(true);
    // ...so a later wrong attempt is a plain failure, not an immediate lockout.
    const again = await service.reauthenticate({ adminId: ADMIN_RECORD.adminId, password: "wrong" });
    expect(again).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("permits a fresh attempt once the cooldown window has elapsed", async () => {
    const { service, clock: mutableClock } = makeReauthService();
    for (let attempt = 0; attempt < REAUTH_LIMIT; attempt += 1) {
      await service.reauthenticate({ adminId: ADMIN_RECORD.adminId, password: "wrong" });
    }
    const blocked = await service.reauthenticate({ adminId: ADMIN_RECORD.adminId, password: "secret" });
    expect(blocked.ok).toBe(false);
    // Advance past the 15-minute cooldown; the counter resets and the reveal reopens.
    mutableClock.advance(16 * 60 * 1000);
    const outcome = await service.reauthenticate({ adminId: ADMIN_RECORD.adminId, password: "secret" });
    expect(outcome).toEqual({ ok: true, reauthenticatedAtEpochMs: NOW + 16 * 60 * 1000 });
  });
});

const SMS_ID = "33333333-3333-4333-8333-333333333333";

class FakeRawSmsReads implements RawSmsReadGateway {
  constructor(private readonly record: EncryptedRawSmsRecord | null) {}
  async loadEncryptedSmsById(): Promise<EncryptedRawSmsRecord | null> {
    return this.record;
  }
}

const ENC_RECORD: EncryptedRawSmsRecord = {
  id: SMS_ID,
  partnerId: "p-1",
  canonicalNumber: "+6281234567890",
  matchStatus: "matched",
  matchedOrderId: "order-9",
  senderCiphertext: Uint8Array.from([1]),
  bodyCiphertext: Uint8Array.from([2]),
  keyVersion: 1,
  otpCiphertext: Uint8Array.from([3]),
  otpKeyVersion: 1,
  receivedAtServerEpochMs: NOW,
  redactedAtEpochMs: null,
};

const DECRYPTOR = {
  async decrypt(input: { ciphertext: Uint8Array }): Promise<string | null> {
    const first = input.ciphertext[0];
    if (first === 1) return "WhatsApp";
    if (first === 2) return "Kode Anda 123456";
    if (first === 3) return "123456";
    return null;
  },
};

function rawSmsService(record: EncryptedRawSmsRecord | null, reauthAt: number | null) {
  const registry = new InMemoryReauthRegistry();
  if (reauthAt !== null) registry.record(admin([]).adminId, reauthAt);
  const audits: string[] = [];
  const service = new AdminRawSmsService({
    reads: new FakeRawSmsReads(record),
    decryptor: DECRYPTOR,
    audit: {
      async record(input: { descriptor: { action: string } }): Promise<void> {
        audits.push(input.descriptor.action);
      },
    },
    registry,
    clock,
    idGenerator,
  });
  return { service, audits };
}

describe("AdminRawSmsService", () => {
  it("denies without the sms:raw permission", async () => {
    const { service, audits } = rawSmsService(ENC_RECORD, NOW);
    const outcome = await service.reveal({
      admin: admin([]),
      smsId: SMS_ID,
      reason: "investigate",
      requestId: "req-1",
    });
    expect(outcome).toEqual({ ok: false, reason: "missing_permission" });
    expect(audits).toEqual([]);
  });

  it("requires a re-auth within the window", async () => {
    const { service } = rawSmsService(ENC_RECORD, null);
    const outcome = await service.reveal({
      admin: admin(["sms:raw"]),
      smsId: SMS_ID,
      reason: "investigate",
      requestId: "req-2",
    });
    expect(outcome).toEqual({ ok: false, reason: "reauth_required" });
  });

  it("rejects an expired re-auth", async () => {
    const { service } = rawSmsService(ENC_RECORD, NOW - 16 * 60 * 1000);
    const outcome = await service.reveal({
      admin: admin(["sms:raw"]),
      smsId: SMS_ID,
      reason: "investigate",
      requestId: "req-3",
    });
    expect(outcome).toEqual({ ok: false, reason: "reauth_required" });
  });

  it("requires a reason", async () => {
    const { service } = rawSmsService(ENC_RECORD, NOW);
    const outcome = await service.reveal({
      admin: admin(["sms:raw"]),
      smsId: SMS_ID,
      reason: "   ",
      requestId: "req-4",
    });
    expect(outcome).toEqual({ ok: false, reason: "missing_reason" });
  });

  it("decrypts and audits a granted reveal", async () => {
    const { service, audits } = rawSmsService(ENC_RECORD, NOW);
    const outcome = await service.reveal({
      admin: admin(["sms:raw"]),
      smsId: SMS_ID,
      reason: "investigate OTP complaint",
      requestId: "req-5",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.revealed.body).toBe("Kode Anda 123456");
      expect(outcome.revealed.otp).toBe("123456");
      expect(outcome.revealed.sender).toBe("WhatsApp");
    }
    expect(audits).toEqual(["sms.raw_accessed"]);
  });

  it("refuses a retention-redacted record", async () => {
    const { service, audits } = rawSmsService({ ...ENC_RECORD, redactedAtEpochMs: NOW }, NOW);
    const outcome = await service.reveal({
      admin: admin(["sms:raw"]),
      smsId: SMS_ID,
      reason: "investigate",
      requestId: "req-6",
    });
    expect(outcome).toEqual({ ok: false, reason: "redacted" });
    expect(audits).toEqual([]);
  });
});

class FakeAuditBrowser implements AuditBrowserReadGateway {
  lastQuery: AuditEventQuery | null = null;
  async listAuditEvents(query: AuditEventQuery): Promise<AuditEventPage> {
    this.lastQuery = query;
    return { items: [], page: query.page, pageSize: query.pageSize, total: 0, hasNext: false };
  }
}

describe("AdminAuditService", () => {
  it("bounds paging and normalises an unknown action to undefined", async () => {
    const gateway = new FakeAuditBrowser();
    const service = new AdminAuditService({ gateway });
    await service.listAuditEvents({ page: 0, pageSize: 10_000, action: "not-real" });
    expect(gateway.lastQuery?.page).toBe(1);
    expect(gateway.lastQuery?.pageSize).toBe(100);
    expect(gateway.lastQuery?.action).toBeUndefined();
  });

  it("passes through a known action filter", async () => {
    const gateway = new FakeAuditBrowser();
    const service = new AdminAuditService({ gateway });
    await service.listAuditEvents({ action: "sms.raw_accessed" });
    expect(gateway.lastQuery?.action).toBe("sms.raw_accessed");
  });
});
