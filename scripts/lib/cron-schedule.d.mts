export interface CronScheduleEntry {
  readonly job: string;
  readonly everySeconds: number;
}

export declare const CRON_SCHEDULE: readonly CronScheduleEntry[];

export declare function dueJobs(
  nowEpochMs: number,
  schedule?: readonly CronScheduleEntry[],
): readonly string[];
