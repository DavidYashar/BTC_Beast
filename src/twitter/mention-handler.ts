import { chat } from '../llm/client.js';
import { SYSTEM_PROMPT, MENTION_REPLY_PROMPT } from '../personality/prompts.js';
import { fetchMentions, replyToTweet, getUsernameById } from './client.js';
import { recall, remember, isMentionHandled, markMentionHandled, getState, setState } from '../memory/store.js';
import { sanitizeMentionInput, filterLLMOutput } from './safety.js';

/**
 * Poll direct @mentions, generate RAG-enhanced replies.
 */
export async function handleMentions(): Promise<void> {
  console.log('[mentions] Checking for new mentions...');

  const sinceId = await getState('last_mention_id');
  const mentions = await fetchMentions(sinceId ?? undefined);

  if (mentions.length === 0) {
    console.log('[mentions] No new mentions.');
    return;
  }

  console.log(`[mentions] Found ${mentions.length} new mentions.`);

  // Process oldest-first
  const sorted = [...mentions].reverse();

  for (const mention of sorted) {
    // Skip if already handled
    if (await isMentionHandled(mention.id)) continue;

    try {
      const username = mention.username || await getUsernameById(mention.authorId);

      // RAG lookup for relevant context
      const memories = await recall(mention.text, 5);
      const context = memories.map(m => m.text).join('\n---\n');

      const safeTweet = sanitizeMentionInput(mention.text);
      const prompt = MENTION_REPLY_PROMPT
        .replace('{context}', context || 'No specific context found.')
        .replace('{username}', username)
        .replace('{tweet}', safeTweet);

      const reply = await chat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        { temperature: 0.8, maxTokens: 280 },
      );

      if (!reply || reply.length > 280) {
        console.log(`[mentions] Reply too long or empty for ${mention.id}, skipping.`);
        await markMentionHandled(mention.id, null, { skipped: true, reason: 'invalid_reply' });
        continue;
      }

      const safeReply = filterLLMOutput(reply);
      if (!safeReply) {
        console.warn(`[mentions] Reply to ${mention.id} blocked by safety filter.`);
        await markMentionHandled(mention.id, null, { skipped: true, reason: 'safety_filter' });
        continue;
      }

      console.log(`[mentions] Replying to @${username}: ${safeReply}`);
      const replyId = await replyToTweet(safeReply, mention.id);

      await markMentionHandled(mention.id, replyId, { username });
      await remember(
        `Replied to @${username} who said: "${safeTweet.slice(0, 100)}". My reply: "${safeReply}"`,
        'mention_reply',
      );
    } catch (err) {
      console.error(`[mentions] Error handling mention ${mention.id}:`, err);
      // Don't mark as handled — will retry on next cycle
    }
  }

  // Track the latest mention ID for next poll
  const latestId = sorted[sorted.length - 1].id;
  await setState('last_mention_id', latestId);
}
