/**
 * Wallet Manager — handles wallet provisioning, session management,
 * and auto-reconnect for BTC Beast's UTXO trading.
 *
 * Runs wallet-connect.js as a child process and manages the session lifecycle.
 */
import { execFile } from 'child_process';
import * as path from 'path';
import {
  initWalletStore,
  restoreWalletFiles,
  backupWalletFiles,
  readSessionFile,
  walletExistsOnDisk,
} from './wallet-store.js';

const SKILLS_DIR = path.resolve('skills/utxo_wallet');
const WALLET_CONNECT_SCRIPT = path.join(SKILLS_DIR, 'scripts', 'wallet-connect.cjs');
const BASE_URL = process.env.UTXO_API_BASE_URL?.replace(/\/api\/agent\/?$/, '') || 'https://utxo.fun';

// Session expires after 15 min idle; refresh if less than 5 min remain
const SESSION_REFRESH_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const WALLET_CONNECT_MAX_RETRIES = 3;
const WALLET_CONNECT_RETRY_DELAY_MS = 2_000;

let _sessionToken: string | null = null;
let _sparkAddress: string | null = null;
let _lastActivity: number = 0;
let _refreshInProgress: Promise<void> | null = null;

/**
 * Run wallet-connect.js with the given arguments.
 */
function runWalletConnect(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const fullArgs = [
      WALLET_CONNECT_SCRIPT,
      '--base-url', BASE_URL,
      '--wallet', path.join(SKILLS_DIR, '.wallet.json'),
      ...args,
    ];

    execFile('node', fullArgs, {
      cwd: SKILLS_DIR,
      timeout: 60_000,
      env: { ...process.env, UTXO_ALLOW_CUSTOM_BASE_URL: '1' },
    }, (error, stdout, stderr) => {
      const output = (stdout || '') + (stderr || '');
      if (error) {
        reject(new Error(`wallet-connect failed: ${output || error.message}`));
      } else {
        resolve(output);
      }
    });
  });
}

/**
 * Initialize wallet system. Call once at startup.
 *
 * 1. Creates the wallet persistence table
 * 2. Restores wallet files from Postgres (if any)
 * 3. Provisions a new wallet if none exists
 * 4. Connects and gets a session token
 */
export async function initWallet(): Promise<{ address: string; network: string }> {
  console.log('[wallet] Initializing wallet system...');

  // Step 1: Ensure persistence table exists
  await initWalletStore();

  // Step 2: Restore wallet files from Postgres (survives Render redeploys)
  const restored = await restoreWalletFiles();

  if (restored && walletExistsOnDisk()) {
    console.log('[wallet] Wallet restored from database.');
  } else {
    // Step 3: No wallet — provision a new one
    console.log('[wallet] No wallet found. Provisioning new wallet...');
    const output = await runWalletConnect(['--provision']);
    console.log('[wallet] Provision output:', output);

    // Back up the new wallet files to Postgres
    await backupWalletFiles();
    console.log('[wallet] Wallet backed up to database.');
  }

  // Step 4: Connect (gets fresh session token)
  await refreshSession();

  const session = readSessionFile();
  if (!session) {
    throw new Error('[wallet] Failed to establish session after init');
  }

  console.log(`[wallet] Connected: ${session.spark_address} (${session.network})`);
  return { address: session.spark_address, network: session.network };
}

/**
 * Refresh the session by running wallet-connect.js (reconnect).
 * Retries on 410 (handshake expired/used) with fresh handshake.
 * Uses a mutex to prevent concurrent refresh attempts.
 */
async function refreshSession(): Promise<void> {
  // Prevent concurrent refreshes — if one is already in progress, wait for it
  if (_refreshInProgress) {
    console.log('[wallet] Refresh already in progress, waiting...');
    await _refreshInProgress;
    return;
  }

  _refreshInProgress = (async () => {
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= WALLET_CONNECT_MAX_RETRIES; attempt++) {
      try {
        console.log(`[wallet] Refreshing session (attempt ${attempt}/${WALLET_CONNECT_MAX_RETRIES})...`);
        const output = await runWalletConnect(['--skip-disconnect']);
        console.log('[wallet] Connect output:', output);

        // Back up the new session file
        await backupWalletFiles();

        // Update in-memory cache
        const session = readSessionFile();
        if (session) {
          _sessionToken = session.session_token;
          _sparkAddress = session.spark_address;
          _lastActivity = Date.now();
        }
        return; // Success
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const msg = lastErr.message;
        const isRetryable = /410|handshake.*expired|handshake.*used|already used/i.test(msg);

        console.error(`[wallet] Connect attempt ${attempt} failed:`, msg);

        if (!isRetryable || attempt === WALLET_CONNECT_MAX_RETRIES) {
          throw lastErr;
        }

        console.log(`[wallet] Handshake expired (410) — retrying in ${WALLET_CONNECT_RETRY_DELAY_MS}ms with fresh nonce...`);
        await new Promise((r) => setTimeout(r, WALLET_CONNECT_RETRY_DELAY_MS));
      }
    }
    throw lastErr || new Error('[wallet] refreshSession failed after retries');
  })();

  try {
    await _refreshInProgress;
  } finally {
    _refreshInProgress = null;
  }
}

/**
 * Get a valid session token. Auto-refreshes if expired or stale.
 */
export async function getSessionToken(): Promise<string> {
  // Check if we need to refresh (session too old or no token)
  const elapsed = Date.now() - _lastActivity;
  if (!_sessionToken || elapsed > SESSION_REFRESH_THRESHOLD_MS) {
    await refreshSession();
  }

  if (!_sessionToken) {
    throw new Error('[wallet] No session token available');
  }

  _lastActivity = Date.now();
  return _sessionToken;
}

/**
 * Get the agent's Spark address.
 */
export function getSparkAddress(): string | null {
  if (_sparkAddress) return _sparkAddress;
  const session = readSessionFile();
  return session?.spark_address || null;
}

/**
 * Handle a 401 response — force refresh session and return new token.
 */
export async function handleAuthError(): Promise<string> {
  console.log('[wallet] Got 401 — refreshing session...');
  _sessionToken = null;
  _lastActivity = 0;
  await refreshSession();
  return getSessionToken();
}
