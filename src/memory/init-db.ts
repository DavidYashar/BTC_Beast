/**
 * Initialize the Postgres database with pgvector extension and tables.
 * Run this once: `npm run db:init`
 */
import 'dotenv/config';
import { getPool, closePool } from './db.js';

export async function initDb() {
  const pool = getPool();

  console.log('Initializing UTXO_Beast database...');

  // Enable pgvector extension
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');

  // Knowledge table — static docs (SOUL.md, SKILL.md, etc.)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source TEXT NOT NULL,
      chunk TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'doc',
      embedding vector(1536),
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Memories table — growing interaction history
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding vector(1536),
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Tweets posted by the agent (with embedding for dedup)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tweets_posted (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tweet_id TEXT UNIQUE NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'trending',
      embedding vector(1536),
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add embedding column if missing (for existing DBs migrating from v1)
  await pool.query(`
    ALTER TABLE tweets_posted ADD COLUMN IF NOT EXISTS embedding vector(1536)
  `).catch(() => {});

  // Token snapshots — track token progress over time
  await pool.query(`
    CREATE TABLE IF NOT EXISTS token_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ticker TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      price_sats DOUBLE PRECISION NOT NULL DEFAULT 0,
      tvl_sats DOUBLE PRECISION NOT NULL DEFAULT 0,
      volume_24h_sats DOUBLE PRECISION NOT NULL DEFAULT 0,
      price_change_24h_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      holders INTEGER NOT NULL DEFAULT 0,
      bonding_progress_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      embedding vector(1536),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Mentions we've handled (avoid double-replies)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mentions_handled (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tweet_id TEXT UNIQUE NOT NULL,
      reply_tweet_id TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Operator command log
  await pool.query(`
    CREATE TABLE IF NOT EXISTS operator_commands (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      command TEXT NOT NULL,
      payload JSONB DEFAULT '{}',
      result JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Agent state (key-value for misc state tracking)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Drop old IVFFlat indexes (broken on empty/small tables) and recreate as HNSW
  // HNSW works correctly regardless of row count, unlike IVFFlat which needs data to build centroids
  for (const idx of [
    'idx_knowledge_embedding',
    'idx_memories_embedding',
    'idx_tweets_embedding',
    'idx_token_snapshots_embedding',
  ]) {
    await pool.query(`DROP INDEX IF EXISTS ${idx}`).catch(() => {});
  }

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_embedding_hnsw
    ON knowledge USING hnsw (embedding vector_cosine_ops)
  `).catch(() => {});

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_memories_embedding_hnsw
    ON memories USING hnsw (embedding vector_cosine_ops)
  `).catch(() => {});

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tweets_embedding_hnsw
    ON tweets_posted USING hnsw (embedding vector_cosine_ops)
  `).catch(() => {});

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_token_snapshots_embedding_hnsw
    ON token_snapshots USING hnsw (embedding vector_cosine_ops)
  `).catch(() => {});

  // Regular indexes
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_tweets_type ON tweets_posted(type)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_tweets_created ON tweets_posted(created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_mentions_tweet ON mentions_handled(tweet_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_token_snapshots_ticker ON token_snapshots(ticker)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_token_snapshots_address ON token_snapshots(address)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_token_snapshots_created ON token_snapshots(created_at DESC)');

  console.log('Database initialized successfully.');
}

// Run directly if this is the main module
const isMain = process.argv[1]?.includes('init-db');
if (isMain) {
  initDb()
    .then(() => closePool())
    .catch(err => {
      console.error('Failed to initialize database:', err);
      process.exit(1);
    });
}
