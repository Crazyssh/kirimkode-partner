import { bootstrapPartnerApplication } from "./bootstrap-partner-application";
import type { RuntimeEnvironment } from "@infrastructure/config/partner-runtime-config";

export interface PartnerProcessEntry {
  runtimeId: "kirimkode-partner";
  port: 3001;
  status: "initialized";
}

export function initializePartnerProcess(
  environment: RuntimeEnvironment = process.env,
): Readonly<PartnerProcessEntry> {
  const { config } = bootstrapPartnerApplication(environment);
  return Object.freeze({
    runtimeId: config.runtimeId,
    port: config.port,
    status: "initialized",
  });
}
