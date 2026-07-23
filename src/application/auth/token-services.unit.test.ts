import { beforeEach, describe, expect, it } from "vitest";

import { CryptoOneTimeTokenIssuer } from "@infrastructure/auth/crypto-one-time-token";
import { InMemoryRateLimitStore } from "@infrastructure/auth/in-memory-rate-limit-store";

import type { RegistrationTransactionPort } from "@domain/task-5-1/registration";
import type { OneTimeTokenType } from "@domain/task-5-1/one-time-token";
import type { PartnerMemberLoginStatus } from "@domain/task-7-2";

import { AuthRateLimiter } from "./auth-rate-limiter";
import { RequestEmailVerificationService } from "./request-email-verification-service";
import { RequestPasswordResetService } from "./request-password-reset-service";
import { ResetPasswordService } from "./reset-password-service";
import { VerifyEmailService } from "./verify-email-service";
import type {
  AuthIdentityGateway,
  EmailMessage,
  EmailSender,
  MemberAuthRecord,
  OneTimeTokenGateway,
  OneTimeTokenIssuance,
  StoredOneTimeToken,
} from "./ports";

const PORTAL = "https://partner.kirimkode.com";
const VALID_PASSWORD = "correcthorsestaple";

class FakeClock {
  constructor(public value = 1_700_000_000_000) {}
  nowEpochMs(): number {
    return this.value;
  }
  advance(ms: number): void {
    this.value += ms;
  }
}

