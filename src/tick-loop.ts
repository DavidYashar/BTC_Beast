/**
 * Single tick loop — replaces node-cron + serial queue.
 *
 * One `setTimeout` chain drives all scheduled behaviors sequentially.
 * No overlap is possible: the next tick starts only after the current
 * one finishes + TICK_INTERVAL_MS pause.  Behaviors run in priority
 * order (user-facing first, maintenance last).
 */

import type { CronBehavior } from './cron-registry.js';
import { behaviors } from './cron-registry.js';
import { warmDb } from './memory/db.js';

const TICK_INTERVAL_MS = 60_000; // 60 s between ticks
const HANDLER_TIMEOUT_MS = 2 * 60_000; // 2 min max per handler
const HEARTBEAT_EVERY = 10; // log heartbeat every N ticks

let loopTimer: ReturnType<typeof setTimeout> | null = null;
let currentJob: CronBehavior | null = null;
let tickCount = 0;
let consecutiveTickErrors = 0;

/** Start the tick loop.  Safe to call multiple times (no-ops if already running). */
export function startLoop(): void {
  if (loopTimer) return;
  scheduleNext();
  console.log('[tick] Loop started');
}

/** Stop the tick loop (current tick, if running, will finish). */
export function stopLoop(): void {
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
    console.log('[tick] Loop stopped');
  }
}

/** Returns the behavior currently executing, or null. */
export function currentRunning(): CronBehavior | null {
  return currentJob;
}

/** Returns behaviors that are due but haven't run yet in this tick. */
export function nextDueBehaviors(): CronBehavior[] {
  const now = Date.now();
  return [...behaviors.entries()]
    .filter(([, b]) => b.enabled && now - b.lastRunAt >= b.intervalMs)
    .map(([name]) => name);
}

// ── internals ──

function scheduleNext(): void {
  loopTimer = setTimeout(async () => {
    try {
      await tick();
      consecutiveTickErrors = 0;
    } catch (err) {
      consecutiveTickErrors++;
      console.error(`[tick] UNHANDLED tick error (#${consecutiveTickErrors}):`, err);
    }
    if (loopTimer !== null) scheduleNext(); // chain only if not stopped
  }, TICK_INTERVAL_MS);
}

async function tick(): Promise<void> {
  tickCount++;
  const now = Date.now();

  // Periodic heartbeat so we can confirm the loop is alive in logs
  if (tickCount % HEARTBEAT_EVERY === 0) {
    const dueBehaviors = [...behaviors.entries()]
      .filter(([, b]) => b.enabled && now - b.lastRunAt >= b.intervalMs)
      .map(([name]) => name);
    console.log(`[tick] ♥ heartbeat — tick #${tickCount}, uptime ${Math.floor(process.uptime())}s, due: [${dueBehaviors.join(', ') || 'none'}]`);
  }

  // One PG health check per tick
  const pgOk = await warmDb();
  if (!pgOk) {
    console.warn(`[tick #${tickCount}] PG down — skipping this tick`);
    return;
  }

  // Walk behaviors in priority order (Map preserves insertion order)
  for (const [name, entry] of behaviors) {
    if (!entry.enabled) continue;
    if (now - entry.lastRunAt < entry.intervalMs) continue;

    // Check daily-hour constraint (if set)
    if (entry.dailyHourUtc !== undefined) {
      const hour = new Date().getUTCHours();
      if (hour < entry.dailyHourUtc) continue;
    }

    currentJob = name;
    console.log(`[tick #${tickCount}] ▶ ${name}`);

    try {
      await Promise.race([
        entry.handler(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${name} timed out after ${HANDLER_TIMEOUT_MS / 1000}s`)), HANDLER_TIMEOUT_MS),
        ),
      ]);
      entry.lastError = null;
    } catch (err: any) {
      entry.lastError = err?.message || String(err);
      console.error(`[tick] ${name} error:`, err);
    }

    entry.lastRunAt = Date.now();
    currentJob = null;
  }
}
