import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import { chat } from '../llm/client.js';
import { SYSTEM_PROMPT } from '../personality/prompts.js';
import { postTweet } from '../twitter/client.js';
import { recordTweet, remember } from '../memory/store.js';
import { pool } from '../memory/db.js';
import { initWallet, getSparkAddress } from '../utxo-api/wallet.js';
import { behaviors, type CronBehavior } from '../cron-registry.js';
import { currentRunning, nextDueBehaviors } from '../tick-loop.js';
import { filterLLMOutput } from '../twitter/safety.js';
import {
  fetchBalance,
  executeSwap,
  launchToken,
  postChatMessage,
  fetchTokenInfo,
  formatBalanceForPrompt,
  formatTokenInfoForPrompt,
} from '../utxo-api/client.js';

const OPERATOR_SECRET = process.env.OPERATOR_SECRET;

if (!OPERATOR_SECRET) {
  throw new Error('FATAL: OPERATOR_SECRET env var must be set. Refusing to start without webhook authentication.');
}

/** Sanitize error messages to avoid leaking internal details. */
function safeErrorMessage(err: any): string {
  const msg = err?.message ?? String(err);
  // Strip connection strings, file paths, stack traces, and any sensitive patterns
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT/.test(msg)) return 'Service temporarily unavailable';
  if (/password|connectionString|DATABASE_URL|SECRET|KEY|token/i.test(msg)) return 'Internal server error';
  if (/\/(\w+\/)+\w+\.\w+/.test(msg)) return 'Internal server error'; // file paths
  if (/at\s+\w+\s+\(/.test(msg)) return 'Internal server error'; // stack frames
  // For anything else, return a generic message to avoid info leaks
  return 'Service error';
}

/**
 * Verify operator authentication via HMAC signature.
 * Header: X-Operator-Signature: sha256=<hex>
 */
