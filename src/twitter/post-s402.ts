import { chat } from '../llm/client.js';
import { SYSTEM_PROMPT, S402_TWEET_PROMPT } from '../personality/prompts.js';
import { postTweet } from './client.js';
import { recall, recordTweet, isTweetTooSimilar } from '../memory/store.js';

const MAX_DEDUP_RETRIES = 2;

/**
 * Post a daily tweet about the S402 protocol.
 * Uses RAG-recalled S402 knowledge from GitHub docs.
 */
export async function postS402Tweet(): Promise<void> {
  console.log('[s402] Generating S402 protocol tweet...');

  // Rotate through different S402 angles for variety
  const angles = [
    'S402 protocol HTTP 402 payment-required AI agents Bitcoin micropayments',
    'S402 Spark network instant payments API monetization machine-to-machine',
    'S402 protocol quote invoice verify pay-per-call agents autonomous',
    'S402 open standard payment gating Bitcoin L2 Spark developer',
    'S402 how it works AI agent pays for API call Spark invoice',
  ];
  const angle = angles[Math.floor(Math.random() * angles.length)];

  const memories = await recall(angle, 5);
  const context = memories.length > 0
    ? memories.map(m => m.text).join('\n\n')
    : 'S402 is an open payment-gating protocol that extends HTTP 402 for AI agents to pay for API calls using Bitcoin micropayments on Spark.';

  const basePrompt = S402_TWEET_PROMPT.replace('{context}', context);

  let tweet = '';
  let attempt = 0;

  while (attempt <= MAX_DEDUP_RETRIES) {
    const extraInstruction = attempt > 0
      ? '\n\nIMPORTANT: Your previous attempt was too similar to a recent tweet. Pick a completely different aspect of S402 to highlight.'
      : '';

    console.log(`[s402] Generating tweet (attempt ${attempt + 1})...`);
    tweet = await chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: basePrompt + extraInstruction },
      ],
      { temperature: 0.9 + (attempt * 0.05), maxTokens: 280 },
    );

    if (!tweet || tweet.length > 280) {
      console.log(`[s402] Tweet invalid (length=${tweet?.length}), skipping.`);
      return;
    }

    const dedup = await isTweetTooSimilar(tweet, 0.85, 72);
    if (!dedup.tooSimilar) break;

    console.log(`[s402] Tweet too similar (${(dedup.similarity * 100).toFixed(0)}%) — retrying.`);
    attempt++;
  }

  if (attempt > MAX_DEDUP_RETRIES) {
    console.log('[s402] All attempts too similar, skipping this cycle.');
    return;
  }

  console.log(`[s402] Posting: ${tweet}`);
  const tweetId = await postTweet(tweet);

  await recordTweet(tweetId, tweet, 's402', {
    category: 's402-protocol',
    angle,
  });

  console.log(`[s402] Posted tweet ${tweetId}`);
}
