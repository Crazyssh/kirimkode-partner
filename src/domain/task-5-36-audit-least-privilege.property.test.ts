import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  AUDIT_ACTIONS,
  AUDIT_ACTOR_TYPES,
  RAW_SMS_PERMISSION,
  RAW_SMS_REAUTH_WINDOW_MS,
  authorizeRawSmsAccess,
  createAuditEvent,
  type AuditAction,
  type AuditActorType,
  type CreateAuditEventInput,
  type RawSmsAccessRequest,
} from "@domain/task-5-7";
import { REDACTED } from "@domain/task-5-3/redaction";

// Feature: partner-platform, Property 29: Audit event lengkap dan least privilege
//
// For all command sensitif yang selesai, audit event SELALU memiliki actor
// (type + ref), action, target (type + id), waktu, hasil, dan metadata aman;
// event bersifat beku (immutable) dan tidak pernah membocorkan secret/OTP/raw
// SMS yang diberikan sebagai nilai metadata sensitif (Req 19.1, 19.2, 19.6).
// Akses raw SMS bersifat least-privilege: HANYA diizinkan bila principal
// memiliki permission `sms:raw`, menyertakan reason non-kosong, DAN
// re-autentikasi berada dalam jendela yang dikonfigurasi (Req 19.3). Keputusan
// izin ekuivalen dengan oracle independen (termasuk urutan presedensi kode
// penolakan), dan setiap akses yang diizinkan selalu menghasilkan audit event
// lengkap dengan action `sms.raw_accessed` beserta reason yang diteruskan.
//
// **Validates: Requirements 19.1, 19.2, 19.3**
//
// Design references:
// - AuditEvent menyimpan actor, action, target, waktu, hasil, dan metadata aman;
//   append-only (Design §Data Models, Req 19.1/19.2).
// - Raw SMS hanya role admin dengan permission `sms:raw`, membutuhkan reason,
//   re-auth 15 menit, dan menghasilkan audit (Design §11, Req 19.3).
// - Password/token/API key/OTP/SMS mentah dikecualikan dari log & metadata
//   (Req 19.6, shared redaction task-5-3).
// - Pure domain test tidak memakai DB/network (Testing Strategy).
// - Property 29 bukan bagian dari set 500-run (parser/pricing/state machine/
//   ledger); memakai minimum numRuns per Testing Strategy.

const NUM_RUNS = 300;

// A large base epoch so that `now - age` stays a non-negative safe integer even
// for the most negative (future re-auth) age we generate below.
const BASE_NOW_MS = 4 * RAW_SMS_REAUTH_WINDOW_MS + 1_000;

// Non-empty identifier used for fields guarded by assertIdentifier.
const identifierArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 1_000_000 })
  .map((n) => `id-${n}`);

// A secret-like literal that must never survive redaction when supplied as a
// sensitive value. Long/hex enough to avoid incidental collisions.
const secretArb: fc.Arbitrary<string> = fc.uuid().map((s) => `sk_${s}`);

// -------------------------- Audit completeness ------------------------------

interface AuditScenario {
  readonly input: CreateAuditEventInput;
  readonly secret: string;
  readonly noteValue: string;
}

const auditScenarioArb: fc.Arbitrary<AuditScenario> = fc
  .record({
    actorType: fc.constantFrom<AuditActorType>(...AUDIT_ACTOR_TYPES),
    actorRef: identifierArb,
    action: fc.constantFrom<AuditAction>(...AUDIT_ACTIONS),
    targetType: identifierArb,
    targetId: identifierArb,
    result: fc.constantFrom<"success" | "failure">("success", "failure"),
    occurredAtEpochMs: fc.integer({ min: 0, max: 4_102_444_800_000 }),
    secret: secretArb,
    noteSeed: fc.integer({ min: 0, max: 1_000_000 }),
  })
  .map((r) => {
    const noteValue = `note-${r.noteSeed}`;
    return {
      secret: r.secret,
      noteValue,
      input: {
        actorType: r.actorType,
        actorRef: r.actorRef,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        result: r.result,
        occurredAtEpochMs: r.occurredAtEpochMs,
        metadata: {
          // Non-sensitive key survives redaction unchanged.
          label: noteValue,
          // Sensitive key is redacted purely by key name.
          otp: "123456",
          // Sensitive literal embedded in a free-text value must be scrubbed.
          note: `secret is ${r.secret}`,
        },
        sensitiveValues: [r.secret],
      } satisfies CreateAuditEventInput,
    };
  });

// ----------------------- Raw SMS least-privilege ----------------------------

interface RawSmsScenario {
  readonly request: RawSmsAccessRequest;
  readonly hasPermission: boolean;
  readonly reasonMeaningful: boolean;
  readonly windowMs: number;
}

const reasonArb: fc.Arbitrary<{ text: string; meaningful: boolean }> = fc.oneof(
  { weight: 4, arbitrary: identifierArb.map((t) => ({ text: `reason ${t}`, meaningful: true })) },
  { weight: 1, arbitrary: fc.constant({ text: "", meaningful: false }) },
  { weight: 1, arbitrary: fc.constant({ text: "   ", meaningful: false }) },
);

