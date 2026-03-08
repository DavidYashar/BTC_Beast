import { pool } from './db.js';
import { embedText, toSql } from './embeddings.js';

// ──────────────────────────────────────────────
// Store knowledge (static docs, refreshed on deploy)
// ──────────────────────────────────────────────

export async function storeKnowledge(
  source: string,
  chunk: string,
  type: string = 'doc',
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const embedding = await embedText(chunk);
  await pool.query(
    `INSERT INTO knowledge (source, chunk, type, embedding, metadata)
     VALUES ($1, $2, $3, $4::vector, $5)
     ON CONFLICT DO NOTHING`,
    [source, chunk, type, toSql(embedding), JSON.stringify(metadata)],
  );
}

// ──────────────────────────────────────────────
// Store a memory (grows with interactions)
// ──────────────────────────────────────────────

export async function remember(
  content: string,
  type: string = 'interaction',
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const embedding = await embedText(content);
  await pool.query(
    `INSERT INTO memories (content, type, embedding, metadata)
     VALUES ($1, $2, $3::vector, $4)`,
    [content, type, toSql(embedding), JSON.stringify(metadata)],
  );
}

// ──────────────────────────────────────────────
// Recall: cosine-similarity search across both tables
// ──────────────────────────────────────────────

interface RecallResult {
  text: string;
  source: string;
  similarity: number;
  table: 'knowledge' | 'memories';
}

export async function recall(
  query: string,
  limit: number = 5,
): Promise<RecallResult[]> {
  const embedding = await embedText(query);
  const vec = toSql(embedding);

  // Search knowledge + memories in parallel, merge by similarity
  const [knowledgeRes, memoriesRes] = await Promise.all([
    pool.query(
      `SELECT chunk AS text, source, 1 - (embedding <=> $1::vector) AS similarity
       FROM knowledge
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vec, limit],
    ),
    pool.query(
      `SELECT content AS text, type AS source, 1 - (embedding <=> $1::vector) AS similarity
       FROM memories
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vec, limit],
    ),
  ]);

  const results: RecallResult[] = [
    ...knowledgeRes.rows.map((r: any) => ({ ...r, table: 'knowledge' as const })),
    ...memoriesRes.rows.map((r: any) => ({ ...r, table: 'memories' as const })),
  ];

  return results
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

// ──────────────────────────────────────────────
// Tweet tracking helpers
// ──────────────────────────────────────────────

export async function recordTweet(
  tweetId: string,
  content: string,
  type: string = 'trending',
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO tweets_posted (tweet_id, content, type, metadata)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tweet_id) DO NOTHING`,
    [tweetId, content, type, JSON.stringify(metadata)],
  );
}

export async function isMentionHandled(tweetId: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM mentions_handled WHERE tweet_id = $1`,
    [tweetId],
  );
  return res.rowCount! > 0;
}

export async function markMentionHandled(
  tweetId: string,
  replyId: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO mentions_handled (tweet_id, reply_tweet_id, metadata)
     VALUES ($1, $2, $3)
     ON CONFLICT (tweet_id) DO NOTHING`,
    [tweetId, replyId, JSON.stringify(metadata)],
  );
}

// ──────────────────────────────────────────────
// Agent state (key-value)
// ──────────────────────────────────────────────

export async function getState(key: string): Promise<string | null> {
  const res = await pool.query(
    `SELECT value FROM agent_state WHERE key = $1`,
    [key],
  );
  return res.rows[0]?.value ?? null;
}

export async function setState(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO agent_state (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value],
  );
}
