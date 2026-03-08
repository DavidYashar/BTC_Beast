import * as fs from 'node:fs';
import * as path from 'node:path';
import { pool } from './db.js';
import { embedBatch, toSql } from './embeddings.js';
import { initDb } from './init-db.js';

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
 * Ingest all .md files from a directory into the knowledge table.
 * Clears existing knowledge first (idempotent re-deploy).
 */
async function ingestDirectory(dir: string): Promise<void> {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  console.log(`Found ${files.length} knowledge files in ${dir}`);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const chunks = chunkText(content);
    console.log(`  ${file}: ${chunks.length} chunks`);

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
  }
}

async function main() {
  console.log('Initializing database...');
  await initDb();

  // Clear old knowledge (idempotent)
  await pool.query('DELETE FROM knowledge');
  console.log('Cleared existing knowledge.');

  const knowledgeDir = path.resolve(
    process.env.KNOWLEDGE_DIR || path.join(process.cwd(), 'knowledge'),
  );

  if (!fs.existsSync(knowledgeDir)) {
    console.error(`Knowledge directory not found: ${knowledgeDir}`);
    process.exit(1);
  }

  await ingestDirectory(knowledgeDir);

  console.log('Knowledge ingestion complete.');
  await pool.end();
}

main().catch(err => {
  console.error('Ingestion failed:', err);
  process.exit(1);
});
