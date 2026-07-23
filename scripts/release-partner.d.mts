export interface PartnerReleaseStep {
  command: "npm" | "pm2";
  args: string[];
  cwd: string;
}

export function createPartnerReleasePlan(appRoot?: string): PartnerReleaseStep[];
export function runPartnerRelease(environment?: Record<string, string | undefined>): void;
