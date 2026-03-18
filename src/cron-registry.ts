export type CronBehavior =
  | 'mentions'
  | 'engagement'
  | 'content'
  | 'trending'
  | 'self-promo'
  | 's402'
  | 'wallet'
  | 'pruning'
  | 'knowledge-refresh';

export interface BehaviorEntry {
  handler: () => Promise<void>;
  intervalMs: number;
  /** For daily behaviors: earliest UTC hour to run (e.g. 14 = 14:00 UTC). */
  dailyHourUtc?: number;
  enabled: boolean;
  lastRunAt: number; // epoch ms — 0 means never
  lastError: string | null;
}

/**
 * Ordered map of behaviors.  Insertion order = priority
 * (user-facing first, maintenance last).
 * Populated by registerBehavior() in index.ts at startup.
 */
export const behaviors = new Map<CronBehavior, BehaviorEntry>();

/** Register a behavior (call at startup, in priority order). */
export function registerBehavior(
  name: CronBehavior,
  handler: () => Promise<void>,
  intervalMs: number,
  opts?: { dailyHourUtc?: number; enabled?: boolean },
): void {
  behaviors.set(name, {
    handler,
    intervalMs,
    dailyHourUtc: opts?.dailyHourUtc,
    enabled: opts?.enabled ?? true,
    lastRunAt: 0,
    lastError: null,
  });
}
