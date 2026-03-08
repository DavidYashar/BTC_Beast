import express from 'express';
import crypto from 'node:crypto';
import { chat } from '../llm/client.js';
import { SYSTEM_PROMPT } from '../personality/prompts.js';
import { postTweet } from '../twitter/client.js';
import { recordTweet, remember } from '../memory/store.js';
import { pool } from '../memory/db.js';

const OPERATOR_SECRET = process.env.OPERATOR_SECRET || '';

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
  app.use('/commands', (req: any, res, next) => {
    const sig = req.headers['x-operator-signature'] as string | undefined;
    if (!verifyOperator(req.rawBody, sig)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  // Health check (no auth)
  app.get('/health', (_req, res) => {
    res.json({ ok: true, agent: 'UTXO_Beast', uptime: process.uptime() });
  });

  // ── Operator Commands ──

  /**
   * POST /commands/tweet
   * Body: { "text": "..." } or { "prompt": "..." }
   * - text: post exactly this text
   * - prompt: generate tweet from this prompt
   */
  app.post('/commands/tweet', async (req, res) => {
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
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /commands/remember
   * Body: { "content": "...", "type": "manual" }
   * Add a memory manually.
   */
  app.post('/commands/remember', async (req, res) => {
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
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /commands/status
   * Get agent stats: tweets posted, mentions handled, uptime.
   */
  app.get('/commands/status', async (_req, res) => {
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
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}
