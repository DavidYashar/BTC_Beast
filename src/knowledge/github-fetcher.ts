import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Fetch markdown docs from public GitHub repos and write them to the
 * knowledge/ directory so they get embedded by ingestKnowledge().
 *
 * Uses raw.githubusercontent.com (no auth needed for public repos).
 */

interface GitHubSource {
  /** Owner/repo, e.g. "utxodotfun/s402" */
  repo: string;
  /** Branch to fetch from */
  branch: string;
  /** Files to fetch (relative paths in repo) */
  files: string[];
  /** Prefix for the output filename in knowledge/ */
  prefix: string;
}

const SOURCES: GitHubSource[] = [
  {
    repo: 'utxodotfun/s402',
    branch: 'main',
    files: ['README.md'],
    prefix: 'S402-github',
  },
  {
    repo: 'utxodotfun/utxo-wallet',
    branch: 'main',
    files: ['README.md'],
    prefix: 'WALLET-github',
  },
];

const RAW_BASE = 'https://raw.githubusercontent.com';
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Fetch a single raw file from GitHub with timeout.
 */
async function fetchRawFile(repo: string, branch: string, filePath: string): Promise<string | null> {
  const url = `${RAW_BASE}/${repo}/${branch}/${filePath}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[github-fetcher] ${url} returned ${res.status}, skipping.`);
      return null;
    }
    return await res.text();
  } catch (err: any) {
    console.warn(`[github-fetcher] Failed to fetch ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch all configured GitHub sources and write .md files to knowledgeDir.
 * Returns the number of files written/updated.
 */
export async function fetchGitHubKnowledge(knowledgeDir?: string): Promise<number> {
  const dir = knowledgeDir || path.resolve(
    process.env.KNOWLEDGE_DIR || path.join(process.cwd(), 'knowledge'),
  );

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let written = 0;

  for (const source of SOURCES) {
    for (const file of source.files) {
      const content = await fetchRawFile(source.repo, source.branch, file);
      if (!content) continue;

      // e.g. "S402-github-README.md"
      const safeName = file.replace(/\//g, '-');
      const outFile = `${source.prefix}-${safeName}`;
      const outPath = path.join(dir, outFile);

      // Only write if content actually changed (avoid unnecessary re-ingestion)
      if (fs.existsSync(outPath)) {
        const existing = fs.readFileSync(outPath, 'utf-8');
        if (existing === content) {
          console.log(`[github-fetcher] ${outFile}: unchanged, skipping.`);
          continue;
        }
      }

      fs.writeFileSync(outPath, content, 'utf-8');
      console.log(`[github-fetcher] ${outFile}: updated (${content.length} chars).`);
      written++;
    }
  }

  if (written === 0) {
    console.log('[github-fetcher] All knowledge files up to date.');
  } else {
    console.log(`[github-fetcher] Updated ${written} knowledge file(s).`);
  }

  return written;
}