class SequentialIds {
  private n = 0;
  uuid(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${this.n.toString(16).padStart(12, "0")}`;
  }
}

class FakePasswordHasher {
  readonly decoyHash = "decoy-hash";
  async hash(password: string): Promise<string> {
    return `hashed:${password}`;
  }
  async verify(encodedHash: string, password: string): Promise<boolean> {
    return encodedHash === `hashed:${password}`;
  }
}

interface StoredMember {
  memberId: string;
  partnerId: string;
  role: "owner" | "member";
  passwordHash: string;
  securityVersion: number;
  status: PartnerMemberLoginStatus;
  emailVerifiedAtEpochMs: number | null;
}

/** Shared in-memory store backing both the identity and token fakes. */
class FakeStore {
  readonly membersByEmail = new Map<string, StoredMember>();
  readonly tokensByHash = new Map<string, StoredOneTimeToken>();

  seedMember(email: string, overrides: Partial<StoredMember> = {}): StoredMember {
    const member: StoredMember = {
      memberId: overrides.memberId ?? "member-1",
      partnerId: overrides.partnerId ?? "partner-1",
      role: overrides.role ?? "owner",
      passwordHash: overrides.passwordHash ?? `hashed:${VALID_PASSWORD}`,
      securityVersion: overrides.securityVersion ?? 1,
      status: overrides.status ?? "pending_verification",
      emailVerifiedAtEpochMs: overrides.emailVerifiedAtEpochMs ?? null,
    };
    this.membersByEmail.set(email, member);
    return member;
  }

  memberById(memberId: string): StoredMember | undefined {
    return [...this.membersByEmail.values()].find((m) => m.memberId === memberId);
  }
}

class FakeIdentityGateway implements AuthIdentityGateway {
  constructor(private readonly store: FakeStore) {}

  async findMemberByEmail(emailNormalized: string): Promise<MemberAuthRecord | null> {
    const member = this.store.membersByEmail.get(emailNormalized);
    if (!member) return null;
    return {
      memberId: member.memberId,
      partnerId: member.partnerId,
      role: member.role,
      passwordHash: member.passwordHash,
      securityVersion: member.securityVersion,
      status: member.status,
    };
  }

  async execute<T>(
    work: (transaction: RegistrationTransactionPort) => Promise<T>,
  ): Promise<T> {
    // Not exercised by these tests.
    return work({
      async createPartner(input) {
        return input;
      },
      async createOwner(input) {
        return input;
      },
    });
  }
}

class FakeOneTimeTokenGateway implements OneTimeTokenGateway {
  constructor(private readonly store: FakeStore) {}

  async issue(issuance: OneTimeTokenIssuance, invalidatedAtEpochMs: number): Promise<void> {
    // Invalidate outstanding unused tokens of the same type for the member.
    for (const row of this.store.tokensByHash.values()) {
      if (
        row.memberId === issuance.memberId &&
        row.type === issuance.type &&
        row.usedAtEpochMs === null
      ) {
        this.store.tokensByHash.set(row.tokenHash, {
          ...row,
          usedAtEpochMs: invalidatedAtEpochMs,
        });
      }
    }
    this.store.tokensByHash.set(issuance.tokenHash, {
      id: issuance.id,
      memberId: issuance.memberId,
      partnerId: issuance.partnerId,
      type: issuance.type,
      tokenHash: issuance.tokenHash,
      issuedAtEpochMs: issuance.issuedAtEpochMs,
      expiresAtEpochMs: issuance.expiresAtEpochMs,
      usedAtEpochMs: null,
    });
  }

  async findByTokenHash(tokenHash: string): Promise<StoredOneTimeToken | null> {
    return this.store.tokensByHash.get(tokenHash) ?? null;
  }

  private markUsed(tokenId: string, usedAtEpochMs: number): boolean {
    const row = [...this.store.tokensByHash.values()].find((r) => r.id === tokenId);
    if (!row || row.usedAtEpochMs !== null) return false;
    this.store.tokensByHash.set(row.tokenHash, { ...row, usedAtEpochMs });
    return true;
  }

  async applyEmailVerification(
    tokenId: string,
    memberId: string,
    _partnerId: string,
    usedAtEpochMs: number,
  ): Promise<boolean> {
    if (!this.markUsed(tokenId, usedAtEpochMs)) return false;
    const member = this.store.memberById(memberId);
    if (member) {
      member.emailVerifiedAtEpochMs ??= usedAtEpochMs;
      if (member.status === "pending_verification") member.status = "active";
    }
    return true;
  }

  async applyPasswordReset(
    tokenId: string,
    memberId: string,
    _partnerId: string,
    usedAtEpochMs: number,
    newPasswordHash: string,
  ): Promise<boolean> {
    if (!this.markUsed(tokenId, usedAtEpochMs)) return false;
    const member = this.store.memberById(memberId);
    if (member) {
      member.passwordHash = newPasswordHash;
      member.securityVersion += 1;
    }
    return true;
  }
}

class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  shouldThrow = false;
  async send(message: EmailMessage): Promise<void> {
    if (this.shouldThrow) throw new Error("smtp down");
    this.sent.push(message);
  }
}

function tokenFromEmail(message: EmailMessage): string {
  const match = message.text.match(/token=([^\s]+)/u);
  if (!match) throw new Error("no token in email");
  return decodeURIComponent(match[1]);
}

function buildFixture() {
  const clock = new FakeClock();
  const ids = new SequentialIds();
  const store = new FakeStore();
  const identity = new FakeIdentityGateway(store);
  const tokens = new FakeOneTimeTokenGateway(store);
  const tokenIssuer = new CryptoOneTimeTokenIssuer();
  const passwordHasher = new FakePasswordHasher();
  const emailSender = new FakeEmailSender();
  const rateLimiter = new AuthRateLimiter(
    new InMemoryRateLimitStore(() => clock.nowEpochMs()),
    clock,
  );

  const requestVerification = new RequestEmailVerificationService({
    identity,
    tokens,
    tokenIssuer,
    emailSender,
    rateLimiter,
    clock,
    idGenerator: ids,
    portalOrigin: PORTAL,
  });
  const verifyEmail = new VerifyEmailService({ tokens, tokenIssuer, clock });
  const requestReset = new RequestPasswordResetService({
    identity,
    tokens,
    tokenIssuer,
    emailSender,
    rateLimiter,
    clock,
    idGenerator: ids,
    portalOrigin: PORTAL,
  });
  const resetPassword = new ResetPasswordService({
    tokens,
    tokenIssuer,
    passwordHasher,
    clock,
  });

  return {
    clock,
    store,
    emailSender,
    tokens,
    requestVerification,
    verifyEmail,
    requestReset,
    resetPassword,
  };
}

function typeOf(store: FakeStore, hash: string): OneTimeTokenType | undefined {
  return store.tokensByHash.get(hash)?.type;
}

// **Validates: Requirements 2.6, 2.7, 19.6**
describe("RequestEmailVerificationService", () => {
  let fx: ReturnType<typeof buildFixture>;
  beforeEach(() => {
    fx = buildFixture();
    fx.store.seedMember("owner@example.com", { status: "pending_verification" });
  });

  it("issues a token and sends an email for a pending member", async () => {
    const result = await fx.requestVerification.request({
      email: "Owner@Example.com",
      ip: "203.0.113.5",
    });
    expect(result).toEqual({ ok: true });
    expect(fx.emailSender.sent).toHaveLength(1);
    expect(fx.emailSender.sent[0]?.to).toBe("owner@example.com");
    const token = tokenFromEmail(fx.emailSender.sent[0]);
    // Only the SHA-256 hash is stored, never the raw token.
    expect(fx.store.tokensByHash.has(token)).toBe(false);
    expect([...fx.store.tokensByHash.keys()][0]).toMatch(/^[a-f\d]{64}$/u);
  });

  it("returns the identical generic response for an unknown email without sending", async () => {
    const result = await fx.requestVerification.request({
      email: "nobody@example.com",
      ip: "203.0.113.5",
    });
    expect(result).toEqual({ ok: true });
    expect(fx.emailSender.sent).toHaveLength(0);
  });

  it("stays generic even when SMTP delivery fails", async () => {
    fx.emailSender.shouldThrow = true;
    const result = await fx.requestVerification.request({
      email: "owner@example.com",
      ip: "203.0.113.5",
    });
    expect(result).toEqual({ ok: true });
  });

  it("rate-limits the 6th request per email within the hour", async () => {
    for (let i = 0; i < 5; i += 1) {
      await fx.requestVerification.request({ email: "owner@example.com", ip: "203.0.113.5" });
    }
    const sixth = await fx.requestVerification.request({
      email: "owner@example.com",
      ip: "203.0.113.5",
    });
    expect(sixth).toMatchObject({ ok: false, reason: "rate_limited" });
  });
});

// **Validates: Requirements 2.6, 19.6**
describe("VerifyEmailService", () => {
  let fx: ReturnType<typeof buildFixture>;
  beforeEach(() => {
    fx = buildFixture();
    fx.store.seedMember("owner@example.com", { status: "pending_verification" });
  });

  async function issueAndGetToken(): Promise<string> {
    await fx.requestVerification.request({ email: "owner@example.com", ip: "203.0.113.5" });
    return tokenFromEmail(fx.emailSender.sent.at(-1) as EmailMessage);
  }

  it("verifies a valid token exactly once (single-use)", async () => {
    const token = await issueAndGetToken();
    expect(await fx.verifyEmail.verify(token)).toEqual({ ok: true });
    expect(fx.store.membersByEmail.get("owner@example.com")?.status).toBe("active");
    // Replaying the same token fails.
    expect(await fx.verifyEmail.verify(token)).toEqual({
      ok: false,
      reason: "invalid_or_expired",
    });
  });

  it("rejects an unknown or empty token", async () => {
    expect(await fx.verifyEmail.verify(undefined)).toEqual({
      ok: false,
      reason: "invalid_or_expired",
    });
    expect(await fx.verifyEmail.verify("not-a-real-token")).toEqual({
      ok: false,
      reason: "invalid_or_expired",
    });
  });

  it("rejects a token after its 24h TTL elapses", async () => {
    const token = await issueAndGetToken();
    fx.clock.advance(24 * 60 * 60 * 1_000 + 1);
    expect(await fx.verifyEmail.verify(token)).toEqual({
      ok: false,
      reason: "invalid_or_expired",
    });
  });

  it("invalidates the prior token when a new one is issued", async () => {
    const first = await issueAndGetToken();
    const second = await issueAndGetToken();
    expect(first).not.toBe(second);
    expect(await fx.verifyEmail.verify(first)).toEqual({
      ok: false,
      reason: "invalid_or_expired",
    });
    expect(await fx.verifyEmail.verify(second)).toEqual({ ok: true });
  });
});

// **Validates: Requirements 2.6, 2.7, 19.6**
describe("Password reset flow", () => {
  let fx: ReturnType<typeof buildFixture>;
  beforeEach(() => {
    fx = buildFixture();
    fx.store.seedMember("owner@example.com", { status: "active", securityVersion: 3 });
  });

  async function issueResetToken(): Promise<string> {
    await fx.requestReset.request({ email: "owner@example.com", ip: "203.0.113.5" });
    return tokenFromEmail(fx.emailSender.sent.at(-1) as EmailMessage);
  }

  it("issues a reset token of the reset type and stays generic for unknown emails", async () => {
    const token = await issueResetToken();
    const hash = [...fx.store.tokensByHash.keys()][0];
    expect(typeOf(fx.store, hash)).toBe("password_reset");

    fx.emailSender.sent.length = 0;
    const unknown = await fx.requestReset.request({ email: "ghost@example.com", ip: "203.0.113.5" });
    expect(unknown).toEqual({ ok: true });
    expect(fx.emailSender.sent).toHaveLength(0);
    expect(token).toMatch(/.+/u);
  });

  it("resets the password once and bumps the security version to revoke sessions", async () => {
    const token = await issueResetToken();
    const before = fx.store.membersByEmail.get("owner@example.com")?.securityVersion ?? 0;

    const result = await fx.resetPassword.reset({ token, newPassword: "brandnewpassword" });
    expect(result).toEqual({ ok: true });
    const member = fx.store.membersByEmail.get("owner@example.com");
    expect(member?.passwordHash).toBe("hashed:brandnewpassword");
    expect(member?.securityVersion).toBe(before + 1);

    // Single-use: replaying the consumed token fails.
    expect(await fx.resetPassword.reset({ token, newPassword: "anotherpassword1" })).toEqual({
      ok: false,
      reason: "invalid_or_expired",
    });
  });

  it("rejects a weak new password before consuming the token", async () => {
    const token = await issueResetToken();
    const result = await fx.resetPassword.reset({ token, newPassword: "short" });
    expect(result).toEqual({ ok: false, reason: "weak_password", code: "PASSWORD_TOO_SHORT" });
    // Token remains unused and still valid.
    expect(await fx.resetPassword.reset({ token, newPassword: "brandnewpassword" })).toEqual({
      ok: true,
    });
  });

  it("rejects a reset token after its 60m TTL elapses", async () => {
    const token = await issueResetToken();
    fx.clock.advance(60 * 60 * 1_000 + 1);
    expect(await fx.resetPassword.reset({ token, newPassword: "brandnewpassword" })).toEqual({
      ok: false,
      reason: "invalid_or_expired",
    });
  });

  it("rejects an email-verification token presented to the reset endpoint", async () => {
    // Cross-type: an email-verification token must not reset a password.
    fx.store.seedMember("pending@example.com", { memberId: "member-2", status: "pending_verification" });
    await fx.requestVerification.request({ email: "pending@example.com", ip: "203.0.113.9" });
    const verifyToken = tokenFromEmail(fx.emailSender.sent.at(-1) as EmailMessage);
    expect(await fx.resetPassword.reset({ token: verifyToken, newPassword: "brandnewpassword" })).toEqual({
      ok: false,
      reason: "invalid_or_expired",
    });
  });
});
