import packageMetadata from "../../../package.json";

import { bootstrapPartnerApplication } from "@application/bootstrap/bootstrap-partner-application";
import { PostgresReadinessProbe } from "@infrastructure/database/postgres-readiness-probe";

import { PartnerHealthService, type ReadinessProbe } from "./partner-health-service";

const alwaysReady: ReadinessProbe = { async isReady() { return true; } };
const livenessService = new PartnerHealthService(packageMetadata.version, alwaysReady);
let readinessService: PartnerHealthService | undefined;

export function getPartnerLivenessService(): PartnerHealthService {
  return livenessService;
}

export function getPartnerReadinessService(): PartnerHealthService {
  if (readinessService === undefined) {
    const { config } = bootstrapPartnerApplication(process.env);
    readinessService = new PartnerHealthService(
      packageMetadata.version,
      new PostgresReadinessProbe(config.databaseUrl),
    );
  }
  return readinessService;
}
