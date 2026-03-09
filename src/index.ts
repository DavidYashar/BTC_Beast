import 'dotenv/config';
import * as cron from 'node-cron';
import { initDb } from './memory/init-db.js';
import { createCommandServer } from './commands/webhook.js';
import { postTrendingTweet } from './twitter/post-trending.js';
import { handleMentions } from './twitter/mention-handler.js';
import { engageWithMentions } from './twitter/engagement.js';
import { initWallet, getSparkAddress } from './utxo-api/wallet.js';

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

  // Post trending tweet every 4 hours
  cron.schedule(TRENDING_CRON, async () => {
    try {
      await postTrendingTweet();
    } catch (err) {
      console.error('[cron] Trending tweet error:', err);
    }
  });

  // Check @mentions every 5 minutes
  cron.schedule(MENTIONS_CRON, async () => {
    try {
      await handleMentions();
    } catch (err) {
      console.error('[cron] Mention handler error:', err);
    }
  });

  // Engage with UTXO mentions every 15 minutes
  cron.schedule(ENGAGEMENT_CRON, async () => {
    try {
      await engageWithMentions();
    } catch (err) {
      console.error('[cron] Engagement error:', err);
    }
  });

  // Run initial tasks on startup (after a short delay)
  setTimeout(async () => {
    console.log('[startup] Running initial trending tweet...');
    try {
      await postTrendingTweet();
    } catch (err) {
      console.error('[startup] Initial trending tweet failed:', err);
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
