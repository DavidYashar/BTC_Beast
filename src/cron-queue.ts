/**
 * Serial cron queue — ensures only one cron handler runs at a time.
 *
 * When a cron fires, its handler is enqueued. The queue processes
 * jobs one-by-one (FIFO). If the queue grows beyond MAX_QUEUE_DEPTH,
 * the oldest waiting entry for the same behavior is dropped (deduped)
 * so stale runs don't pile up.
 */

import type { CronBehavior } from './cron-registry.js';

export interface QueueEntry {
  name: CronBehavior;
  handler: () => Promise<void>;
  enqueuedAt: number;
}

const MAX_QUEUE_DEPTH = 12;
const queue: QueueEntry[] = [];
let running = false;
let currentJob: CronBehavior | null = null;

/** Enqueue a cron handler for serial execution. */
export function enqueueCron(name: CronBehavior, handler: () => Promise<void>): void {
  // Deduplicate: if this behavior is already waiting in the queue, drop the older one
  const existingIdx = queue.findIndex((e) => e.name === name);
  if (existingIdx !== -1) {
    console.log(`[queue] ${name} already queued — replacing stale entry`);
    queue.splice(existingIdx, 1);
  }

  // If queue is at max depth, drop the oldest entry
  if (queue.length >= MAX_QUEUE_DEPTH) {
    const dropped = queue.shift()!;
    console.warn(`[queue] Queue full (${MAX_QUEUE_DEPTH}), dropped oldest: ${dropped.name}`);
  }

  queue.push({ name, handler, enqueuedAt: Date.now() });

  if (!running) {
    void processQueue();
  }
}

/** Returns the currently executing behavior, or null. */
export function currentRunning(): CronBehavior | null {
  return currentJob;
}

/** Returns the names of behaviors waiting in the queue. */
export function pendingJobs(): CronBehavior[] {
  return queue.map((e) => e.name);
}

async function processQueue(): Promise<void> {
  if (running) return;
  running = true;

  while (queue.length > 0) {
    const entry = queue.shift()!;
    const waitMs = Date.now() - entry.enqueuedAt;
    currentJob = entry.name;
    console.log(`[queue] ▶ ${entry.name} (waited ${(waitMs / 1000).toFixed(1)}s, ${queue.length} remaining)`);

    try {
      await entry.handler();
    } catch (err) {
      // Error is already logged by the cron wrapper in index.ts — just continue
      console.error(`[queue] ${entry.name} threw (continuing):`, err);
    }

    currentJob = null;
  }

  running = false;
}
