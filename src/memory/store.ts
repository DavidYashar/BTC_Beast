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

  // Search knowledge, memories, past tweets, and token snapshots in parallel
  const [knowledgeRes, memoriesRes, tweetsRes, tokenRes] = await Promise.all([
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
    pool.query(
      `SELECT content AS text, 'past_tweet' AS source, 1 - (embedding <=> $1::vector) AS similarity
       FROM tweets_posted
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vec, Math.min(limit, 3)],
    ),
    pool.query(
      `SELECT
         '$' || ticker || ' ' || name || ' — ' || price_sats || ' sats, ' ||
         CASE WHEN price_change_24h_pct >= 0
           THEN '+' || ROUND(price_change_24h_pct::numeric, 1) || '%'
           ELSE ROUND(price_change_24h_pct::numeric, 1) || '%'
         END || ' 24h, ' || holders || ' holders, ' ||
         CASE WHEN bonding_progress_pct < 100
           THEN 'bonding ' || ROUND(bonding_progress_pct::numeric, 0) || '%'
           ELSE 'migrated'
         END AS text,
         'token_snapshot' AS source,
         1 - (embedding <=> $1::vector) AS similarity
       FROM token_snapshots
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vec, Math.min(limit, 3)],
    ),
  ]);

  const results: RecallResult[] = [
    ...knowledgeRes.rows.map((r: any) => ({ ...r, table: 'knowledge' as const })),
    ...memoriesRes.rows.map((r: any) => ({ ...r, table: 'memories' as const })),
    ...tweetsRes.rows.map((r: any) => ({ ...r, table: 'knowledge' as const })),
    ...tokenRes.rows.map((r: any) => ({ ...r, table: 'knowledge' as const })),
  ];

  return results
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

// ──────────────────────────────────────────────
// Tweet tracking helpers (with embedding for dedup)
// ──────────────────────────────────────────────

export async function recordTweet(
  tweetId: string,
  content: string,
  type: string = 'trending',
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const embedding = await embedText(content);
  await pool.query(
    `INSERT INTO tweets_posted (tweet_id, content, type, embedding, metadata)
     VALUES ($1, $2, $3, $4::vector, $5)
     ON CONFLICT (tweet_id) DO NOTHING`,
    [tweetId, content, type, toSql(embedding), JSON.stringify(metadata)],
  );
}

/**
 * Check if a candidate tweet is too similar to recent tweets.
 * Returns the similarity score of the closest match (0-1), or 0 if no tweets exist.
 */
export async function isTweetTooSimilar(
  candidateText: string,
  threshold: number = 0.85,
  lookbackHours: number = 48,
): Promise<{ tooSimilar: boolean; similarity: number; matchedTweet?: string }> {
  const embedding = await embedText(candidateText);
  const vec = toSql(embedding);

  const res = await pool.query(
    `SELECT content, 1 - (embedding <=> $1::vector) AS similarity
     FROM tweets_posted
     WHERE embedding IS NOT NULL
       AND created_at > NOW() - make_interval(hours => $2::int)
     ORDER BY embedding <=> $1::vector
     LIMIT 1`,
    [vec, lookbackHours],
  );

  if (res.rows.length === 0) {
    return { tooSimilar: false, similarity: 0 };
  }

  const { content, similarity } = res.rows[0];
  return {
    tooSimilar: similarity >= threshold,
    similarity: parseFloat(similarity),
    matchedTweet: content,
  };
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
// Token snapshot tracking
// ──────────────────────────────────────────────

export interface TokenSnapshotInput {
  ticker: string;
  name: string;
  address: string;
  price_sats: number;
  tvl_sats: number;
  volume_24h_sats: number;
  price_change_24h_pct: number;
  holders: number;
  bonding_progress_pct: number;
}

/**
 * Record a token snapshot with embedding for semantic search.
 * The embedding text includes key metrics so the bot can recall
 * "that token that was about to migrate" or "the one pumping 200%".
 */
export async function recordTokenSnapshot(
  token: TokenSnapshotInput,
): Promise<void> {
  const status = token.bonding_progress_pct < 100
    ? `bonding ${token.bonding_progress_pct.toFixed(0)}%`
    : 'migrated';
  const change = token.price_change_24h_pct >= 0
    ? `+${token.price_change_24h_pct.toFixed(1)}%`
    : `${token.price_change_24h_pct.toFixed(1)}%`;

  const embeddingText = `$${token.ticker} (${token.name}) — ${token.price_sats} sats, ${change} 24h, ${token.holders} holders, ${status}, TVL ${token.tvl_sats} sats`;
  const embedding = await embedText(embeddingText);

  await pool.query(
    `INSERT INTO token_snapshots
     (ticker, name, address, price_sats, tvl_sats, volume_24h_sats,
      price_change_24h_pct, holders, bonding_progress_pct, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector)`,
    [
      token.ticker, token.name, token.address,
      token.price_sats, token.tvl_sats, token.volume_24h_sats,
      token.price_change_24h_pct, token.holders, token.bonding_progress_pct,
      toSql(embedding),
    ],
  );
}

/**
 * Record snapshots for a batch of tokens (e.g., from trending fetch).
 * Skips tokens already snapshotted in the last `dedupeHours`.
 */
export async function recordTokenSnapshots(
  tokens: TokenSnapshotInput[],
  dedupeHours: number = 3,
): Promise<number> {
  let recorded = 0;
  for (const token of tokens) {
    // Skip if we already have a recent snapshot for this ticker
    const existing = await pool.query(
      `SELECT 1 FROM token_snapshots
       WHERE ticker = $1 AND created_at > NOW() - make_interval(hours => $2::int)
       LIMIT 1`,
      [token.ticker, dedupeHours],
    );
    if (existing.rowCount! > 0) continue;

    await recordTokenSnapshot(token);
    recorded++;
  }
  return recorded;
}

/**
 * Get recent history for a specific token.
 */
export async function getTokenHistory(
  ticker: string,
  limit: number = 10,
): Promise<TokenSnapshotInput[]> {
  const res = await pool.query(
    `SELECT ticker, name, address, price_sats, tvl_sats, volume_24h_sats,
            price_change_24h_pct, holders, bonding_progress_pct
     FROM token_snapshots
     WHERE ticker = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [ticker, limit],
  );
  return res.rows;
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
