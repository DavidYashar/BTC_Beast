import 'dotenv/config';
import * as cron from 'node-cron';
import { initDb } from './memory/init-db.js';
import { ingestKnowledge } from './memory/ingest-knowledge.js';
import { createCommandServer } from './commands/webhook.js';
import { postTrendingTweet } from './twitter/post-trending.js';
import { postSelfPromoTweet } from './twitter/post-self-promo.js';
import { postS402Tweet } from './twitter/post-s402.js';
import { postWalletTweet } from './twitter/post-wallet.js';
import { handleMentions } from './twitter/mention-handler.js';
import { engageWithMentions } from './twitter/engagement.js';
import { pruneMemories } from './memory/store.js';
import { initWallet, getSparkAddress } from './utxo-api/wallet.js';
import { fetchGitHubKnowledge } from './knowledge/github-fetcher.js';
import { postContentTweet } from './content/scheduler.js';
import { cronTasks, type CronBehavior, type CronTaskInfo } from './cron-registry.js';

const PORT = parseInt(process.env.PORT || '10000', 10);

// Intervals (in cron syntax)
const TRENDING_CRON = process.env.TRENDING_CRON || '0 */4 * * *'; // every 4 hours
const MENTIONS_CRON = process.env.MENTIONS_CRON || '*/5 * * * *'; // every 5 minutes
const ENGAGEMENT_CRON = process.env.ENGAGEMENT_CRON || '*/15 * * * *'; // every 15 minutes
const SELF_PROMO_CRON = process.env.SELF_PROMO_CRON || '0 14 * * *'; // daily at 14:00 UTC
const S402_CRON = process.env.S402_CRON || '0 18 * * *'; // daily at 18:00 UTC
const WALLET_CRON = process.env.WALLET_CRON || '0 22 * * *'; // daily at 22:00 UTC
const CONTENT_CRON = process.env.CONTENT_CRON || '0 */3 * * *'; // every 3 hours

// When false/unset, crons start paused — use POST /commands/start-tweeting to enable
const AUTO_TWEET = process.env.AUTO_TWEET === 'true';

async function main() {
  console.log('🐂 BTC Beast starting up...');

  // Initialize database tables
  await initDb();
  console.log('Database initialized.');

  // Fetch latest docs from GitHub repos (S402 + UTXO Wallet)
  try {
    await fetchGitHubKnowledge();
  } catch (err) {
    console.warn('⚠️ GitHub knowledge fetch failed (will use cached):', err);
  }

  // Load knowledge files into RAG (skips if unchanged)
  await ingestKnowledge();

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
    let executing = false;
    const startPaused = !AUTO_TWEET;
    const info: CronTaskInfo = {
      task: cron.schedule(schedule, async () => {
        if (executing) {
          console.warn(`[cron] ${name} still running, skipping overlapping execution.`);
          return;
        }
        executing = true;
        info.lastRunAt = new Date();
        try {
          await handler();
          info.lastError = null;
        } catch (err: any) {
          info.lastError = err?.message || String(err);
          console.error(`[cron] ${name} error:`, err);
        } finally {
          executing = false;
        }
      }),
      schedule,
      running: true,
      lastRunAt: null,
      lastError: null,
    };
    if (startPaused) {
      info.task.stop();
      info.running = false;
    }
    cronTasks.set(name, info);
  }

  registerCron('trending', TRENDING_CRON, postTrendingTweet);
  registerCron('mentions', MENTIONS_CRON, handleMentions);
  registerCron('engagement', ENGAGEMENT_CRON, engageWithMentions);
  registerCron('self-promo', SELF_PROMO_CRON, postSelfPromoTweet);
  registerCron('s402', S402_CRON, postS402Tweet);
  registerCron('wallet', WALLET_CRON, postWalletTweet);
  registerCron('content', CONTENT_CRON, postContentTweet);

  // Daily memory pruning at 3:00 AM UTC
  registerCron('pruning', '0 3 * * *', async () => {
    const result = await pruneMemories();
    const total = result.memories + result.tweets + result.snapshots + result.mentions;
    if (total > 0) {
      console.log(`[pruning] Cleaned: ${result.memories} memories, ${result.tweets} tweets, ${result.snapshots} snapshots, ${result.mentions} mentions`);
    }
  });

  // Daily GitHub knowledge refresh at 4:00 AM UTC
  registerCron('knowledge-refresh', '0 4 * * *', async () => {
    const updated = await fetchGitHubKnowledge();
    if (updated > 0) {
      console.log(`[knowledge-refresh] ${updated} file(s) updated, re-ingesting...`);
      await ingestKnowledge();
    }
  });

  // Run initial tasks on startup (after a short delay) — only if AUTO_TWEET is enabled
  if (AUTO_TWEET) {
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
  } else {
    console.log('[startup] AUTO_TWEET is off — tweeting paused. Use POST /commands/start-tweeting to enable.');
  }

  console.log('🐂 BTC Beast is running.');
  console.log(`  Trending tweets: ${TRENDING_CRON}`);
  console.log(`  Self-promo ($Beast): ${SELF_PROMO_CRON}`);
  console.log(`  S402 protocol: ${S402_CRON}`);
  console.log(`  UTXO Wallet: ${WALLET_CRON}`);
  console.log(`  Content engine: ${CONTENT_CRON}`);
  console.log(`  Mention checks: ${MENTIONS_CRON}`);
  console.log(`  Engagement: ${ENGAGEMENT_CRON}`);
  console.log(`  Auto-tweet: ${AUTO_TWEET ? 'ON' : 'OFF (paused)'}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
