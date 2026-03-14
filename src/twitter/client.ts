import { Rettiwt, TweetFilter } from 'rettiwt-api';

let _client: Rettiwt | null = null;

// ── Rate limiting & timeout helpers ──

const TWITTER_TIMEOUT_MS = 30_000;
const MIN_API_DELAY_MS = 2_000; // minimum gap between Twitter API calls
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 3_000;
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

function isAuthError(err: unknown): boolean {
  const msg = String(err);
  return /401|403|NOT_FOUND|Authentication|Unauthorized|cookie|auth/i.test(msg);
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
 * Force re-create the Rettiwt client (picks up fresh env var).
 */
export function resetClient(): void {
  _client = null;
  console.log('[twitter] Client reset — will reinitialize on next call.');
}

/**
 * Retry helper with exponential backoff and client reset on auth errors.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = attempt === MAX_RETRIES;
      console.error(`[twitter] ${label} attempt ${attempt}/${MAX_RETRIES} failed:`, err);

      if (isLast) break;

      // On auth-related failures, reset client so next attempt gets fresh cookies
      if (isAuthError(err)) {
        resetClient();
      }

      const delay = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
      console.log(`[twitter] ${label} retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Post a tweet. Returns the tweet ID.
 * Retries up to 3 times with exponential backoff.
 */
export async function postTweet(text: string): Promise<string> {
  return withRetry('postTweet', async () => {
    const client = getClient();
    await rateLimit();
    const result = await withTimeout(client.tweet.post({ text }), TWITTER_TIMEOUT_MS, 'postTweet');
    console.log(`[twitter] postTweet raw result:`, typeof result, result);
    if (!result) {
      // Reset client — the cookie may be stale
      resetClient();
      throw new Error('Failed to post tweet — no ID returned (possible auth issue)');
    }
    const id = String(result);
    console.log(`[twitter] Tweet posted: ${id}`);
    return id;
  });
}

/**
 * Reply to a tweet. Returns the reply tweet ID.
 * Retries up to 3 times with exponential backoff.
 */
export async function replyToTweet(text: string, inReplyToId: string): Promise<string> {
  return withRetry('replyToTweet', async () => {
    const client = getClient();
    await rateLimit();
    const result = await withTimeout(client.tweet.post({ text, replyTo: inReplyToId }), TWITTER_TIMEOUT_MS, 'replyToTweet');
    console.log(`[twitter] replyToTweet raw result:`, typeof result, result);
    if (!result) {
      resetClient();
      throw new Error('Failed to post reply — no ID returned (possible auth issue)');
    }
    const id = String(result);
    console.log(`[twitter] Reply posted: ${id}`);
    return id;
  });
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
 * Returns empty array on auth/search errors to avoid crashing the cron.
 */
export async function fetchMentions(sinceId?: string): Promise<Mention[]> {
  const username = process.env.TWITTER_USERNAME;
  if (!username) return [];

  try {
    const client = getClient();
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
  } catch (err) {
    console.error('[twitter] fetchMentions failed:', err);
    if (isAuthError(err)) {
      resetClient();
      console.warn('[twitter] fetchMentions: auth error — client reset, returning empty results.');
    }
    return [];
  }
}

/**
 * Search recent tweets mentioning "utxo.fun" (not direct @mentions).
 * Returns empty array on auth/search errors to avoid crashing the cron.
 */
export async function searchUtxoMentions(sinceId?: string): Promise<Mention[]> {
  const myUsername = process.env.TWITTER_USERNAME || '';
  const seenIds = new Set<string>();
  const allMentions: Mention[] = [];

  // Search for multiple terms to catch broader engagement opportunities
  const searchTerms = ['utxo.fun', '"UTXO Exchange"'];

  for (const term of searchTerms) {
    try {
      const client = getClient();
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
    } catch (err) {
      console.error(`[twitter] searchUtxoMentions("${term}") failed:`, err);
      if (isAuthError(err)) {
        resetClient();
        console.warn('[twitter] searchUtxoMentions: auth error — client reset, skipping term.');
      }
      // Continue to next search term
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
