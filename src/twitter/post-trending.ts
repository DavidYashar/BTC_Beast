import { chat } from '../llm/client.js';
import { SYSTEM_PROMPT, TRENDING_TWEET_PROMPT } from '../personality/prompts.js';
import { fetchTrending, formatTrendingForPrompt } from '../utxo-api/client.js';
import { postTweet } from './client.js';
import { recall, recordTweet, isTweetTooSimilar, recordTokenSnapshots } from '../memory/store.js';
import { filterLLMOutput } from './safety.js';

const MAX_DEDUP_RETRIES = 2;

/**
 * Fetch trending tokens, generate a tweet with LLM, and post it.
 */
export async function postTrendingTweet(): Promise<void> {
  console.log('[trending] Fetching trending tokens...');

  const tokens = await fetchTrending('all', 10);
  if (tokens.length === 0) {
    console.log('[trending] No tokens returned, skipping.');
    return;
  }

  // Record token snapshots for learning (deduped to every 3h per ticker)
  const snapshotCount = await recordTokenSnapshots(tokens);
  if (snapshotCount > 0) {
    console.log(`[trending] Recorded ${snapshotCount} token snapshots.`);
  }

  const data = formatTrendingForPrompt(tokens);

  // Pull any relevant memories for richer context
  const recallQuery = tokens.slice(0, 3).map(t => `${t.ticker} ${t.name}`).join(', ') + ' trending';
  const memories = await recall(recallQuery, 3);
  const memoryContext = memories.length > 0
    ? '\n\nPrevious context:\n' + memories.map(m => m.text).join('\n')
    : '';

  const basePrompt = TRENDING_TWEET_PROMPT.replace('{data}', data) + memoryContext;

  // Generate tweet with dedup check — retry if too similar to recent tweets
  let tweet: string = '';
  let attempt = 0;

  while (attempt <= MAX_DEDUP_RETRIES) {
    const extraInstruction = attempt > 0
      ? '\n\nIMPORTANT: Your previous attempt was too similar to a recent tweet. Focus on DIFFERENT tokens or a completely different angle.'
      : '';

    console.log(`[trending] Generating tweet (attempt ${attempt + 1})...`);
    tweet = await chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: basePrompt + extraInstruction },
      ],
      { temperature: 0.9 + (attempt * 0.05), maxTokens: 280 },
    );

    const safe = filterLLMOutput(tweet);
    if (!safe) {
      console.warn('[trending] Safety filter blocked tweet, retrying...');
      attempt++;
      continue;
    }
    tweet = safe;

    if (!tweet || tweet.length > 280) {
      console.log(`[trending] Tweet invalid (length=${tweet?.length}), skipping.`);
      return;
    }

    const dedup = await isTweetTooSimilar(tweet, 0.85, 48);
    if (!dedup.tooSimilar) break;

    console.log(`[trending] Tweet too similar (${(dedup.similarity * 100).toFixed(0)}%) to: "${dedup.matchedTweet?.slice(0, 60)}..."`);
    attempt++;
  }

  if (attempt > MAX_DEDUP_RETRIES) {
    console.log('[trending] All attempts too similar, skipping this cycle.');
    return;
  }

  console.log(`[trending] Posting: ${tweet}`);
  const tweetId = await postTweet(tweet);

  // Record in DB (with embedding for dedup + recall)
  await recordTweet(tweetId, tweet, 'trending', {
    tokenCount: tokens.length,
    topTicker: tokens[0]?.ticker,
    featuredTokens: tokens.slice(0, 3).map(t => t.ticker),
  });

  console.log(`[trending] Posted tweet ${tweetId}`);
}
