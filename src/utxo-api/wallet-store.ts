/**
 * Wallet persistence — stores wallet files in Postgres so they survive
 * Render's ephemeral filesystem across deploys.
 *
 * Stores: .wallet.json, .wallet.key
 * (.session.json is no longer persisted — sessions are short-lived and
 *  recreated on startup via wallet-connect.)
 *
 * SECURITY: .wallet.key is envelope-encrypted with WALLET_ENCRYPTION_KEY
 * before being stored in the database.
 */
import { getPool } from '../memory/db.js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const WALLET_DIR = path.resolve('skills/utxo_wallet');

const WALLET_FILES = ['.wallet.json', '.wallet.key'] as const;

// ---------------------------------------------------------------------------
// Envelope encryption helpers — AES-256-GCM keyed by WALLET_ENCRYPTION_KEY
// ---------------------------------------------------------------------------
function getEnvelopeKey(): Buffer {
  const hex = process.env.WALLET_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'WALLET_ENCRYPTION_KEY env var must be a 64-char hex string (32 bytes). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return Buffer.from(hex, 'hex');
}

function envelopeEncrypt(plaintext: string): string {
  const key = getEnvelopeKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv):base64(tag):base64(ciphertext)
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function envelopeDecrypt(payload: string): string {
  const key = getEnvelopeKey();
  const [ivB64, tagB64, ctB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error('Invalid envelope-encrypted payload format');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

/** Returns true if the payload looks like an envelope-encrypted string. */
function isEnvelopeEncrypted(content: string): boolean {
  const parts = content.split(':');
  return parts.length === 3 && parts.every(p => p.length > 0);
}

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
 * .wallet.key is envelope-encrypted before DB storage.
 */
export async function persistWalletFile(filename: string, content: string): Promise<void> {
  const pool = getPool();
  const dbContent = filename === '.wallet.key' ? envelopeEncrypt(content) : content;
  await pool.query(
    `INSERT INTO agent_wallet_files (filename, content, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (filename) DO UPDATE SET content = $2, updated_at = NOW()`,
    [filename, dbContent],
  );
}

/**
 * Restore wallet files from Postgres to disk.
 * Returns true if a wallet was restored (agent has been provisioned before).
 * .wallet.key is envelope-decrypted on restore.
 */
export async function restoreWalletFiles(): Promise<boolean> {
  const pool = getPool();
  const { rows } = await pool.query<{ filename: string; content: string }>(
    'SELECT filename, content FROM agent_wallet_files',
  );

  if (rows.length === 0) return false;

  let hasWallet = false;
  for (const row of rows) {
    // Skip .session.json if it was stored by an older version
    if (row.filename === '.session.json') continue;

    let content = row.content;
    if (row.filename === '.wallet.key' && isEnvelopeEncrypted(content)) {
      content = envelopeDecrypt(content);
    }

    const filePath = path.join(WALLET_DIR, row.filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, { mode: 0o600 });
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
