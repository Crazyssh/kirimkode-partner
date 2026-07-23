import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { bootstrapPartnerApplication } from "@application/bootstrap/bootstrap-partner-application";
import { initializePartnerProcess } from "@application/bootstrap/partner-process-entry";
import { register } from "@/instrumentation";

import {
  PartnerConfigurationError,
  parsePartnerRuntimeConfig,
  type RuntimeEnvironment,
} from "./partner-runtime-config";

function secret(): string {
  return randomBytes(32).toString("base64url");
}

function validEnvironment(): RuntimeEnvironment {
  return {
    PARTNER_RUNTIME_ID: "kirimkode-partner",
    PARTNER_ENVIRONMENT: "production",
    PARTNER_DATABASE_URL: `postgresql://kirimkode_partner_app:${secret()}@127.0.0.1:5432/kirimkode_partner`,
    PARTNER_SESSION_SECRET: secret(),
    PARTNER_INTERNAL_API_HMAC_CLIENT_ID: "kirimkode-main",
    PARTNER_INTERNAL_API_HMAC_CURRENT_KEY_ID: "partner-main-2026-01",
    PARTNER_INTERNAL_API_HMAC_CURRENT_SECRET: secret(),
    PARTNER_DEVICE_CREDENTIAL_PEPPER: secret(),
    PARTNER_SMS_OTP_ENCRYPTION_KEY_VERSION: "1",
    PARTNER_SMS_OTP_ENCRYPTION_KEY: secret(),
    PARTNER_CRON_SECRET: secret(),
    PARTNER_SMTP_HOST: "smtp.kirimkode.com",
    PARTNER_SMTP_PORT: "465",
    PARTNER_SMTP_SECURE: "true",
    PARTNER_SMTP_USERNAME: "partner-mailer",
    PARTNER_SMTP_PASSWORD: secret(),
    PARTNER_SMTP_FROM: "KirimKode Partner <partner@kirimkode.com>",
    PARTNER_PORTAL_ORIGIN: "https://partner.kirimkode.com",
    PARTNER_API_ORIGIN: "https://partner-api.kirimkode.com",
    PARTNER_TRUSTED_PROXIES: "127.0.0.1,10.20.0.0/24,::1",
    PARTNER_PORT: "3001",
    PARTNER_TIMEZONE: "Asia/Jakarta",
  };
}
// **Validates: Requirements 1.2, 18.1, 19.6, 20.1, 22.1**
describe("Partner runtime configuration", () => {
  it("accepts the complete isolated Partner configuration", () => {
    const result = parsePartnerRuntimeConfig(validEnvironment());

    expect(result).toMatchObject({
      runtimeId: "kirimkode-partner",
      environment: "production",
      databaseName: "kirimkode_partner",
      portalOrigin: "https://partner.kirimkode.com",
      apiOrigin: "https://partner-api.kirimkode.com",
      port: 3001,
      timezone: "Asia/Jakarta",
    });
    expect(new URL(result.databaseUrl).pathname).toBe("/kirimkode_partner");
    expect(result.session).toEqual({
      cookieName: "__Host-partner_session",
      idleTtlSeconds: 43_200,
      absoluteTtlSeconds: 604_800,
    });
    expect(result.smtp).toMatchObject({ port: 465, secure: true });
    expect(result.trustedProxies).toEqual(["127.0.0.1", "10.20.0.0/24", "::1"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.internalApiHmac)).toBe(true);
    expect(Object.isFrozen(result.smtp)).toBe(true);
  });

  it("aggregates missing and malformed Partner-owned variables", () => {
    const invalidEnvironment: RuntimeEnvironment = {
      ...validEnvironment(),
      PARTNER_RUNTIME_ID: "main-runtime",
      PARTNER_ENVIRONMENT: "staging",
      PARTNER_DATABASE_URL: "not-a-database-url",
      PARTNER_SMTP_PORT: "0",
      PARTNER_SMTP_SECURE: "yes",
      PARTNER_PORTAL_ORIGIN: "https://kirimkode.com",
      PARTNER_API_ORIGIN: "http://partner-api.kirimkode.com",
      PARTNER_TRUSTED_PROXIES: "0.0.0.0/0,127.0.0.1,127.0.0.1",
      PARTNER_PORT: "3000",
      PARTNER_TIMEZONE: "UTC",
    };

    let error: PartnerConfigurationError | undefined;
    try {
      parsePartnerRuntimeConfig(invalidEnvironment);
    } catch (caught) {
      error = caught as PartnerConfigurationError;
    }

    expect(error).toBeInstanceOf(PartnerConfigurationError);
    expect(error?.issues.map(({ variable }) => variable)).toEqual(
      expect.arrayContaining([
        "PARTNER_RUNTIME_ID",
        "PARTNER_ENVIRONMENT",
        "PARTNER_DATABASE_URL",
        "PARTNER_SMTP_PORT",
        "PARTNER_SMTP_SECURE",
        "PARTNER_PORTAL_ORIGIN",
        "PARTNER_API_ORIGIN",
        "PARTNER_TRUSTED_PROXIES",
        "PARTNER_PORT",
        "PARTNER_TIMEZONE",
      ]),
    );
  });
  it("rejects reuse of service, session, and Device secrets", () => {
    const sharedSecret = secret();
    const environment = {
      ...validEnvironment(),
      PARTNER_SESSION_SECRET: sharedSecret,
      PARTNER_INTERNAL_API_HMAC_CURRENT_SECRET: sharedSecret,
      PARTNER_DEVICE_CREDENTIAL_PEPPER: sharedSecret,
    };

    let error: PartnerConfigurationError | undefined;
    try {
      parsePartnerRuntimeConfig(environment);
    } catch (caught) {
      error = caught as PartnerConfigurationError;
    }

    expect(error?.issues).toEqual(
      expect.arrayContaining([
        {
          variable: "PARTNER_INTERNAL_API_HMAC_CURRENT_SECRET",
          reason: "must not reuse another Partner secret",
        },
        {
          variable: "PARTNER_DEVICE_CREDENTIAL_PEPPER",
          reason: "must not reuse another Partner secret",
        },
      ]),
    );
  });

  it("requires both previous HMAC rotation values when either is configured", () => {
    const environment = {
      ...validEnvironment(),
      PARTNER_INTERNAL_API_HMAC_PREVIOUS_KEY_ID: "partner-main-previous",
    };

    expect(() => parsePartnerRuntimeConfig(environment)).toThrow(
      PartnerConfigurationError,
    );
  });

  it("never includes supplied secret values in configuration errors", () => {
    const suppliedSecrets = {
      session: randomBytes(8).toString("base64url"),
      hmac: randomBytes(8).toString("base64url"),
      device: randomBytes(8).toString("base64url"),
      encryption: randomBytes(8).toString("base64url"),
      cron: randomBytes(8).toString("base64url"),
      smtp: randomBytes(8).toString("base64url"),
    };
    const environment = {
      ...validEnvironment(),
      PARTNER_SESSION_SECRET: suppliedSecrets.session,
      PARTNER_INTERNAL_API_HMAC_CURRENT_SECRET: suppliedSecrets.hmac,
      PARTNER_DEVICE_CREDENTIAL_PEPPER: suppliedSecrets.device,
      PARTNER_SMS_OTP_ENCRYPTION_KEY: suppliedSecrets.encryption,
      PARTNER_CRON_SECRET: suppliedSecrets.cron,
      PARTNER_SMTP_PASSWORD: suppliedSecrets.smtp,
    };

    let configurationError: PartnerConfigurationError | undefined;
    try {
      parsePartnerRuntimeConfig(environment);
    } catch (error) {
      configurationError = error as PartnerConfigurationError;
    }

    const serializedError = JSON.stringify({
      message: configurationError?.message,
      issues: configurationError?.issues,
    });
    for (const sensitiveValue of Object.values(suppliedSecrets)) {
      expect(serializedError).not.toContain(sensitiveValue);
    }
  });
  it("fails before reporting the application ready", () => {
    expect(() => bootstrapPartnerApplication({})).toThrow(PartnerConfigurationError);
    expect(bootstrapPartnerApplication(validEnvironment()).status).toBe("ready");
  });

  it("creates an independent process entry from the validated Partner port", () => {
    expect(initializePartnerProcess(validEnvironment())).toEqual({
      runtimeId: "kirimkode-partner",
      port: 3001,
      status: "initialized",
    });
  });

  it("runs the complete validation from the Next.js server startup hook", () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("PARTNER_RUNTIME_ID", "");
    vi.stubEnv("PARTNER_DATABASE_URL", "");
    vi.stubEnv("PARTNER_SESSION_SECRET", "");

    expect(() => register()).toThrow(PartnerConfigurationError);
  });
});
