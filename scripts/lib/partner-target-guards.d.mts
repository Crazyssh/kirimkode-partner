export const PARTNER_DATABASE_NAME: "kirimkode_partner";
export const PARTNER_PACKAGE_NAME: "@kirimkode/partner-platform";
export const PARTNER_PROCESS_NAME: "kirimkode-partner";
export const PARTNER_PORT: "3001";

export interface ParsedPartnerDatabaseUrl {
  databaseName: "kirimkode_partner";
  url: URL;
  username: string;
}

export function assertPartnerProcessName(value: string): "kirimkode-partner";
export function assertPartnerAppRoot(value: string): string;
export function parsePartnerDatabaseUrl(value: string): ParsedPartnerDatabaseUrl;
export function postgresEnvironment(
  databaseUrl: string,
  baseEnvironment?: Record<string, string | undefined>,
): Record<string, string | undefined>;
export function assertPartnerBackupRoot(value: string): string;
export function assertPartnerBackupArtifact(value: string, backupRoot: string): string;
export function assertRestoreConfirmation(value: string | undefined): void;
export function formatBackupTimestamp(date?: Date): string;
