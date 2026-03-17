import { chat } from '../llm/client.js';
import { SYSTEM_PROMPT, ENGAGEMENT_REPLY_PROMPT } from '../personality/prompts.js';
import { searchUtxoMentions, replyToTweet, getUsernameById } from './client.js';
import { recall, remember, isMentionHandled, markMentionHandled, getState, setState } from '../memory/store.js';
import { sanitizeMentionInput, filterLLMOutput } from './safety.js';

/**
 * Search for tweets mentioning "utxo.fun" / "UTXO Exchange" and engage.
 */
export async function engageWithMentions(): Promise<void> {
  console.log('[engagement] Searching for UTXO mentions...');

  const sinceId = await getState('last_engagement_id');
  const mentions = await searchUtxoMentions(sinceId ?? undefined);

  if (mentions.length === 0) {
    console.log('[engagement] No new UTXO mentions found.');
    return;
  }

  console.log(`[engagement] Found ${mentions.length} UTXO mentions to engage with.`);

  const sorted = [...mentions].reverse();

  for (const mention of sorted) {
    if (await isMentionHandled(mention.id)) continue;

    try {
      const username = mention.username || await getUsernameById(mention.authorId);

      // RAG context
      const memories = await recall(mention.text, 5);
      const context = memories.map(m => m.text).join('\n---\n');

      const safeTweet = sanitizeMentionInput(mention.text);
      const prompt = ENGAGEMENT_REPLY_PROMPT
        .replace('{context}', context || 'No specific context found.')
        .replace('{username}', username)
        .replace('{tweet}', safeTweet);

      const reply = await chat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        { temperature: 0.75, maxTokens: 280 },
      );

      if (!reply || reply.length > 280) {
        console.log(`[engagement] Reply invalid for ${mention.id}, skipping.`);
        await markMentionHandled(mention.id, null, { skipped: true, reason: 'invalid_reply' });
        continue;
      }

      const safeReply = filterLLMOutput(reply);
      if (!safeReply) {
        console.warn(`[engagement] Reply to ${mention.id} blocked by safety filter.`);
        await markMentionHandled(mention.id, null, { skipped: true, reason: 'safety_filter' });
        continue;
      }

      console.log(`[engagement] Replying to @${username}: ${safeReply}`);
      const replyId = await replyToTweet(safeReply, mention.id);

      await markMentionHandled(mention.id, replyId, { username, type: 'engagement' });
      await remember(
        `Engaged with @${username} who mentioned UTXO: "${safeTweet.slice(0, 100)}". My reply: "${safeReply}"`,
        'engagement_reply',
      );
    } catch (err) {
      console.error(`[engagement] Error engaging with ${mention.id}:`, err);
      // Don't mark as handled — will retry on next cycle
    }
  }

  const latestId = sorted[sorted.length - 1].id;
  await setState('last_engagement_id', latestId);
}
