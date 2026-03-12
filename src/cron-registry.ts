import * as cron from 'node-cron';

export type CronBehavior = 'trending' | 'mentions' | 'engagement';

export interface CronTaskInfo {
  task: cron.ScheduledTask;
  schedule: string;
  running: boolean;
  lastRunAt: Date | null;
  lastError: string | null;
}

export const cronTasks = new Map<CronBehavior, CronTaskInfo>();
