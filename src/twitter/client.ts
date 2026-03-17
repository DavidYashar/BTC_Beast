import { TwitterApi, ApiResponseError } from 'twitter-api-v2';

// ── Client singleton ──

let _client: TwitterApi | null = null;

// ── Rate limiting & timeout helpers ──

const TWITTER_TIMEOUT_MS = 30_000;
const MIN_API_DELAY_MS = 2_000; // minimum gap between Twitter API calls
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 3_000;
const MAX_RATE_LIMIT_WAIT_MS = 10 * 60_000; // don't wait longer than 10 min for rate reset
let lastApiCallAt = 0;

// Global rate-limit gate: epoch seconds when the write-rate window resets
let rateLimitResetAt = 0;

// Cache our own user ID (needed for mentions endpoint)
let _myUserId: string | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function rateLimit(): Promise<void> {
  // If a previous call hit 429, wait until the reset window before proceeding
  if (rateLimitResetAt > 0) {
    const waitMs = rateLimitResetAt * 1000 - Date.now();
    if (waitMs > 0 && waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
      console.log(`[twitter] Rate-limited — waiting ${Math.ceil(waitMs / 1000)}s until reset...`);
      await new Promise((r) => setTimeout(r, waitMs + 1_000)); // +1s buffer
      rateLimitResetAt = 0;
    } else if (waitMs > MAX_RATE_LIMIT_WAIT_MS) {
      throw new Error(`Rate limit resets in ${Math.ceil(waitMs / 60_000)}min — too long to wait`);
    }
  }

  const now = Date.now();
  const elapsed = now - lastApiCallAt;
  if (elapsed < MIN_API_DELAY_MS) {
    await new Promise((r) => setTimeout(r, MIN_API_DELAY_MS - elapsed));
  }
  lastApiCallAt = Date.now();
}

function is429Error(err: unknown): number | null {
  if (err instanceof ApiResponseError && err.code === 429) {
    return err.rateLimit?.reset ?? null;
  }
  return null;
}

function isAuthError(err: unknown): boolean {
  const msg = String(err);
  return /401|403|Unauthorized|Forbidden|authentication|auth/i.test(msg);
}

function getClient(): TwitterApi {
  if (!_client) {
    const apiKey = process.env.TWITTER_API_KEY;
    const apiSecret = process.env.TWITTER_API_SECRET;
    const accessToken = process.env.TWITTER_ACCESS_TOKEN;
    const accessSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET;

    if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
      throw new Error(
        'Twitter API v2 credentials required: TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET',
      );
    }

    _client = new TwitterApi({
      appKey: apiKey,
      appSecret: apiSecret,
      accessToken,
      accessSecret,
    });

    console.log('[twitter] Twitter API v2 client initialized (OAuth 1.0a User Context).');
  }
  return _client;
}

/**
 * Get our own user ID (cached after first call).
 */
async function getMyUserId(): Promise<string> {
  if (_myUserId) return _myUserId;
  const client = getClient();
  await rateLimit();
  const me = await withTimeout(client.v2.me(), TWITTER_TIMEOUT_MS, 'getMyUserId');
  _myUserId = me.data.id;
  console.log(`[twitter] Resolved own user ID: ${_myUserId}`);
  return _myUserId;
}

/**
 * Force re-create the Twitter client (picks up fresh env vars).
 */
