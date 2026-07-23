export interface PartnerRestorePlan {
  artifact: string;
  command: "pg_restore";
  args: string[];
}

export function createPartnerRestorePlan(
  artifactValue: string,
  environment?: Record<string, string | undefined>,
): PartnerRestorePlan;
export function runPartnerRestore(
  artifact: string,
  environment?: Record<string, string | undefined>,
): void;
