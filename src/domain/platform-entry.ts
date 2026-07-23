export const PARTNER_PLATFORM_ID = "kirimkode-partner" as const;

export const PLATFORM_ENTRIES = [
  "portal",
  "admin",
  "internal-api-v1",
  "agent-api-v1",
  "cron-v1",
] as const;

export type PlatformEntry = (typeof PLATFORM_ENTRIES)[number];