export function resetClient(): void {
  _client = null;
  _myUserId = null;
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

      // On 429, store the global reset timestamp so ALL callers respect it
      const resetEpoch = is429Error(err);
      if (resetEpoch) {
        rateLimitResetAt = resetEpoch;
        const waitSec = Math.max(0, resetEpoch - Math.floor(Date.now() / 1000));
        console.warn(
          `[twitter] ${label} hit 429 rate limit — resets in ${waitSec}s (attempt ${attempt}/${MAX_RETRIES})`,
        );
        if (isLast) break;
        // Wait until reset + 1s buffer instead of blind backoff
        const waitMs = waitSec * 1000 + 1_000;
        if (waitMs > MAX_RATE_LIMIT_WAIT_MS) {
          console.warn(`[twitter] ${label} rate limit wait too long (${waitSec}s) — giving up.`);
          break;
        }
        console.log(`[twitter] ${label} waiting ${waitSec + 1}s for rate limit reset...`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      console.error(`[twitter] ${label} attempt ${attempt}/${MAX_RETRIES} failed:`, err);

      if (isLast) break;

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
    const result = await withTimeout(client.v2.tweet(text), TWITTER_TIMEOUT_MS, 'postTweet');
    if (!result?.data?.id) {
      throw new Error('Failed to post tweet — no ID returned');
    }
    const id = result.data.id;
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
    const result = await withTimeout(
      client.v2.reply(text, inReplyToId),
      TWITTER_TIMEOUT_MS,
      'replyToTweet',
    );
    if (!result?.data?.id) {
      throw new Error('Failed to post reply — no ID returned');
    }
    const id = result.data.id;
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
 * Uses GET /2/users/:id/mentions with author expansion.
 * Returns empty array on errors to avoid crashing the cron.
 */
export async function fetchMentions(sinceId?: string): Promise<Mention[]> {
  try {
    const client = getClient();
    const myId = await getMyUserId();

    await rateLimit();
    const result = await withTimeout(
      client.v2.userMentionTimeline(myId, {
        max_results: 20,
        ...(sinceId ? { since_id: sinceId } : {}),
        'tweet.fields': ['created_at', 'author_id'],
        expansions: ['author_id'],
        'user.fields': ['username'],
      }),
      TWITTER_TIMEOUT_MS,
      'fetchMentions',
    );

    // Build author_id → username map from expansions
    const userMap = new Map<string, string>();
    if (result.includes?.users) {
      for (const user of result.includes.users) {
        userMap.set(user.id, user.username);
      }
    }

    return (result.data?.data ?? []).map((tweet) => ({
      id: tweet.id,
      text: tweet.text,
      authorId: tweet.author_id ?? '',
      username: tweet.author_id ? userMap.get(tweet.author_id) : undefined,
      createdAt: tweet.created_at,
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
 * Uses GET /2/tweets/search/recent with author expansion.
 * Returns empty array on errors to avoid crashing the cron.
 */
export async function searchUtxoMentions(sinceId?: string): Promise<Mention[]> {
  const myUsername = process.env.TWITTER_USERNAME || '';
  const seenIds = new Set<string>();
  const allMentions: Mention[] = [];

  // Combine search terms into one query to conserve the 10K/month search quota
  const query = `(utxo.fun OR "UTXO Exchange")${myUsername ? ` -from:${myUsername}` : ''}`;

  try {
    const client = getClient();
    await rateLimit();
    const result = await withTimeout(
      client.v2.search(query, {
        max_results: 20,
        ...(sinceId ? { since_id: sinceId } : {}),
        'tweet.fields': ['created_at', 'author_id'],
        expansions: ['author_id'],
        'user.fields': ['username'],
      }),
      TWITTER_TIMEOUT_MS,
      'searchUtxoMentions',
    );

    // Build author_id → username map from expansions
    const userMap = new Map<string, string>();
    if (result.includes?.users) {
      for (const user of result.includes.users) {
        userMap.set(user.id, user.username);
      }
    }

    for (const tweet of result.data?.data ?? []) {
      if (seenIds.has(tweet.id)) continue;
      seenIds.add(tweet.id);
      allMentions.push({
        id: tweet.id,
        text: tweet.text,
        authorId: tweet.author_id ?? '',
        username: tweet.author_id ? userMap.get(tweet.author_id) : undefined,
        createdAt: tweet.created_at,
      });
    }
  } catch (err) {
    console.error(`[twitter] searchUtxoMentions failed:`, err);
    if (isAuthError(err)) {
      resetClient();
      console.warn('[twitter] searchUtxoMentions: auth error — client reset.');
    }
  }

  return allMentions;
}

/**
 * Look up a username by user ID.
 * Now works properly with Twitter API v2.
 */
export async function getUsernameById(userId: string): Promise<string> {
  try {
    const client = getClient();
    await rateLimit();
    const result = await withTimeout(
      client.v2.user(userId, { 'user.fields': ['username'] }),
      TWITTER_TIMEOUT_MS,
      'getUsernameById',
    );
    if (result.data?.username) {
      return result.data.username;
    }
    console.warn(`[twitter] getUsernameById: no username in response for ID ${userId}`);
    return `user_${userId}`;
  } catch (err) {
    console.error(`[twitter] getUsernameById failed for ${userId}:`, err);
    return `user_${userId}`;
  }
}
