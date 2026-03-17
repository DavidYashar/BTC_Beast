/**
 * Content scheduler — posts one content tweet per cron cycle.
 * Wired into the cron system via index.ts.
 */

import { generateContentTweet } from './engine.js';
import { postTweet } from '../twitter/client.js';
import { recordTweet } from '../memory/store.js';
import { topicLabel } from './topics.js';

/**
 * Generate and post a content tweet.
 * Called by the cron scheduler every 2-3 hours.
 */
export async function postContentTweet(): Promise<void> {
  console.log('[content] Starting content tweet cycle...');

  const result = await generateContentTweet();
  if (!result) {
    console.log('[content] No tweet generated this cycle (dedup/safety), skipping.');
    return;
  }

  const label = topicLabel(result.topic);

  console.log(`[content] Posting (${label}, ${result.attempts} attempt(s)): ${result.text}`);
  const tweetId = await postTweet(result.text);

  await recordTweet(tweetId, result.text, 'content', {
    topic: result.topic,
    seed: result.seed.slice(0, 100),
    attempts: result.attempts,
  });

  console.log(`[content] Posted tweet ${tweetId} (topic: ${label})`);
}
