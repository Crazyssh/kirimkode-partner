import { describe, expect, it } from "vitest";

import type { AuthenticatedPrincipal } from "@domain/task-7-2";

import type { ResolveSessionOutcome } from "../auth/resolve-session-service";
import { SessionAuthorizationService, type SessionResolver } from "./session-authorization-service";

const PARTNER = "00000000-0000-4000-8000-00000000000a";
const OWNER_ID = "00000000-0000-4000-8000-0000000000a1";

function principal(role: "owner" | "member"): AuthenticatedPrincipal {
  return { memberId: OWNER_ID, partnerId: PARTNER, role, securityVersion: 1 };
}

class FakeResolver implements SessionResolver {
  constructor(private readonly outcome: ResolveSessionOutcome) {}
  async resolve(token: string | null | undefined): Promise<ResolveSessionOutcome> {
    if (!token) return { authenticated: false };
    return this.outcome;
  }
}

describe("SessionAuthorizationService", () => {
  // Requirement 4.2: tenant scope is derived from the session, not the client.
  it("derives a validated tenant context from the resolved principal", async () => {
    const service = new SessionAuthorizationService({
      sessionResolver: new FakeResolver({ authenticated: true, principal: principal("owner") }),
    });

    const result = await service.authorize("token");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.tenant.partnerId).toBe(PARTNER);
    expect(result.context.principal.role).toBe("owner");
  });

  it("returns a generic unauthenticated result for a missing/invalid session", async () => {
    const service = new SessionAuthorizationService({
      sessionResolver: new FakeResolver({ authenticated: false }),
    });

    expect(await service.authorize(undefined)).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
    expect(await service.authorize("token")).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
  });

  // Requirement 4.4: sensitive operations gated to authorized roles.
  it("authorizes a sensitive operation only for the owner role", async () => {
    const ownerService = new SessionAuthorizationService({
      sessionResolver: new FakeResolver({ authenticated: true, principal: principal("owner") }),
    });
    const memberService = new SessionAuthorizationService({
      sessionResolver: new FakeResolver({ authenticated: true, principal: principal("member") }),
    });

    const owner = await ownerService.authorizeOperation("token", "manage_members");
    expect(owner.ok).toBe(true);

    const member = await memberService.authorizeOperation("token", "manage_members");
    expect(member).toEqual({ ok: false, reason: "forbidden" });
  });

  it("rejects an unauthenticated session before evaluating the permission", async () => {
    const service = new SessionAuthorizationService({
      sessionResolver: new FakeResolver({ authenticated: false }),
    });

    const result = await service.authorizeOperation("token", "manage_members");
    expect(result).toEqual({ ok: false, reason: "unauthenticated" });
  });
});
