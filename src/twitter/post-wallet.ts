import { chat } from '../llm/client.js';
import { SYSTEM_PROMPT, WALLET_TWEET_PROMPT } from '../personality/prompts.js';
import { postTweet } from './client.js';
import { recall, recordTweet, isTweetTooSimilar } from '../memory/store.js';

const MAX_DEDUP_RETRIES = 2;

/**
 * Post a daily tweet about UTXO Wallet.
 * Uses RAG-recalled wallet knowledge from GitHub docs.
 */
export async function postWalletTweet(): Promise<void> {
  console.log('[wallet] Generating UTXO Wallet tweet...');

  // Rotate through different wallet angles for variety
  const angles = [
    'UTXO Wallet Bitcoin Spark self-custody instant transfers',
    'UTXO Wallet send receive BTC tokens Spark network mobile',
    'UTXO Wallet non-custodial Bitcoin L2 Spark address spark1',
    'UTXO Wallet open source Bitcoin token management security',
    'UTXO Wallet Spark network deposit withdraw Bitcoin-native',
  ];
  const angle = angles[Math.floor(Math.random() * angles.length)];

  const memories = await recall(angle, 5);
  const context = memories.length > 0
    ? memories.map(m => m.text).join('\n\n')
    : 'UTXO Wallet is a Bitcoin-native wallet for the Spark network, enabling instant, near-zero-fee transfers of BTC and tokens.';

  const basePrompt = WALLET_TWEET_PROMPT.replace('{context}', context);

  let tweet = '';
  let attempt = 0;

  while (attempt <= MAX_DEDUP_RETRIES) {
    const extraInstruction = attempt > 0
      ? '\n\nIMPORTANT: Your previous attempt was too similar to a recent tweet. Highlight a completely different wallet feature or use case.'
      : '';

    console.log(`[wallet] Generating tweet (attempt ${attempt + 1})...`);
    tweet = await chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: basePrompt + extraInstruction },
      ],
      { temperature: 0.9 + (attempt * 0.05), maxTokens: 280 },
    );

    if (!tweet || tweet.length > 280) {
      console.log(`[wallet] Tweet invalid (length=${tweet?.length}), skipping.`);
      return;
    }

    const dedup = await isTweetTooSimilar(tweet, 0.85, 72);
    if (!dedup.tooSimilar) break;

    console.log(`[wallet] Tweet too similar (${(dedup.similarity * 100).toFixed(0)}%) — retrying.`);
    attempt++;
  }

  if (attempt > MAX_DEDUP_RETRIES) {
    console.log('[wallet] All attempts too similar, skipping this cycle.');
    return;
  }

  console.log(`[wallet] Posting: ${tweet}`);
  const tweetId = await postTweet(tweet);

  await recordTweet(tweetId, tweet, 'wallet', {
    category: 'utxo-wallet',
    angle,
  });

  console.log(`[wallet] Posted tweet ${tweetId}`);
}
