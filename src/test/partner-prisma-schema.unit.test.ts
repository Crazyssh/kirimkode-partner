import { readFile } from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

const schemaPath = path.resolve(process.cwd(), "prisma", "schema.prisma");
let schema = "";

function block(kind: "model" | "enum", name: string): string {
  const match = schema.match(new RegExp(`${kind} ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) {
    throw new Error(`${kind} ${name} is missing from the Partner Prisma schema`);
  }
  return match[1];
}

beforeAll(async () => {
  schema = await readFile(schemaPath, "utf8");
});

// **Validates: Requirements 2.1, 3.1, 4.1, 5.1, 19.1, 19.2**
describe("Partner-owned Prisma schema", () => {
  it("defines every Task 3.1 model with UUID primary keys", () => {
    const models = [
      "Partner",
      "PartnerMember",
      "PartnerSession",
      "OneTimeToken",
      "PartnerAdmin",
      "DeviceCredential",
      "ServiceCredential",
      "AuditEvent",
      "SecurityEvent",
      "PlatformConfig",
    ];

    for (const model of models) {
      expect(block("model", model)).toMatch(
        /\bid\s+String\s+@id\s+@default\(uuid\(\)\)\s+@db\.Uuid/,
      );
    }
  });

  it("has exactly one definition for every model and enum", () => {
    const declarations = [...schema.matchAll(/^(model|enum)\s+(\w+)\s+\{/gm)].map(
      ([, kind, name]) => `${kind}:${name}`,
    );

    expect(declarations.length).toBeGreaterThan(0);
    expect(new Set(declarations).size).toBe(declarations.length);
  });

  it("uses the required Partner states and separate human roles", () => {
    expect(block("enum", "PartnerStatus")).toMatch(/PENDING[\s\S]*APPROVED[\s\S]*SUSPENDED[\s\S]*REJECTED/);
    expect(block("enum", "PartnerMemberRole")).toMatch(/OWNER[\s\S]*MEMBER/);
    expect(block("model", "PartnerMember")).toMatch(/role\s+PartnerMemberRole/);
    expect(block("model", "PartnerAdmin")).toMatch(/status\s+PartnerAdminStatus/);
  });

  it("stores every DateTime as timezone-aware UTC-compatible PostgreSQL data", () => {
    const dateTimeFields = schema
      .split(/\r?\n/)
      .filter((line) => /^\s+\w+\s+DateTime\??\s/.test(line));

    expect(dateTimeFields.length).toBeGreaterThan(0);
    for (const field of dateTimeFields) {
      expect(field).toMatch(/@db\.Timestamptz\(\d+\)/);
    }
  });
  // **Validates: Requirements 2.1, 2.2, 2.3**
  it("enforces globally unique normalized member email and hash-only auth data", () => {
    const member = block("model", "PartnerMember");
    const session = block("model", "PartnerSession");
    const token = block("model", "OneTimeToken");

    expect(member).toMatch(/emailNormalized\s+String\s+@unique/);
    expect(member).toMatch(/passwordHash\s+String/);
    expect(session).toMatch(/tokenHash\s+String\s+@unique/);
    expect(token).toMatch(/tokenHash\s+String\s+@unique/);

    const forbiddenRawCredentialField = /^\s*(password|token|secret|apiKey|encryptedSecret)\s+/m;
    expect(member).not.toMatch(forbiddenRawCredentialField);
    expect(session).not.toMatch(forbiddenRawCredentialField);
    expect(token).not.toMatch(forbiddenRawCredentialField);
    expect(block("model", "PartnerAdmin")).not.toMatch(forbiddenRawCredentialField);
    expect(block("model", "DeviceCredential")).not.toMatch(forbiddenRawCredentialField);
    expect(block("model", "ServiceCredential")).not.toMatch(forbiddenRawCredentialField);

    const scalarFields = schema
      .split(/\r?\n/)
      .map((line) => line.match(/^\s+(\w+)\s+(?:String|Bytes|Json)\??(?:\s|$)/)?.[1])
      .filter((field): field is string => field !== undefined);
    const credentialLikeFields = scalarFields.filter((field) =>
      /(password|token|secret|apiKey|credential|privateKey|accessKey|sessionKey)/i.test(field),
    );

    expect(credentialLikeFields.length).toBeGreaterThan(0);
    for (const field of credentialLikeFields) {
      expect(field).toMatch(/Hash$/);
    }
  });

  // **Validates: Requirements 2.1, 4.1, 5.1**
  it("binds tenant-owned identities, sessions, tokens, and device credentials explicitly", () => {
    expect(block("model", "PartnerMember")).toMatch(
      /partner\s+Partner\s+@relation\(fields: \[partnerId\], references: \[id\]/,
    );
    expect(block("model", "PartnerSession")).toMatch(
      /member\s+PartnerMember\s+@relation\(fields: \[memberId, partnerId\], references: \[id, partnerId\]/,
    );
    expect(block("model", "OneTimeToken")).toMatch(
      /member\s+PartnerMember\s+@relation\(fields: \[memberId, partnerId\], references: \[id, partnerId\]/,
    );
    expect(block("model", "DeviceCredential")).toMatch(
      /device\s+PartnerDevice\s+@relation\(fields: \[deviceId, partnerId\], references: \[id, partnerId\]/,
    );
  });

  // **Validates: Requirements 4.1**
  it("keeps Partner Admin in a globally unique realm separate from Partner sessions", () => {
    const admin = block("model", "PartnerAdmin");
    const session = block("model", "PartnerSession");

    expect(admin).toMatch(/emailNormalized\s+String\s+@unique/);
    expect(admin).not.toMatch(/partnerId|PartnerMember|PartnerSession/);
    expect(session).toMatch(/member\s+PartnerMember/);
    expect(session).not.toMatch(/PartnerAdmin/);
  });

  // **Validates: Requirements 5.1**
  it("makes device and service credentials uniquely addressable and revocable", () => {
    const device = block("model", "DeviceCredential");
    const service = block("model", "ServiceCredential");

    expect(device).toMatch(/publicId\s+String\s+@unique/);
    expect(device).toMatch(/secretHash\s+String\s+@unique/);
    expect(device).toMatch(/status\s+CredentialStatus/);
    expect(service).toMatch(/@@unique\(\[clientId, keyId\]\)/);
    expect(service).toMatch(/secretHash\s+String\s+@unique/);
    expect(service).toMatch(/status\s+CredentialStatus/);
  });
  // **Validates: Requirements 19.1, 19.2**
  it("captures complete safe audit and security event evidence with query indexes", () => {
    const audit = block("model", "AuditEvent");
    const security = block("model", "SecurityEvent");

    for (const field of [
      "actorType",
      "actorRefHash",
      "action",
      "targetType",
      "targetId",
      "result",
      "safeMetadataJson",
      "requestId",
      "createdAt",
    ]) {
      expect(audit).toMatch(new RegExp(`\\b${field}\\b`));
    }
    expect(audit).toMatch(/@@index\(\[partnerId, createdAt\]\)/);
    expect(audit).toMatch(/@@index\(\[targetType, targetId, createdAt\]\)/);

    for (const field of [
      "principalHash",
      "category",
      "result",
      "networkHash",
      "safeMetadataJson",
      "requestId",
      "createdAt",
    ]) {
      expect(security).toMatch(new RegExp(`\\b${field}\\b`));
    }
    expect(security).toMatch(/@@index\(\[category, result, createdAt\]\)/);
  });

  it("defines immutable-versioned platform configuration fields and active lookup indexes", () => {
    const config = block("model", "PlatformConfig");

    expect(config).toMatch(/version\s+Int\s+@unique/);
    expect(config).toMatch(/activeKey\s+String\?\s+@unique/);
    expect(config).toMatch(/activeFrom\s+DateTime/);
    expect(config).toMatch(/retiredAt\s+DateTime\?/);
    expect(config).toMatch(/createdByAdmin\s+PartnerAdmin\?/);
    expect(config).not.toMatch(/updatedAt/);
    expect(config).toMatch(/@@index\(\[activeFrom, retiredAt\]\)/);
  });
});