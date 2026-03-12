import { Rettiwt, TweetFilter } from 'rettiwt-api';

let _client: Rettiwt | null = null;

// ── Rate limiting & timeout helpers ──

const TWITTER_TIMEOUT_MS = 30_000;
const MIN_API_DELAY_MS = 2_000; // minimum gap between Twitter API calls
let lastApiCallAt = 0;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastApiCallAt;
  if (elapsed < MIN_API_DELAY_MS) {
    await new Promise((r) => setTimeout(r, MIN_API_DELAY_MS - elapsed));
  }
  lastApiCallAt = Date.now();
}

function getClient(): Rettiwt {
  if (!_client) {
    const apiKey = process.env.RETTIWT_API_KEY;
    if (!apiKey) {
      throw new Error('RETTIWT_API_KEY is required (base64-encoded Twitter cookies)');
    }
    _client = new Rettiwt({ apiKey });
    console.log('[twitter] Rettiwt client initialized.');
  }
  return _client;
}

/**
 * Post a tweet. Returns the tweet ID.
 */
export async function postTweet(text: string): Promise<string> {
  const client = getClient();
  await rateLimit();
  const id = await withTimeout(client.tweet.post({ text }), TWITTER_TIMEOUT_MS, 'postTweet');
  if (!id) throw new Error('Failed to post tweet — no ID returned');
  console.log(`[twitter] Tweet posted: ${id}`);
  return id;
}

/**
 * Reply to a tweet. Returns the reply tweet ID.
 */
export async function replyToTweet(text: string, inReplyToId: string): Promise<string> {
  const client = getClient();
  await rateLimit();
  const id = await withTimeout(client.tweet.post({ text, replyTo: inReplyToId }), TWITTER_TIMEOUT_MS, 'replyToTweet');
  if (!id) throw new Error('Failed to post reply — no ID returned');
  console.log(`[twitter] Reply posted: ${id}`);
  return id;
}

export interface Mention {
  id: string;
  text: string;
  authorId: string;
  username?: string;
  createdAt?: string;
}

/**
 * Fetch recent mentions of the bot's account.
 */
export async function fetchMentions(sinceId?: string): Promise<Mention[]> {
  const client = getClient();
  const username = process.env.TWITTER_USERNAME;
  if (!username) return [];

  const filter: TweetFilter = { mentions: [username] } as TweetFilter;
  if (sinceId) (filter as any).sinceId = sinceId;

  await rateLimit();
  const results = await withTimeout(client.tweet.search(filter, 20), TWITTER_TIMEOUT_MS, 'fetchMentions');

  return results.list.map((tweet) => ({
    id: tweet.id,
    text: tweet.fullText,
    authorId: tweet.tweetBy.id,
    username: tweet.tweetBy.userName,
    createdAt: tweet.createdAt,
  }));
}

/**
 * Search recent tweets mentioning "utxo.fun" (not direct @mentions).
 */
export async function searchUtxoMentions(sinceId?: string): Promise<Mention[]> {
  const client = getClient();
  const myUsername = process.env.TWITTER_USERNAME || '';
  const seenIds = new Set<string>();
  const allMentions: Mention[] = [];

  // Search for multiple terms to catch broader engagement opportunities
  const searchTerms = ['utxo.fun', '"UTXO Exchange"'];

  for (const term of searchTerms) {
    const filter: TweetFilter = {
      includeWords: [term],
      excludeWords: [],
    } as TweetFilter;
    if (sinceId) (filter as any).sinceId = sinceId;

    await rateLimit();
    const results = await withTimeout(client.tweet.search(filter, 20), TWITTER_TIMEOUT_MS, 'searchUtxoMentions');

    for (const tweet of results.list) {
      if (tweet.tweetBy.userName.toLowerCase() === myUsername.toLowerCase()) continue;
      if (seenIds.has(tweet.id)) continue;
      seenIds.add(tweet.id);
      allMentions.push({
        id: tweet.id,
        text: tweet.fullText,
        authorId: tweet.tweetBy.id,
        username: tweet.tweetBy.userName,
        createdAt: tweet.createdAt,
      });
    }
  }

  return allMentions;
}

/**
 * Look up a username by user ID.
 */
export async function getUsernameById(userId: string): Promise<string> {
  // rettiwt-api's user.details() takes username, not ID.
  // Mentions should always include username from search results.
  // If we only have the ID, log a warning and return a safe fallback.
  console.warn(`[twitter] getUsernameById called with raw ID: ${userId} — mention may be missing username field`);
  return `user_${userId}`;
}
