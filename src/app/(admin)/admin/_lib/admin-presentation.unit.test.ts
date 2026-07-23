/**
 * Component-style tests for the Partner Admin presentation layer (task 15.5).
 *
 * As with the portal, the admin pages are async server components with no DOM
 * renderer in this repo, so these tests exercise the pure decisions behind the
 * rendered admin area: the admin realm's separation from the tenant portal
 * (every nav target is under `/admin`), its own mutation feedback contract, and
 * the least-privilege raw-SMS access gate that drives the reveal screen. The
 * gate's server-side enforcement (permission + step-up re-auth + audit) is
 * covered by the AdminRawSmsService tests; here we additionally verify the
 * `reauthStatus` gate driver, its mapping to the UI state, and that a granted
 * reveal never places decrypted SMS/OTP into the audit trail (redaction).
 *
 * Accessibility: DOM-level a11y assertions (roles, labels) need a jsdom +
 * @testing-library/react harness that is intentionally not a dependency here,
 * so they are deferred to manual/E2E review.
 */
import { describe, expect, it } from "vitest";

import {
  AdminRawSmsService,
  InMemoryReauthRegistry,
  RAW_SMS_PERMISSION,
  type EncryptedRawSmsRecord,
  type RawSmsReadGateway,
} from "@application/admin";
import type { AuthenticatedAdmin } from "@domain/task-7-5";

import { adminFeedbackTarget, parseFeedback } from "./admin-feedback";
import { ADMIN_NAV_ITEMS, resolveRawSmsGate } from "./admin-presentation";
import { RAW_SMS_INITIAL_STATE } from "./raw-sms-state";

const NOW = 1_700_000_000_000;
const REAUTH_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const SMS_ID = "33333333-3333-4333-8333-333333333333";

function admin(permissions: readonly string[]): AuthenticatedAdmin {
  return { adminId: ADMIN_ID, permissions, securityVersion: 1 };
}

describe("ADMIN_NAV_ITEMS — admin realm separation from the tenant portal (req 16.1)", () => {
  it("keeps every admin nav target under /admin", () => {
    expect(ADMIN_NAV_ITEMS.length).toBeGreaterThan(0);
    for (const item of ADMIN_NAV_ITEMS) {
      expect(item.href === "/admin" || item.href.startsWith("/admin/")).toBe(true);
    }
  });

  it("never links back into portal routes", () => {
    const portalRoutes = ["/", "/devices", "/numbers", "/offers", "/orders", "/earnings", "/payouts"];
    const hrefs = ADMIN_NAV_ITEMS.map((item) => item.href);
    for (const portalRoute of portalRoutes) {
      expect(hrefs).not.toContain(portalRoute);
    }
  });
});

describe("admin feedback contract — separate from the portal (req 16.1, 15.6)", () => {
  it("builds an /admin-scoped feedback target that its own parser reads back", () => {
    const url = adminFeedbackTarget("/admin/config", "success", "Konfigurasi disimpan");
    expect(url.startsWith("/admin/config?")).toBe(true);
    const params = Object.fromEntries(new URLSearchParams(url.slice(url.indexOf("?") + 1)));
    expect(parseFeedback(params)).toEqual({ type: "success", message: "Konfigurasi disimpan" });
  });

  it("defaults an unknown type to error and ignores an empty message", () => {
    expect(parseFeedback({ feedback: "Ditolak", feedbackType: "nope" })).toEqual({
      type: "error",
      message: "Ditolak",
    });
    expect(parseFeedback({ feedback: "  " })).toBeNull();
  });
});

describe("raw SMS reveal transient state (task 15.4)", () => {
  it("starts idle so no decrypted content exists before an explicit reveal", () => {
    expect(RAW_SMS_INITIAL_STATE).toEqual({ status: "idle" });
  });
});

describe("resolveRawSmsGate — raw SMS gate UI state (req 16.7, 19.3)", () => {
  it("is no_permission when the admin lacks sms:raw", () => {
    expect(
      resolveRawSmsGate({ hasPermission: false, fresh: false, reauthenticatedAtEpochMs: null, expiresAtEpochMs: null }),
    ).toEqual({ mode: "no_permission" });
  });

  it("is needs_reauth when permitted but not freshly re-authenticated", () => {
    expect(
      resolveRawSmsGate({ hasPermission: true, fresh: false, reauthenticatedAtEpochMs: null, expiresAtEpochMs: null }),
    ).toEqual({ mode: "needs_reauth" });
  });

  it("is ready with the expiry when permitted and freshly re-authenticated", () => {
    expect(
      resolveRawSmsGate({
        hasPermission: true,
        fresh: true,
        reauthenticatedAtEpochMs: NOW,
        expiresAtEpochMs: NOW + REAUTH_WINDOW_MS,
      }),
    ).toEqual({ mode: "ready", expiresAtEpochMs: NOW + REAUTH_WINDOW_MS });
  });
});

