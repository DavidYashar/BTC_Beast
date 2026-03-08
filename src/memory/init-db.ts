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

  // Tweets posted by the agent
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tweets_posted (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tweet_id TEXT UNIQUE NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'trending',
      metadata JSONB DEFAULT '{}',
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

  // Create vector similarity indexes
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_embedding
    ON knowledge USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 50)
  `).catch(() => {
    // IVFFlat needs rows to build — create after first ingest
    console.log('Note: IVFFlat index deferred (needs data first). Will use sequential scan.');
  });

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_memories_embedding
    ON memories USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100)
  `).catch(() => {
    console.log('Note: Memories IVFFlat index deferred. Will use sequential scan.');
  });

  // Regular indexes
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_tweets_type ON tweets_posted(type)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_tweets_created ON tweets_posted(created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_mentions_tweet ON mentions_handled(tweet_id)');

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
