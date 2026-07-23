export const DEFAULT_PARTNER_BACKUP_ROOT: "/var/backups/kirimkode-partner";

export interface PartnerBackupPlan {
  artifact: string;
  backupRoot: string;
  command: "pg_dump";
  args: string[];
}

export function createPartnerBackupPlan(
  environment?: Record<string, string | undefined>,
  now?: Date,
): PartnerBackupPlan;
export function runPartnerBackup(environment?: Record<string, string | undefined>): string;
