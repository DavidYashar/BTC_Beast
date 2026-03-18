import 'dotenv/config';
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
import { registerBehavior } from './cron-registry.js';
import { startLoop } from './tick-loop.js';

const PORT = parseInt(process.env.PORT || '10000', 10);

// When false/unset, behaviors start disabled — use POST /commands/start-tweeting to enable
const AUTO_TWEET = process.env.AUTO_TWEET === 'true';

// Interval helpers
const MIN  = 60_000;
const HOUR = 60 * MIN;
const DAY  = 24 * HOUR;

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

  // ── Register behaviors in priority order (user-facing first) ──

  const enabled = AUTO_TWEET;

  registerBehavior('mentions',     handleMentions,       5 * MIN,  { enabled });
  registerBehavior('engagement',   engageWithMentions,  15 * MIN,  { enabled });
  registerBehavior('content',      postContentTweet,     3 * HOUR, { enabled });
  registerBehavior('trending',     postTrendingTweet,    4 * HOUR, { enabled });
  registerBehavior('self-promo',   postSelfPromoTweet,   DAY,      { enabled, dailyHourUtc: 14 });
  registerBehavior('s402',         postS402Tweet,        DAY,      { enabled, dailyHourUtc: 18 });
  registerBehavior('wallet',       postWalletTweet,      DAY,      { enabled, dailyHourUtc: 22 });

  registerBehavior('pruning', async () => {
    const result = await pruneMemories();
    const total = result.memories + result.tweets + result.snapshots + result.mentions;
    if (total > 0) {
      console.log(`[pruning] Cleaned: ${result.memories} memories, ${result.tweets} tweets, ${result.snapshots} snapshots, ${result.mentions} mentions`);
    }
  }, DAY, { enabled: true, dailyHourUtc: 3 });

  registerBehavior('knowledge-refresh', async () => {
    const updated = await fetchGitHubKnowledge();
    if (updated > 0) {
      console.log(`[knowledge-refresh] ${updated} file(s) updated, re-ingesting...`);
      await ingestKnowledge();
    }
  }, DAY, { enabled: true, dailyHourUtc: 4 });

  // Start the single tick loop (one handler at a time, setTimeout chain)
  startLoop();

  console.log('🐂 BTC Beast is running.');
  console.log(`  Mentions:          every 5 min`);
  console.log(`  Engagement:        every 15 min`);
  console.log(`  Content engine:    every 3 hours`);
  console.log(`  Trending tweets:   every 4 hours`);
  console.log(`  Self-promo ($Beast): daily ~14:00 UTC`);
  console.log(`  S402 protocol:     daily ~18:00 UTC`);
  console.log(`  UTXO Wallet:       daily ~22:00 UTC`);
  console.log(`  Pruning:           daily ~03:00 UTC`);
  console.log(`  Knowledge refresh: daily ~04:00 UTC`);
  console.log(`  Auto-tweet: ${AUTO_TWEET ? 'ON' : 'OFF (paused)'}`);
  console.log(`  Execution: SERIAL tick loop (one at a time, no overlap)`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
