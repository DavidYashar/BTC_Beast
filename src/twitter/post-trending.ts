import { chat } from '../llm/client.js';
import { SYSTEM_PROMPT, TRENDING_TWEET_PROMPT } from '../personality/prompts.js';
import { fetchTrending, formatTrendingForPrompt } from '../utxo-api/client.js';
import { postTweet } from './client.js';
import { recall, remember, recordTweet } from '../memory/store.js';

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

  const data = formatTrendingForPrompt(tokens);

  // Pull any relevant memories for richer context
  const memories = await recall('trending tokens hot movers', 3);
  const memoryContext = memories.length > 0
    ? '\n\nPrevious context:\n' + memories.map(m => m.text).join('\n')
    : '';

  const prompt = TRENDING_TWEET_PROMPT.replace('{data}', data) + memoryContext;

  console.log('[trending] Generating tweet...');
  const tweet = await chat(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    { temperature: 0.9, maxTokens: 280 },
  );

  if (!tweet || tweet.length > 280) {
    console.log(`[trending] Tweet invalid (length=${tweet?.length}), skipping.`);
    return;
  }

  console.log(`[trending] Posting: ${tweet}`);
  const tweetId = await postTweet(tweet);

  // Record in DB
  await recordTweet(tweetId, tweet, 'trending', {
    tokenCount: tokens.length,
    topTicker: tokens[0]?.ticker,
  });

  // Remember this interaction
  await remember(
    `Posted trending tweet: "${tweet}" — featured tokens: ${tokens.slice(0, 3).map(t => t.ticker).join(', ')}`,
    'tweet_posted',
  );

  console.log(`[trending] Posted tweet ${tweetId}`);
}
