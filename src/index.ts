import 'dotenv/config';
import * as cron from 'node-cron';
import { initDb } from './memory/init-db.js';
import { createCommandServer } from './commands/webhook.js';
import { postTrendingTweet } from './twitter/post-trending.js';
import { handleMentions } from './twitter/mention-handler.js';
import { engageWithMentions } from './twitter/engagement.js';
import { initWallet, getSparkAddress } from './utxo-api/wallet.js';
import { cronTasks, type CronBehavior, type CronTaskInfo } from './cron-registry.js';

const PORT = parseInt(process.env.PORT || '10000', 10);

// Intervals (in cron syntax)
const TRENDING_CRON = process.env.TRENDING_CRON || '0 */4 * * *'; // every 4 hours
const MENTIONS_CRON = process.env.MENTIONS_CRON || '*/5 * * * *'; // every 5 minutes
const ENGAGEMENT_CRON = process.env.ENGAGEMENT_CRON || '*/15 * * * *'; // every 15 minutes

async function main() {
  console.log('🐂 BTC Beast starting up...');

  // Initialize database tables
  await initDb();
  console.log('Database initialized.');

  // Initialize wallet (restore from PG or provision new)
  try {
    const walletInfo = await initWallet();
    console.log(`🔐 Wallet ready: ${walletInfo.address} (${walletInfo.network})`);
  } catch (err) {
    console.error('⚠️ Wallet init failed (trading disabled):', err);
    console.error('Agent will continue with read-only mode (trending tweets only).');
  }

  // Start the command webhook server
  const app = createCommandServer();
  app.listen(PORT, () => {
    console.log(`Command server listening on port ${PORT}`);
  });

  // ── Scheduled Jobs ──

  // Helper to register a cron task in the registry
  function registerCron(name: CronBehavior, schedule: string, handler: () => Promise<void>) {
    const info: CronTaskInfo = {
      task: cron.schedule(schedule, async () => {
        info.lastRunAt = new Date();
        try {
          await handler();
          info.lastError = null;
        } catch (err: any) {
          info.lastError = err?.message || String(err);
          console.error(`[cron] ${name} error:`, err);
        }
      }),
      schedule,
      running: true,
      lastRunAt: null,
      lastError: null,
    };
    cronTasks.set(name, info);
  }

  registerCron('trending', TRENDING_CRON, postTrendingTweet);
  registerCron('mentions', MENTIONS_CRON, handleMentions);
  registerCron('engagement', ENGAGEMENT_CRON, engageWithMentions);

  // Run initial tasks on startup (after a short delay)
  setTimeout(async () => {
    console.log('[startup] Running initial trending tweet...');
    const info = cronTasks.get('trending');
    try {
      await postTrendingTweet();
      if (info) { info.lastRunAt = new Date(); info.lastError = null; }
    } catch (err: any) {
      console.error('[startup] Initial trending tweet failed:', err);
      if (info) { info.lastRunAt = new Date(); info.lastError = err?.message || String(err); }
    }
  }, 10_000);

  console.log('🐂 BTC Beast is running.');
  console.log(`  Trending tweets: ${TRENDING_CRON}`);
  console.log(`  Mention checks: ${MENTIONS_CRON}`);
  console.log(`  Engagement: ${ENGAGEMENT_CRON}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
