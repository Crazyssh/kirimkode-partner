import packageMetadata from "../../../package.json";

import { bootstrapPartnerApplication } from "@application/bootstrap/bootstrap-partner-application";
import {
  getPartnerDatabaseClient,
  PrismaCronLastSeenGateway,
} from "@infrastructure/database";
import { PostgresReadinessProbe } from "@infrastructure/database/postgres-readiness-probe";

import { CronLivenessService } from "./cron-liveness-service";
import { PartnerHealthService, type ReadinessProbe } from "./partner-health-service";

const alwaysReady: ReadinessProbe = { async isReady() { return true; } };
const livenessService = new PartnerHealthService(packageMetadata.version, alwaysReady);
let readinessService: PartnerHealthService | undefined;
let cronLivenessService: CronLivenessService | undefined;

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

/**
 * The cron liveness signal (requirement 20.3). Unlike `live`/`ready` this reads
 * the `job_leases` table, so it is composed lazily against the shared Partner
 * database client. The singleton's construction instant doubles as the
 * first-run grace anchor for a cold lease store.
 */
export function getCronLivenessService(): CronLivenessService {
  if (cronLivenessService === undefined) {
    const { config } = bootstrapPartnerApplication(process.env);
    const client = getPartnerDatabaseClient({ databaseUrl: config.databaseUrl });
    cronLivenessService = new CronLivenessService({
      version: packageMetadata.version,
      reader: new PrismaCronLastSeenGateway(client),
    });
  }
  return cronLivenessService;
}