// --- Raw-SMS gate driver + redaction via the real service --------------------

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

const SECRET_BODY = "Kode rahasia 999888";
const SECRET_OTP = "999888";

const DECRYPTOR = {
  async decrypt(input: { ciphertext: Uint8Array }): Promise<string | null> {
    const first = input.ciphertext[0];
    if (first === 1) return "WhatsApp";
    if (first === 2) return SECRET_BODY;
    if (first === 3) return SECRET_OTP;
    return null;
  },
};

class FakeReads implements RawSmsReadGateway {
  async loadEncryptedSmsById(): Promise<EncryptedRawSmsRecord | null> {
    return ENC_RECORD;
  }
}

function service(reauthAt: number | null) {
  const registry = new InMemoryReauthRegistry();
  if (reauthAt !== null) registry.record(ADMIN_ID, reauthAt);
  const auditInputs: unknown[] = [];
  const svc = new AdminRawSmsService({
    reads: new FakeReads(),
    decryptor: DECRYPTOR,
    audit: {
      async record(input: unknown): Promise<void> {
        auditInputs.push(input);
      },
    },
    registry,
    clock: { nowEpochMs: () => NOW },
    idGenerator: { uuid: () => "audit-id" },
  });
  return { svc, auditInputs };
}

describe("reauthStatus — the gate driver behind resolveRawSmsGate (req 16.7, 19.3)", () => {
  it("reports no permission and no freshness for an admin without sms:raw", () => {
    const { svc } = service(NOW);
    const status = svc.reauthStatus(admin([]));
    expect(status.hasPermission).toBe(false);
    expect(resolveRawSmsGate(status)).toEqual({ mode: "no_permission" });
  });

  it("reports not-fresh when there is no recorded re-auth", () => {
    const { svc } = service(null);
    const status = svc.reauthStatus(admin([RAW_SMS_PERMISSION]));
    expect(status).toMatchObject({ hasPermission: true, fresh: false });
    expect(resolveRawSmsGate(status)).toEqual({ mode: "needs_reauth" });
  });

  it("reports fresh within the 15-minute window and drives a ready gate", () => {
    const { svc } = service(NOW);
    const status = svc.reauthStatus(admin([RAW_SMS_PERMISSION]));
    expect(status.fresh).toBe(true);
    expect(status.expiresAtEpochMs).toBe(NOW + REAUTH_WINDOW_MS);
    expect(resolveRawSmsGate(status)).toEqual({
      mode: "ready",
      expiresAtEpochMs: NOW + REAUTH_WINDOW_MS,
    });
  });

  it("treats an expired re-auth as not fresh", () => {
    const { svc } = service(NOW - REAUTH_WINDOW_MS - 1);
    const status = svc.reauthStatus(admin([RAW_SMS_PERMISSION]));
    expect(status.fresh).toBe(false);
  });
});

describe("raw SMS reveal — redaction of decrypted content from the audit trail (req 19.3)", () => {
  it("denies a reveal without sms:raw and writes no audit", async () => {
    const { svc, auditInputs } = service(NOW);
    const outcome = await svc.reveal({
      admin: admin([]),
      smsId: SMS_ID,
      reason: "investigate",
      requestId: "req-1",
    });
    expect(outcome).toEqual({ ok: false, reason: "missing_permission" });
    expect(auditInputs).toHaveLength(0);
  });

  it("returns the decrypted content once but keeps it out of the audit event", async () => {
    const { svc, auditInputs } = service(NOW);
    const outcome = await svc.reveal({
      admin: admin([RAW_SMS_PERMISSION]),
      smsId: SMS_ID,
      reason: "investigate OTP complaint",
      requestId: "req-2",
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.revealed.body).toBe(SECRET_BODY);
      expect(outcome.revealed.otp).toBe(SECRET_OTP);
    }

    // Exactly one audit event, and it must not carry the decrypted SMS/OTP.
    expect(auditInputs).toHaveLength(1);
    const serialized = JSON.stringify(auditInputs[0]);
    expect(serialized).not.toContain(SECRET_BODY);
    expect(serialized).not.toContain(SECRET_OTP);
  });
});
