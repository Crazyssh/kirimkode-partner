import {
  parsePartnerRuntimeConfig,
  type PartnerRuntimeConfig,
  type RuntimeEnvironment,
} from "@infrastructure/config/partner-runtime-config";

export interface PartnerApplicationBootstrap {
  config: Readonly<PartnerRuntimeConfig>;
  status: "ready";
}

export function bootstrapPartnerApplication(
  environment: RuntimeEnvironment = process.env,
): Readonly<PartnerApplicationBootstrap> {
  const config = parsePartnerRuntimeConfig(environment);

  return Object.freeze({ config, status: "ready" });
}
