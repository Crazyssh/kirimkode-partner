/**
 * Component-style tests for the Partner portal presentation layer (task 15.5).
 *
 * The portal pages are async server components, so this repo has no DOM/react
 * renderer; instead these tests exercise the pure decisions that back the
 * rendered output — role/status action gating, empty-state guidance, the payout
 * request gate, the mutation feedback contract, IDR/Asia-Jakarta formatting, and
 * the tenant data boundary. Together they cover what a page would render for a
 * given session + data without needing to mount React.
 *
 * Accessibility: the interactive banners/badges/pills are presentational server
 * components with static roles (`role="status"`/`role="alert"`, `aria-current`,
 * `aria-label`). Asserting those rendered attributes requires a DOM renderer
 * (@testing-library/react + jsdom), which is intentionally not a dependency of
 * this project, so DOM-level a11y assertions are deferred to manual/E2E review.
 */
import { describe, expect, it } from "vitest";

import { formatIdr, formatJakartaTimestamp } from "@domain/task-5-7";
import {
  authorizeTenant,
  type TenantPrincipal,
} from "@domain/task-5-1/tenant-policy";
import type { DashboardView } from "@application/portal";

import { feedbackTarget } from "./action-feedback";
import { parseFeedback } from "./feedback";
import {
  approvalGuidance,
  buildDashboardNextSteps,
  canManage,
  mutationsEnabled,
  navItemsForRole,
  resolvePayoutAvailability,
} from "./portal-presentation";

function dashboardView(overrides: Partial<DashboardView> = {}): DashboardView {
  return {
    partner: { displayName: "Acme", status: "approved", statusReason: null },
    devices: { online: 0, total: 0 },
    numbersAvailable: 0,
    orders: { active: 0, total: 0, success: 0 },
    earnings: { pendingIdr: 0, availableIdr: 0 },
    payout: { lockedIdr: 0, paidIdr: 0, openCount: 0, paidCount: 0 },
    ...overrides,
  };
}

describe("navItemsForRole — action visibility per role (req 15.5)", () => {
  it("shows every section to an owner", () => {
    const hrefs = navItemsForRole("owner").map((item) => item.href);
    expect(hrefs).toEqual([
      "/",
      "/devices",
      "/numbers",
      "/offers",
      "/orders",
      "/earnings",
      "/payouts",
      "/members",
      "/api-keys",
    ]);
  });

  it("hides owner-only sensitive sections from a member", () => {
    const hrefs = navItemsForRole("member").map((item) => item.href);
    expect(hrefs).not.toContain("/payouts");
    expect(hrefs).not.toContain("/members");
    expect(hrefs).not.toContain("/api-keys");
    // Operational sections remain visible to members.
    expect(hrefs).toEqual(["/", "/devices", "/numbers", "/offers", "/orders", "/earnings"]);
  });
});

describe("canManage — sensitive-operation gating per role (req 15.5, 4.4)", () => {
  it("permits an owner to manage members, api keys, and payouts", () => {
    expect(canManage("owner", "manage_members")).toBe(true);
    expect(canManage("owner", "manage_api_keys")).toBe(true);
    expect(canManage("owner", "manage_payout_destination")).toBe(true);
    expect(canManage("owner", "request_payout")).toBe(true);
  });

  it("denies a member those operations but allows operational ones", () => {
    expect(canManage("member", "manage_members")).toBe(false);
    expect(canManage("member", "manage_api_keys")).toBe(false);
    expect(canManage("member", "request_payout")).toBe(false);
    expect(canManage("member", "view_operational")).toBe(true);
    expect(canManage("member", "manage_inventory")).toBe(true);
  });
});

describe("mutationsEnabled — action visibility per partner status (req 3.2, 15.5)", () => {
  it("enables mutations only for an approved partner", () => {
    expect(mutationsEnabled("approved")).toBe(true);
    expect(mutationsEnabled("pending")).toBe(false);
    expect(mutationsEnabled("suspended")).toBe(false);
    expect(mutationsEnabled("rejected")).toBe(false);
    expect(mutationsEnabled(null)).toBe(false);
  });
});

describe("approvalGuidance — status banner copy (req 15.1)", () => {
  it("returns an empty string for an approved partner (no banner)", () => {
    expect(approvalGuidance("approved", null)).toBe("");
    expect(approvalGuidance("approved", "ignored")).toBe("");
  });

  it("explains each non-approved status", () => {
    expect(approvalGuidance("pending", null)).toContain("menunggu persetujuan");
    expect(approvalGuidance("suspended", null)).toContain("ditangguhkan");
    expect(approvalGuidance("rejected", null)).toContain("ditolak");
  });

  it("appends the recorded reason when present", () => {
    expect(approvalGuidance("suspended", "abuse")).toContain("Alasan: abuse");
  });
});

describe("buildDashboardNextSteps — empty-state guidance (req 15.3)", () => {
  it("tells a not-yet-approved partner to wait for approval only", () => {
    const steps = buildDashboardNextSteps(
      dashboardView({ partner: { displayName: "Acme", status: "pending", statusReason: null } }),
    );
    expect(steps).toEqual(["Tunggu persetujuan admin agar inventory dapat ditawarkan."]);
  });

  it("guides an approved partner with no devices/numbers/orders through setup", () => {
    const steps = buildDashboardNextSteps(dashboardView());
    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain("perangkat simulator");
    expect(steps[1]).toContain("nomor Indonesia");
    expect(steps[2]).toContain("offer aktif");
  });

  it("shows no next steps once the partner is fully set up", () => {
    const steps = buildDashboardNextSteps(
      dashboardView({
        devices: { online: 1, total: 1 },
        numbersAvailable: 1,
        orders: { active: 0, total: 3, success: 2 },
      }),
    );
    expect(steps).toEqual([]);
  });
});

