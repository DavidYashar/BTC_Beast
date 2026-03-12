import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { pool } from './db.js';
import { embedBatch, toSql } from './embeddings.js';

const CHUNK_SIZE = 800; // characters per chunk (with overlap)
const CHUNK_OVERLAP = 100;

/**
 * Split a document into overlapping chunks.
 */
function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

/**
 * Compute a hash of all knowledge files to detect changes.
 */
function hashDirectory(dir: string): string {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update(fs.readFileSync(path.join(dir, file), 'utf-8'));
  }
  return hash.digest('hex');
}

/**
 * Ingest all .md files from a directory into the knowledge table.
 */
async function ingestDirectory(dir: string): Promise<number> {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  console.log(`[knowledge] Found ${files.length} knowledge files in ${dir}`);
  let totalChunks = 0;

  for (const file of files) {
    const filePath = path.join(dir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const chunks = chunkText(content);
    console.log(`[knowledge]   ${file}: ${chunks.length} chunks`);

    // Embed all chunks for this file in one batch call
    const embeddings = await embedBatch(chunks);

    for (let i = 0; i < chunks.length; i++) {
      await pool.query(
        `INSERT INTO knowledge (source, chunk, type, embedding, metadata)
         VALUES ($1, $2, $3, $4::vector, $5)`,
        [
          file,
          chunks[i],
          'doc',
          toSql(embeddings[i]),
          JSON.stringify({ file, chunkIndex: i, totalChunks: chunks.length }),
        ],
      );
    }
    totalChunks += chunks.length;
  }
  return totalChunks;
}

/**
 * Load knowledge files into the database on startup.
 * Only re-ingests when files have changed (compares content hash).
 */
export async function ingestKnowledge(): Promise<void> {
  const knowledgeDir = path.resolve(
    process.env.KNOWLEDGE_DIR || path.join(process.cwd(), 'knowledge'),
  );

  if (!fs.existsSync(knowledgeDir)) {
    console.log('[knowledge] Knowledge directory not found, skipping ingestion.');
    return;
  }

  const currentHash = hashDirectory(knowledgeDir);

  // Check stored hash to avoid re-embedding on every restart
  const res = await pool.query(
    `SELECT value FROM agent_state WHERE key = 'knowledge_hash'`,
  );
  const storedHash = res.rows[0]?.value;

  if (storedHash === currentHash) {
    const countRes = await pool.query('SELECT COUNT(*)::int AS c FROM knowledge');
    console.log(`[knowledge] Up to date (${countRes.rows[0].c} chunks). Skipping ingestion.`);
    return;
  }

  console.log('[knowledge] Files changed — re-ingesting...');
  await pool.query('DELETE FROM knowledge');

  const totalChunks = await ingestDirectory(knowledgeDir);

  // Store hash so we skip next time
  await pool.query(
    `INSERT INTO agent_state (key, value) VALUES ('knowledge_hash', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [currentHash],
  );

  console.log(`[knowledge] Ingestion complete: ${totalChunks} chunks embedded.`);
}