const rawSmsScenarioArb: fc.Arbitrary<RawSmsScenario> = fc
  .record({
    adminRef: identifierArb,
    targetSmsId: identifierArb,
    hasPermission: fc.boolean(),
    otherPerms: fc.array(identifierArb.map((p) => `perm:${p}`), { maxLength: 4 }),
    reason: reasonArb,
    // age = now - reauth; spans future (negative), fresh, and stale.
    ageMs: fc.integer({ min: -2 * RAW_SMS_REAUTH_WINDOW_MS, max: 4 * RAW_SMS_REAUTH_WINDOW_MS }),
    // Sometimes exercise a custom re-auth window instead of the default.
    customWindow: fc.option(fc.integer({ min: 1, max: RAW_SMS_REAUTH_WINDOW_MS }), { nil: undefined }),
  })
  .map((r) => {
    const permissions = r.hasPermission
      ? [...r.otherPerms, RAW_SMS_PERMISSION]
      : r.otherPerms.filter((p) => p !== RAW_SMS_PERMISSION);
    const now = BASE_NOW_MS;
    const reauthenticatedAtEpochMs = now - r.ageMs;
    return {
      hasPermission: r.hasPermission,
      reasonMeaningful: r.reason.meaningful,
      windowMs: r.customWindow ?? RAW_SMS_REAUTH_WINDOW_MS,
      request: {
        adminRef: r.adminRef,
        permissions,
        reason: r.reason.text,
        reauthenticatedAtEpochMs,
        nowEpochMs: now,
        targetSmsId: r.targetSmsId,
        reauthWindowMs: r.customWindow,
      } satisfies RawSmsAccessRequest,
    };
  });

// Independent oracle mirroring the least-privilege decision + precedence.
function expectedRawSmsDecision(
  s: RawSmsScenario,
): { allowed: true } | { allowed: false; code: string } {
  if (!s.hasPermission) return { allowed: false, code: "missing_permission" };
  if (!s.reasonMeaningful) return { allowed: false, code: "missing_reason" };
  const age = s.request.nowEpochMs - s.request.reauthenticatedAtEpochMs;
  if (age < 0 || age > s.windowMs) return { allowed: false, code: "reauth_required" };
  return { allowed: true };
}

describe("Property 29: Audit event lengkap dan least privilege", () => {
  it("produces complete, immutable, leak-free audit events and gates raw SMS by permission+reason+reauth", () => {
    fc.assert(
      fc.property(auditScenarioArb, rawSmsScenarioArb, (audit, rawSms) => {
        // --- Audit completeness (Req 19.1, 19.2) -------------------------------
        const event = createAuditEvent(audit.input);

        // Every required field is present and faithfully carried.
        expect(event.actorType).toBe(audit.input.actorType);
        expect(event.actorRef).toBe(audit.input.actorRef);
        expect(event.action).toBe(audit.input.action);
        expect(event.targetType).toBe(audit.input.targetType);
        expect(event.targetId).toBe(audit.input.targetId);
        expect(event.result).toBe(audit.input.result);
        expect(event.occurredAtEpochMs).toBe(audit.input.occurredAtEpochMs);
        expect(event.safeMetadata).toBeDefined();

        // The descriptor is immutable (append-only audit contract).
        expect(Object.isFrozen(event)).toBe(true);

        // Redaction: sensitive key blanked, non-sensitive key preserved.
        expect(event.safeMetadata.otp).toBe(REDACTED);
        expect(event.safeMetadata.label).toBe(audit.noteValue);

        // No supplied secret ever survives anywhere in the audit metadata (Req 19.6).
        expect(JSON.stringify(event.safeMetadata)).not.toContain(audit.secret);

        // --- Raw SMS least privilege (Req 19.3) --------------------------------
        const expected = expectedRawSmsDecision(rawSms);
        const decision = authorizeRawSmsAccess(rawSms.request);

        expect(decision.allowed).toBe(expected.allowed);

        if (decision.allowed) {
          // Access is only granted with permission + reason + fresh re-auth.
          expect(rawSms.hasPermission).toBe(true);
          expect(rawSms.reasonMeaningful).toBe(true);
          const age = rawSms.request.nowEpochMs - rawSms.request.reauthenticatedAtEpochMs;
          expect(age).toBeGreaterThanOrEqual(0);
          expect(age).toBeLessThanOrEqual(rawSms.windowMs);

          // A granted access always yields a complete audit event.
          expect(decision.audit.action).toBe("sms.raw_accessed");
          expect(decision.audit.actorType).toBe("partner_admin");
          expect(decision.audit.actorRef).toBe(rawSms.request.adminRef);
          expect(decision.audit.targetType).toBe("partner_sms");
          expect(decision.audit.targetId).toBe(rawSms.request.targetSmsId);
          expect(decision.audit.result).toBe("success");
          expect(decision.audit.occurredAtEpochMs).toBe(rawSms.request.nowEpochMs);
          expect(decision.audit.safeMetadata.reason).toBe(rawSms.request.reason.trim());
          expect(Object.isFrozen(decision.audit)).toBe(true);
        } else {
          // Denials expose a stable reason code and never fabricate an audit event.
          expect(decision).not.toHaveProperty("audit");
          // The oracle and the decision agree on `allowed` (asserted above), so
          // in this branch the oracle is also a denial; narrow it to read its
          // code, failing loudly if the two ever disagree.
          if (expected.allowed) {
            throw new Error("oracle allowed access but the decision denied it");
          }
          expect(decision.code).toBe(expected.code);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("denies raw SMS access without the sms:raw permission even with a fresh reason", () => {
    // Anchor: least-privilege dominates regardless of reason/re-auth freshness.
    const decision = authorizeRawSmsAccess({
      adminRef: "admin-1",
      permissions: ["sms:read", "config:write"],
      reason: "investigating delivery complaint",
      reauthenticatedAtEpochMs: 1_000_000,
      nowEpochMs: 1_000_000,
      targetSmsId: "sms-1",
    });
    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ code: "missing_permission" });
  });
});
