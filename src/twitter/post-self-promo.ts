import { chat } from '../llm/client.js';
import { SYSTEM_PROMPT, SELF_PROMO_TWEET_PROMPT } from '../personality/prompts.js';
import { fetchTokenInfo, formatTokenInfoForPrompt } from '../utxo-api/client.js';
import { postTweet } from './client.js';
import { recall, recordTweet, isTweetTooSimilar } from '../memory/store.js';
import { filterLLMOutput } from './safety.js';

const MAX_DEDUP_RETRIES = 2;

/**
 * Post a daily tweet about $Beast — BTC Beast's own token.
 * Requires BEAST_TOKEN_ADDRESS env var to be set.
 */
export async function postSelfPromoTweet(): Promise<void> {
  const tokenAddress = process.env.BEAST_TOKEN_ADDRESS;
  if (!tokenAddress) {
    console.log('[self-promo] BEAST_TOKEN_ADDRESS not set, skipping.');
    return;
  }

  console.log('[self-promo] Fetching $Beast token info...');

  let tokenData: string;
  try {
    const info = await fetchTokenInfo(tokenAddress);
    tokenData = formatTokenInfoForPrompt(info);
  } catch (err: any) {
    console.error('[self-promo] Failed to fetch token info:', err.message);
    return;
  }

  // Pull relevant memories for richer context
  const memories = await recall('$Beast BTC Beast token self promo', 3);
  const memoryContext = memories.length > 0
    ? '\n\nPrevious context:\n' + memories.map(m => m.text).join('\n')
    : '';

  const basePrompt = SELF_PROMO_TWEET_PROMPT.replace('{data}', tokenData) + memoryContext;

  let tweet = '';
  let attempt = 0;

  while (attempt <= MAX_DEDUP_RETRIES) {
    const extraInstruction = attempt > 0
      ? '\n\nIMPORTANT: Your previous attempt was too similar to a recent tweet. Find a completely different angle — different stat, different hook, different vibe.'
      : '';

    console.log(`[self-promo] Generating tweet (attempt ${attempt + 1})...`);
    tweet = await chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: basePrompt + extraInstruction },
      ],
      { temperature: 0.9 + (attempt * 0.05), maxTokens: 280 },
    );

    const safe = filterLLMOutput(tweet);
    if (!safe) {
      console.warn('[self-promo] Safety filter blocked tweet, retrying...');
      attempt++;
      continue;
    }
    tweet = safe;

    if (!tweet || tweet.length > 280) {
      console.log(`[self-promo] Tweet invalid (length=${tweet?.length}), skipping.`);
      return;
    }

    const dedup = await isTweetTooSimilar(tweet, 0.85, 72);
    if (!dedup.tooSimilar) break;

    console.log(`[self-promo] Tweet too similar (${(dedup.similarity * 100).toFixed(0)}%) — retrying.`);
    attempt++;
  }

  if (attempt > MAX_DEDUP_RETRIES) {
    console.log('[self-promo] All attempts too similar, skipping this cycle.');
    return;
  }

  console.log(`[self-promo] Posting: ${tweet}`);
  const tweetId = await postTweet(tweet);

  await recordTweet(tweetId, tweet, 'self-promo', {
    tokenAddress,
    category: 'self-promo',
  });

  console.log(`[self-promo] Posted tweet ${tweetId}`);
}
