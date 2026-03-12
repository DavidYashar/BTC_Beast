import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000 });

/**
 * Embed text using OpenAI text-embedding-3-small (1536 dimensions).
 */
export async function embedText(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
}

const EMBED_BATCH_SIZE = 50;

/**
 * Embed multiple texts in batched API calls.
 * Chunks into groups of 50 to stay within OpenAI limits.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: batch,
    });
    results.push(...response.data.map(d => d.embedding));
  }
  return results;
}

/**
 * Format a vector for pgvector insertion.
 */
export function toSql(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