describe("resolvePayoutAvailability — payout request gate (req 14.1, 15.6)", () => {
  const base = {
    activeDestinationCount: 1,
    availableEarningCount: 1,
    availableIdr: 1000,
    minimumPayoutIdr: 1000,
  };

  it("allows a request when a destination, earnings, and the minimum are met", () => {
    expect(resolvePayoutAvailability(base)).toEqual({ canRequest: true });
  });

  it("blocks with no_active_destination first", () => {
    expect(
      resolvePayoutAvailability({ ...base, activeDestinationCount: 0, availableEarningCount: 0 }),
    ).toEqual({ canRequest: false, reason: "no_active_destination" });
  });

  it("blocks on no available earnings", () => {
    expect(resolvePayoutAvailability({ ...base, availableEarningCount: 0 })).toEqual({
      canRequest: false,
      reason: "no_available_earnings",
    });
  });

  it("blocks when the available balance is below the minimum", () => {
    expect(resolvePayoutAvailability({ ...base, availableIdr: 999 })).toEqual({
      canRequest: false,
      reason: "below_minimum",
    });
  });
});

describe("feedback contract — success/error mutation feedback (req 15.6)", () => {
  it("parses a success feedback message from search params", () => {
    expect(parseFeedback({ feedback: "Perangkat dibuat", feedbackType: "success" })).toEqual({
      type: "success",
      message: "Perangkat dibuat",
    });
  });

  it("defaults an unknown or missing type to error (never a false success)", () => {
    expect(parseFeedback({ feedback: "Gagal", feedbackType: "weird" })).toEqual({
      type: "error",
      message: "Gagal",
    });
    expect(parseFeedback({ feedback: "Gagal" })).toEqual({ type: "error", message: "Gagal" });
  });

  it("returns null when there is no (non-empty) message", () => {
    expect(parseFeedback(undefined)).toBeNull();
    expect(parseFeedback({})).toBeNull();
    expect(parseFeedback({ feedback: "   " })).toBeNull();
  });

  it("round-trips through feedbackTarget: what a mutation writes, the page reads", () => {
    const url = feedbackTarget("/devices", "success", "Kredensial dirotasi");
    const query = url.slice(url.indexOf("?") + 1);
    const params = Object.fromEntries(new URLSearchParams(query));
    expect(url.startsWith("/devices?")).toBe(true);
    expect(parseFeedback(params)).toEqual({ type: "success", message: "Kredensial dirotasi" });
  });
});

describe("IDR + Asia/Jakarta formatting used by the portal (req 15.4)", () => {
  it("formats IDR as whole Rupiah with thousands separators and no decimals", () => {
    expect(formatIdr(0)).toBe("Rp0");
    expect(formatIdr(1000)).toBe("Rp1.000");
    expect(formatIdr(1400)).toBe("Rp1.400");
    expect(formatIdr(1_234_567)).toBe("Rp1.234.567");
    expect(formatIdr(-1400)).toBe("-Rp1.400");
  });

  it("renders a UTC instant as an Asia/Jakarta (WIB, UTC+7) timestamp", () => {
    // 2024-01-01T00:00:00Z -> 07:00:00 WIB on the same day.
    const utcMidnight = Date.UTC(2024, 0, 1, 0, 0, 0);
    expect(formatJakartaTimestamp(utcMidnight)).toBe("2024-01-01 07:00:00 WIB");
  });

  it("does not mutate a Date source when formatting", () => {
    const source = new Date(Date.UTC(2024, 0, 1, 20, 30, 0));
    const before = source.getTime();
    formatJakartaTimestamp(source);
    expect(source.getTime()).toBe(before);
  });
});

describe("tenant data boundary — a member sees only their partner (req 4.2, 4.3, 15.5)", () => {
  const member: TenantPrincipal = {
    memberId: "m-1",
    partnerId: "11111111-1111-4111-8111-111111111111",
    role: "member",
  };

  it("treats a cross-tenant resource as not found, never leaking its existence", () => {
    const otherPartnersResource = { partnerId: "22222222-2222-4222-8222-222222222222" };
    expect(authorizeTenant(member, otherPartnersResource, "view_operational")).toEqual({
      allowed: false,
      code: "RESOURCE_NOT_FOUND",
    });
    // A missing row is indistinguishable from a cross-tenant one.
    expect(authorizeTenant(member, null, "view_operational")).toEqual({
      allowed: false,
      code: "RESOURCE_NOT_FOUND",
    });
  });

  it("allows the member's own tenant for a permitted operation", () => {
    expect(
      authorizeTenant(member, { partnerId: member.partnerId }, "view_operational"),
    ).toEqual({ allowed: true, tenant: member });
  });

  it("returns FORBIDDEN (not NOT_FOUND) for an in-tenant but unauthorized operation", () => {
    expect(
      authorizeTenant(member, { partnerId: member.partnerId }, "request_payout"),
    ).toEqual({ allowed: false, code: "FORBIDDEN" });
  });
});
