/**
 * Public API of the cron/job foundation module (task 16.1). Transport imports
 * the authenticator, runner, registry, composition root, and their types from
 * here; adapters and ports stay internal to the module and its infrastructure.
 */
export {
  CronRequestAuthenticator,
  type CronAuthRequest,
  type CronAuthResult,
  type CronRequestAuthenticatorDeps,
} from "./cron-request-authenticator";
export {
  CronBatchRunner,
  type BatchJob,
  type BatchContext,
  type BatchStepResult,
  type BatchRunResult,
  type CronBatchRunnerDeps,
} from "./cron-batch-runner";
export {
  createCronJobRegistry,
  type CronJobRegistry,
} from "./job-registry";
export { getCronServices, type CronServices } from "./get-cron-services";
export type {
  Clock,
  SecretComparer,
  JobCursor,
  AcquiredLease,
  AcquireLeaseInput,
  RenewLeaseInput,
  ReleaseLeaseInput,
  JobLeaseRepository,
} from "./ports";
