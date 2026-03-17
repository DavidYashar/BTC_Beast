/**
 * Content engine — generates unique tweets using RAG + LLM.
 *
 * Flow: pick topic (weighted) → select template seed → recall past tweets
 * via pgvector → build prompt with seed + RAG context → LLM generates
 * fresh tweet → dedup check → return.
 *
 * Three anti-repetition layers:
 * 1. RAG recall of past tweets (injected as "don't repeat this" context)
 * 2. Cosine dedup threshold (85% over 72h window)
 * 3. 100+ template seeds provide variety in LLM prompting
 */

import { Topic, pickTopic, topicLabel, MAX_SIGNAL_TWEETS_PER_DAY } from './topics.js';
import { getTemplateSeed } from './templates.js';
import { chat } from '../llm/client.js';
import { SYSTEM_PROMPT, CONTENT_TWEET_PROMPT } from '../personality/prompts.js';
import { recall, isTweetTooSimilar } from '../memory/store.js';
import { filterLLMOutput } from '../twitter/safety.js';

const MAX_DEDUP_RETRIES = 3;
const MAX_TWEET_LENGTH = 280;

export interface ContentResult {
  text: string;
  topic: Topic;
  seed: string;
  attempts: number;
}

/**
 * Generate the next content tweet.
 * Returns null if all attempts fail dedup or safety checks.
 */
export async function generateContentTweet(opts?: {
  signalsPostedToday?: number;
}): Promise<ContentResult | null> {
  const signalsToday = opts?.signalsPostedToday ?? 0;
  const excludeSignals = signalsToday >= MAX_SIGNAL_TWEETS_PER_DAY;

  const topic = pickTopic(excludeSignals);
  const label = topicLabel(topic);
  const seed = getTemplateSeed(topic);

  console.log(`[content] Topic: ${label} | Seed: "${seed.slice(0, 60)}..."`);

  // Recall recent related tweets + knowledge for context
  const recallQuery = `${label} ${seed.split(' ').slice(0, 6).join(' ')}`;
  const memories = await recall(recallQuery, 5);
  const context = memories.length > 0
    ? memories.map((m) => `- ${m.text}`).join('\n')
    : '(No recent context — this is a fresh topic area.)';

  const basePrompt = CONTENT_TWEET_PROMPT
    .replace('{seed}', seed)
    .replace('{context}', context);

  let tweet = '';
  let attempt = 0;

  while (attempt <= MAX_DEDUP_RETRIES) {
    const extraInstruction = attempt > 0
      ? '\n\nIMPORTANT: Your previous attempt was too similar to a recent tweet. Take a COMPLETELY different angle on this topic.'
      : '';

    console.log(`[content] Generating tweet (attempt ${attempt + 1})...`);
    tweet = await chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: basePrompt + extraInstruction },
      ],
      { temperature: 0.85 + attempt * 0.05, maxTokens: 280 },
    );

    // Safety filter — blocks tweets that leak secrets
    const safe = filterLLMOutput(tweet);
    if (!safe) {
      console.warn(`[content] Safety filter blocked tweet, retrying...`);
      attempt++;
      continue;
    }
    tweet = safe;

    // Length check
    if (!tweet || tweet.length > MAX_TWEET_LENGTH) {
      console.log(`[content] Tweet invalid (length=${tweet?.length}), retrying...`);
      attempt++;
      continue;
    }

    // Dedup check against last 72 hours of tweets
    const dedup = await isTweetTooSimilar(tweet, 0.85, 72);
    if (!dedup.tooSimilar) break;

    console.log(
      `[content] Tweet too similar (${(dedup.similarity * 100).toFixed(0)}%) — retrying.`,
    );
    attempt++;
  }

  if (attempt > MAX_DEDUP_RETRIES) {
    console.log(`[content] All ${MAX_DEDUP_RETRIES + 1} attempts failed dedup for topic "${label}", skipping.`);
    return null;
  }

  return { text: tweet, topic, seed, attempts: attempt + 1 };
}
