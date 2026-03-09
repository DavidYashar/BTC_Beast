/**
 * Wallet persistence — stores wallet files in Postgres so they survive
 * Render's ephemeral filesystem across deploys.
 *
 * Stores: .wallet.json, .wallet.key, .session.json
 */
import { getPool } from '../memory/db.js';
import * as fs from 'fs';
import * as path from 'path';

const WALLET_DIR = path.resolve('skills/utxo_wallet');

const WALLET_FILES = ['.wallet.json', '.wallet.key', '.session.json'] as const;

/**
 * Ensure the agent_wallet_files table exists.
 */
export async function initWalletStore(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_wallet_files (
      filename TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

/**
 * Save a wallet file to both disk and Postgres.
 */
export async function persistWalletFile(filename: string, content: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO agent_wallet_files (filename, content, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (filename) DO UPDATE SET content = $2, updated_at = NOW()`,
    [filename, content],
  );
}

/**
 * Restore wallet files from Postgres to disk.
 * Returns true if a wallet was restored (agent has been provisioned before).
 */
export async function restoreWalletFiles(): Promise<boolean> {
  const pool = getPool();
  const { rows } = await pool.query<{ filename: string; content: string }>(
    'SELECT filename, content FROM agent_wallet_files',
  );

  if (rows.length === 0) return false;

  let hasWallet = false;
  for (const row of rows) {
    const filePath = path.join(WALLET_DIR, row.filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, row.content, { mode: 0o600 });
    if (row.filename === '.wallet.json') hasWallet = true;
  }

  return hasWallet;
}

/**
 * Read wallet files from disk and persist them to Postgres.
 * Called after provision/connect to back up new files.
 */
export async function backupWalletFiles(): Promise<void> {
  for (const filename of WALLET_FILES) {
    const filePath = path.join(WALLET_DIR, filename);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      await persistWalletFile(filename, content);
    }
  }
}

/**
 * Get the session data from disk, or null if not available.
 */
export function readSessionFile(): { session_token: string; spark_address: string; network: string; connected_at: string; idle_timeout_minutes: number; base_url: string } | null {
  const sessionPath = path.join(WALLET_DIR, '.session.json');
  if (!fs.existsSync(sessionPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Check if wallet exists on disk.
 */
export function walletExistsOnDisk(): boolean {
  return fs.existsSync(path.join(WALLET_DIR, '.wallet.json'));
}
