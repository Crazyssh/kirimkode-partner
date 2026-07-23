/**
 * Cron job registry (task 16.1 foundation).
 *
 * Maps a cron job name to the {@link BatchJob} the runner should execute. The
 * dispatch route resolves the requested job here and returns a stable
 * `RESOURCE_NOT_FOUND` for an unknown name, so the transport stays thin and the
 * set of runnable jobs lives in one place. The recovery/retention/reconciliation
 * jobs (tasks 16.2–16.4) register themselves here without touching the runner,
 * the authenticator, or the route.
 */
import type { BatchJob } from "./cron-batch-runner";

/** An immutable name → job lookup. */
export type CronJobRegistry = ReadonlyMap<string, BatchJob>;

/**
 * Build a registry from a list of jobs, rejecting duplicate names so a
 * misconfiguration fails fast at composition time rather than silently
 * shadowing a job.
 */
export function createCronJobRegistry(jobs: readonly BatchJob[]): CronJobRegistry {
  const registry = new Map<string, BatchJob>();
  for (const job of jobs) {
    if (registry.has(job.name)) {
      throw new Error(`Duplicate cron job registration: ${job.name}`);
    }
    registry.set(job.name, job);
  }
  return registry;
}
