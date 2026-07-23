export interface PartnerReleaseStep {
  command: "npm" | "pm2";
  args: string[];
  cwd: string;
  migration?: boolean;
}

export function createPartnerReleasePlan(appRoot?: string): PartnerReleaseStep[];
export function partnerReleaseStepEnvironment(
  step: PartnerReleaseStep,
  environment: Record<string, string | undefined>,
): Record<string, string | undefined>;
export function runPartnerRelease(environment?: Record<string, string | undefined>): void;
