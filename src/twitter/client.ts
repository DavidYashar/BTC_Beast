import { Rettiwt, TweetFilter } from 'rettiwt-api';

let _client: Rettiwt | null = null;

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
  const id = await client.tweet.post({ text });
  if (!id) throw new Error('Failed to post tweet — no ID returned');
  console.log(`[twitter] Tweet posted: ${id}`);
  return id;
}

/**
 * Reply to a tweet. Returns the reply tweet ID.
 */
export async function replyToTweet(text: string, inReplyToId: string): Promise<string> {
  const client = getClient();
  const id = await client.tweet.post({ text, replyTo: inReplyToId });
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

  const results = await client.tweet.search(filter, 20);

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

  const filter: TweetFilter = {
    includeWords: ['utxo.fun'],
    excludeWords: [],
  } as TweetFilter;
  if (sinceId) (filter as any).sinceId = sinceId;

  const results = await client.tweet.search(filter, 20);

  return results.list
    .filter((tweet) => tweet.tweetBy.userName.toLowerCase() !== myUsername.toLowerCase())
    .map((tweet) => ({
      id: tweet.id,
      text: tweet.fullText,
      authorId: tweet.tweetBy.id,
      username: tweet.tweetBy.userName,
      createdAt: tweet.createdAt,
    }));
}

/**
 * Look up a username by user ID.
 */
export async function getUsernameById(userId: string): Promise<string> {
  // rettiwt-api's user.details() takes username, not ID.
  // Mentions already include username from search results.
  return userId;
}