function verifyOperator(body: string, signature: string | undefined): boolean {
  if (!OPERATOR_SECRET || !signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', OPERATOR_SECRET).update(body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function createCommandServer(): express.Express {
  const app = express();

  // Parse raw body for HMAC verification, then JSON
  app.use(express.json({
    verify: (req: any, _res, buf) => { req.rawBody = buf.toString(); },
  }));

  // Authentication middleware
  app.use('/commands', (req: any, res: Response, next: NextFunction) => {
    const sig = req.headers['x-operator-signature'] as string | undefined;
    if (!verifyOperator(req.rawBody, sig)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  // Health check (no auth)
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, agent: 'UTXO_Beast' });
  });

  // ── Operator Commands ──

  /**
   * POST /commands/tweet
   * Body: { "text": "..." } or { "prompt": "..." }
   * - text: post exactly this text
   * - prompt: generate tweet from this prompt
   */
  app.post('/commands/tweet', async (req: Request, res: Response) => {
    try {
      const { text, prompt } = req.body;
      let tweetText: string;

      if (text) {
        tweetText = text;
      } else if (prompt) {
        tweetText = await chat(
          [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Write a tweet based on this instruction: ${prompt}` },
          ],
          { temperature: 0.85, maxTokens: 280 },
        );
      } else {
        res.status(400).json({ error: 'Provide "text" or "prompt"' });
        return;
      }

      if (tweetText.length > 280) {
        res.status(400).json({ error: 'Tweet exceeds 280 chars', length: tweetText.length });
        return;
      }

      // Safety filter — only for LLM-generated tweets (prompt path)
      if (prompt) {
        const safe = filterLLMOutput(tweetText);
        if (!safe) {
          res.status(400).json({ error: 'Tweet blocked by safety filter' });
          return;
        }
        tweetText = safe;
      }

      const tweetId = await postTweet(tweetText);
      await recordTweet(tweetId, tweetText, 'operator_command');

      // Audit trail
      await pool.query(
        `INSERT INTO operator_commands (command, payload, result)
         VALUES ($1, $2, $3)`,
        ['tweet', JSON.stringify(req.body), JSON.stringify({ tweetId, tweetText })],
      );

      res.json({ ok: true, tweetId, text: tweetText });
    } catch (err: any) {
      console.error('[commands] Tweet error:', err);
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  /**
   * POST /commands/remember
   * Body: { "content": "...", "type": "manual" }
   * Add a memory manually.
   */
  app.post('/commands/remember', async (req: Request, res: Response) => {
    try {
      const { content, type = 'manual' } = req.body;
      if (!content) {
        res.status(400).json({ error: 'Provide "content"' });
        return;
      }

      await remember(content, type);
      await pool.query(
        `INSERT INTO operator_commands (command, payload) VALUES ($1, $2)`,
        ['remember', JSON.stringify(req.body)],
      );

      res.json({ ok: true });
    } catch (err: any) {
      console.error('[commands] Remember error:', err);
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  /**
   * GET /commands/status
   * Get agent stats: tweets posted, mentions handled, uptime.
   */
  app.get('/commands/status', async (_req: Request, res: Response) => {
    try {
      const [tweetsRes, mentionsRes, memoriesRes] = await Promise.all([
        pool.query('SELECT COUNT(*)::int AS count FROM tweets_posted'),
        pool.query('SELECT COUNT(*)::int AS count FROM mentions_handled'),
        pool.query('SELECT COUNT(*)::int AS count FROM memories'),
      ]);

      res.json({
        ok: true,
        uptime: process.uptime(),
        tweets_posted: tweetsRes.rows[0].count,
        mentions_handled: mentionsRes.rows[0].count,
        memories: memoriesRes.rows[0].count,
      });
    } catch (err: any) {
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  // ── Wallet & Trading Commands ──

  /**
   * POST /commands/wallet
   * Provision a new wallet or check current wallet status.
   * Body: {} (empty) — returns current wallet, provisions if none exists
   */
  app.post('/commands/wallet', async (req: Request, res: Response) => {
    try {
      const address = getSparkAddress();
      if (address) {
        // Wallet exists — return address immediately, try balance but don't block
        let balance_sats = 0;
        let token_holdings = {};
        try {
          const balance = await Promise.race([
            fetchBalance(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 15_000)),
          ]);
          balance_sats = balance.balance_sats;
          token_holdings = balance.token_holdings;
        } catch {
          // Balance unavailable (session stale or timeout) — still return address
        }
        await pool.query(
          `INSERT INTO operator_commands (command, payload, result) VALUES ($1, $2, $3)`,
          ['wallet', '{}', JSON.stringify({ address, balance_sats })],
        );
        res.json({ ok: true, status: 'connected', address, balance_sats, token_holdings });
        return;
      }

      // No wallet — provision one
      console.log('[commands] Provisioning wallet via operator command...');
      const walletInfo = await initWallet();

      await pool.query(
        `INSERT INTO operator_commands (command, payload, result) VALUES ($1, $2, $3)`,
        ['wallet', JSON.stringify({ action: 'provision' }), JSON.stringify(walletInfo)],
      );

      res.json({ ok: true, status: 'provisioned', address: walletInfo.address, network: walletInfo.network });
    } catch (err: any) {
      console.error('[commands] Wallet error:', err);
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  /**
   * POST /commands/balance
   * Check wallet balance (sats + token holdings).
   */
  app.post('/commands/balance', async (_req: Request, res: Response) => {
    try {
      const balance = await fetchBalance();

      await pool.query(
        `INSERT INTO operator_commands (command, payload, result) VALUES ($1, $2, $3)`,
        ['balance', '{}', JSON.stringify(balance)],
      );

      res.json(balance);
    } catch (err: any) {
      console.error('[commands] Balance error:', err);
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  /**
   * POST /commands/swap
   * Buy or sell a token.
   * Body: { "action": "buy"|"sell", "token": "btkn1...", "amount": number }
   *   - buy:  amount = sats to spend  (1 USDB = 1000 sats)
   *   - sell: amount = token base units to sell
   */
  app.post('/commands/swap', async (req: Request, res: Response) => {
    try {
      const { action, token, amount } = req.body;

      if (!action || !['buy', 'sell'].includes(action)) {
        res.status(400).json({ error: 'Provide "action" as "buy" or "sell"' });
        return;
      }
      if (!token) {
        res.status(400).json({ error: 'Provide "token" address (btkn1...)' });
        return;
      }
      if (!amount || typeof amount !== 'number' || amount <= 0) {
        res.status(400).json({ error: 'Provide positive "amount" (sats for buy, token units for sell)' });
        return;
      }

      console.log(`[commands] Swap: ${action} ${amount} on ${token}`);
      const result = await executeSwap({ token, action, amount });

      // Store in RAG memory for learning
      const memoryText = `Trade executed: ${action} ${token} — spent ${result.result.amount_in}, received ${result.result.amount_out}`;
      await remember(memoryText, 'trade');

      await pool.query(
        `INSERT INTO operator_commands (command, payload, result) VALUES ($1, $2, $3)`,
        ['swap', JSON.stringify(req.body), JSON.stringify(result)],
      );

      res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error('[commands] Swap error:', err);
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  /**
   * POST /commands/launch
   * Launch a new token on UTXO.fun.
   * Body: { "name": "...", "ticker": "...", "supply": number, "decimals": number,
   *         "initialBuyAmountSats": number (optional), "bio": string (optional),
   *         "x": string (optional), "website": string (optional),
   *         "telegram": string (optional), "imageUrl": string (optional) }
   */
  app.post('/commands/launch', async (req: Request, res: Response) => {
    try {
      const { name, ticker, supply, decimals, initialBuyAmountSats, bio, x, website, telegram, imageUrl } = req.body;

      if (!name || !ticker) {
        res.status(400).json({ error: 'Provide "name" and "ticker"' });
        return;
      }
      if (!supply || typeof supply !== 'number' || supply <= 0) {
        res.status(400).json({ error: 'Provide positive "supply"' });
        return;
      }

      const params: Record<string, unknown> = {
        name,
        ticker: ticker.toUpperCase(),
        supply,
        decimals: typeof decimals === 'number' ? decimals : 6,
      };

      // Pass through optional fields
      if (typeof initialBuyAmountSats === 'number' && initialBuyAmountSats > 0) {
        params.initialBuyAmountSats = initialBuyAmountSats;
      }
      if (bio) params.bio = bio;
      if (x) params.x = x;
      if (website) params.website = website;
      if (telegram) params.telegram = telegram;
      if (imageUrl) params.imageUrl = imageUrl;

      console.log(`[commands] Launching token: ${params.ticker} (${params.name})${params.initialBuyAmountSats ? ` with initial buy: ${params.initialBuyAmountSats} sats` : ''}`);
      const result = await launchToken(params as any);

      // Store in RAG memory
      const memoryText = `Launched token: ${params.ticker} (${params.name}) — address: ${result.result.token_address}, trade: ${result.result.trade_url}`;
      await remember(memoryText, 'token_launch');

      await pool.query(
        `INSERT INTO operator_commands (command, payload, result) VALUES ($1, $2, $3)`,
        ['launch', JSON.stringify(params), JSON.stringify(result)],
      );

      res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error('[commands] Launch error:', err);
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  /**
   * POST /commands/chat
   * Post a message on a token's chat page.
   * Body: { "coinId": "btkn1...", "message": "..." }
   */
  app.post('/commands/chat', async (req: Request, res: Response) => {
    try {
      const { coinId, message, parentId } = req.body;

      if (!coinId) {
        res.status(400).json({ error: 'Provide "coinId" (token address)' });
        return;
      }
      if (!message) {
        res.status(400).json({ error: 'Provide "message"' });
        return;
      }

      console.log(`[commands] Chat on ${coinId}: ${message.slice(0, 50)}...`);
      const result = await postChatMessage({ coinId, message, parentId });

      await pool.query(
        `INSERT INTO operator_commands (command, payload, result) VALUES ($1, $2, $3)`,
        ['chat', JSON.stringify(req.body), JSON.stringify(result)],
      );

      res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error('[commands] Chat error:', err);
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  /**
   * POST /commands/token-info
   * Get detailed info about a specific token.
   * Body: { "address": "btkn1..." }
   */
  app.post('/commands/token-info', async (req: Request, res: Response) => {
    try {
      const { address } = req.body;

      if (!address) {
        res.status(400).json({ error: 'Provide "address" (btkn1...)' });
        return;
      }

      const info = await fetchTokenInfo(address);
      res.json({ ok: true, token: info });
    } catch (err: any) {
      console.error('[commands] Token info error:', err);
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  // ── Twitter Cron Control Commands ──

  const ALL_BEHAVIORS: CronBehavior[] = ['mentions', 'engagement', 'content', 'trending', 'self-promo', 's402', 'wallet', 'pruning', 'knowledge-refresh'];

  function parseBehaviors(body: { behaviors?: string[] }): CronBehavior[] {
    if (!body.behaviors || body.behaviors.includes('all')) return ALL_BEHAVIORS;
    return body.behaviors.filter((b): b is CronBehavior => ALL_BEHAVIORS.includes(b as CronBehavior));
  }

  /**
   * POST /commands/start-tweeting
   * Resume Twitter behaviors.
   * Body: { "behaviors": ["trending", "mentions", "engagement"] }
   *   - Omit behaviors or pass ["all"] to start everything.
   */
  app.post('/commands/start-tweeting', async (req: Request, res: Response) => {
    try {
      const targets = parseBehaviors(req.body);
      const results: Record<string, string> = {};

      for (const name of targets) {
        const entry = behaviors.get(name);
        if (!entry) {
          results[name] = 'not_found';
          continue;
        }
        if (entry.enabled) {
          results[name] = 'already_running';
        } else {
          entry.enabled = true;
          results[name] = 'started';
        }
      }

      console.log('[commands] start-tweeting:', results);
      await pool.query(
        `INSERT INTO operator_commands (command, payload, result) VALUES ($1, $2, $3)`,
        ['start-tweeting', JSON.stringify(req.body), JSON.stringify(results)],
      );

      res.json({ ok: true, results });
    } catch (err: any) {
      console.error('[commands] start-tweeting error:', err);
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  /**
   * POST /commands/stop-tweeting
   * Pause Twitter behaviors.
   * Body: { "behaviors": ["trending", "mentions", "engagement"] }
   *   - Omit behaviors or pass ["all"] to stop everything.
   */
  app.post('/commands/stop-tweeting', async (req: Request, res: Response) => {
    try {
      const targets = parseBehaviors(req.body);
      const results: Record<string, string> = {};

      for (const name of targets) {
        const entry = behaviors.get(name);
        if (!entry) {
          results[name] = 'not_found';
          continue;
        }
        if (!entry.enabled) {
          results[name] = 'already_stopped';
        } else {
          entry.enabled = false;
          results[name] = 'stopped';
        }
      }

      console.log('[commands] stop-tweeting:', results);
      await pool.query(
        `INSERT INTO operator_commands (command, payload, result) VALUES ($1, $2, $3)`,
        ['stop-tweeting', JSON.stringify(req.body), JSON.stringify(results)],
      );

      res.json({ ok: true, results });
    } catch (err: any) {
      console.error('[commands] stop-tweeting error:', err);
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  /**
   * GET /commands/cron-status
   * Show which behaviors are active/paused, their intervals, and last run info.
   */
  app.get('/commands/cron-status', async (_req: Request, res: Response) => {
    try {
      const list: Record<string, {
        intervalMs: number;
        enabled: boolean;
        lastRunAt: string | null;
        lastError: string | null;
        dailyHourUtc?: number;
      }> = {};

      for (const [name, entry] of behaviors) {
        list[name] = {
          intervalMs: entry.intervalMs,
          enabled: entry.enabled,
          lastRunAt: entry.lastRunAt ? new Date(entry.lastRunAt).toISOString() : null,
          lastError: entry.lastError,
          ...(entry.dailyHourUtc !== undefined ? { dailyHourUtc: entry.dailyHourUtc } : {}),
        };
      }

      res.json({
        ok: true,
        behaviors: list,
        loop: { executing: currentRunning(), nextDue: nextDueBehaviors() },
      });
    } catch (err: any) {
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  return app;
}
