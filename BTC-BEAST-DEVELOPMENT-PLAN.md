# BTC Beast — Development Plan

> Master reference for the BTC Beast expansion: Telegram bot, per-user wallets, AI agent API, S402 payment gating.
> All architectural decisions documented here are **confirmed**.

---

## Table of Contents

1. [What BTC Beast Is Today](#1-what-btc-beast-is-today)
2. [What We're Building](#2-what-were-building)
3. [Architectural Decisions](#3-architectural-decisions)
4. [Per-User Wallet System](#4-per-user-wallet-system)
5. [Telegram Bot](#5-telegram-bot)
6. [AI Agent API + S402](#6-ai-agent-api--s402)
7. [Deposit System](#7-deposit-system)
8. [Database Schema](#8-database-schema)
9. [Directory Structure](#9-directory-structure)
10. [Implementation Phases](#10-implementation-phases)
11. [Infrastructure & Deployment](#11-infrastructure--deployment)
12. [Security Model](#12-security-model)
13. [Current Codebase Reference](#13-current-codebase-reference)

---

## 1. What BTC Beast Is Today

BTC Beast is a **Twitter AI agent** that posts about the UTXO DEX ecosystem. It runs on Render as a Node.js/Express/TypeScript service with PostgreSQL 16 (pgvector).

### Current Capabilities

| Feature | Details |
|---------|---------|
| **9 Cron Behaviors** | trending (4h), mentions (5m), engagement (15m), self-promo (daily), S402 (daily), wallet (daily), content (3h), pruning (daily 3AM), knowledge-refresh (daily 4AM) |
| **RAG Pipeline** | pgvector (1536D), OpenAI text-embedding-3-small, cosine similarity |
| **Content Engine** | 9 topic categories, 100+ template seeds, weighted distribution (35% S402) |
| **LLM** | OpenAI GPT-5.2, temperature 0.75–0.95, max 280 tokens |
| **Security** | 3-layer defense: input sanitization, hardened system prompt, output filtering |
| **Cron Execution** | Serial FIFO queue — one job at a time, deduplication, PG warmup probe |
| **Beast's Own Wallet** | Single Spark wallet on UTXO, managed by `wallet-connect.cjs`, encrypted at rest in PG |

### Current Source Structure

```
src/
  index.ts                    — Main entry, 9 cron registrations
  cron-queue.ts               — Serial FIFO cron queue
  cron-registry.ts            — CronBehavior types + task map
  commands/webhook.ts         — Express server, operator commands, HMAC auth
  content/                    — Content generation engine (topics, templates, engine, scheduler)
  knowledge/github-fetcher.ts — GitHub docs fetcher for RAG
  llm/client.ts               — GPT-5.2 wrapper, 30s timeout
  memory/                     — PG pool, embeddings, RAG store, init-db
  personality/prompts.ts      — System prompt + 9 prompt templates
  twitter/                    — Twitter API v2 client, safety filters, all post-*.ts handlers
  utxo-api/                   — UTXO API client + Beast's wallet manager + wallet-store
```

---

## 2. What We're Building

Expanding BTC Beast from a Twitter-only agent into a **multi-platform agent** that serves:

1. **Telegram users** — personal Spark wallets, trading on UTXO, portfolio management
2. **AI agents** — S402-gated API endpoints for programmatic trading
3. **Twitter** — unchanged, continues as-is

All in **one bot, one codebase, one deploy**.

---

## 3. Architectural Decisions

All decisions below are **confirmed and final**.

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Bot architecture | **One bot** (not two separate wallet + trading bots) | Simpler UX, one deploy, internally separated modules can be extracted later |
| Telegram framework | **grammY** | TypeScript-native, webhook-first, fits Render's web service model |
| Wallet model | **Per-user real Spark wallets on UTXO** | Each user/agent has their own wallet, own funds, own session |
| Wallet storage | **Beast's Postgres** (password-encrypted) | Not Telegram CloudStorage — PG is more reliable, works for both TG users and API agents |
| Password | **User-provided password encrypts their seed at rest** | Non-custodial: Beast stores the encrypted blob, can't access without user's password |
| Beast's role | **Broker** — decrypts user's seed on demand, connects to UTXO, executes trades | Beast handles the UTXO session lifecycle on behalf of the user |
| Beast's own wallet | **Unchanged** — module-level singleton for Beast's own operations | Twitter posting, Beast's balance, etc. — completely separate from user wallets |
| S402 usage | **AI agents only** | Humans use pre-deposited balance + password unlock, AI agents pay per-call or via subscription |
| S402 tiers | Free (trending data) / Pro (50K sats/month, all services) | |
| Subscription credential | Cached 30 days after payment via `issueCredential` / `verifyCredential` | |

---

## 4. Per-User Wallet System

### How UTXO Wallet Works (Background)

UTXO's server holds a live `IssuerSparkWallet` gRPC instance per session:

```
Agent sends encrypted mnemonic ──→ UTXO server decrypts ──→ IssuerSparkWallet.initialize()
                                                              ──→ session_token returned
                                                              ──→ 15-min idle timeout
                                                              ──→ 2-hour hard expiry
                                                              ──→ Max 50 concurrent sessions
```

The existing `wallet-connect.cjs` script already supports `--wallet <path>` to specify a custom wallet file location.

### Per-User Wallet Lifecycle

#### Create Wallet

```
User: /create-wallet
Beast: "Enter a password for your wallet (8+ chars):"
User: mySecurePassword123

Beast internally:
  1. Create temp dir /tmp/wallets/<user_id>/
  2. Run: wallet-connect.cjs --provision --wallet /tmp/wallets/<user_id>/.wallet.json
  3. UTXO server generates BIP39 mnemonic, creates Spark wallet
  4. Beast receives: .wallet.json (encrypted mnemonic) + .wallet.key
  5. Encrypt .wallet.key with user's password:
       salt = crypto.randomBytes(32)
       derived_key = PBKDF2(password, salt, 210_000, 'sha512')
       wallet_key_enc = AES-256-GCM(derived_key, .wallet.key)
  6. Store in user_wallets table: {user_id, wallet_json, wallet_key_enc, salt, spark_address}
  7. Wipe temp dir + plaintext from memory
  8. Return spark_address to user

Beast: "✅ Wallet created! Your Spark address: spark1q..."
```

#### Import Wallet (Restore)

```
User: /import-wallet
Beast: "Enter your 12-word seed phrase:"
User: word1 word2 ... word12
Beast: "Enter a password to encrypt it:"
User: mySecurePassword123

Beast internally:
  1. Encrypt mnemonic with a random .wallet.key (same format as wallet-connect.cjs)
  2. Encrypt .wallet.key with user's password (PBKDF2 + AES-256-GCM)
  3. Derive Spark address from mnemonic (or connect once to get it)
  4. Store in user_wallets table
  5. Wipe plaintext mnemonic from memory immediately
```

#### Unlock (Start Trading Session)

```
User: /unlock
Beast: "Enter your password:"
User: mySecurePassword123

Beast internally:
  1. Load {wallet_json, wallet_key_enc, salt} from user_wallets table
  2. derived_key = PBKDF2(password, salt, 210_000, 'sha512')
  3. Decrypt .wallet.key → decrypt mnemonic from .wallet.json
  4. Write temp files → run wallet-connect.cjs --skip-disconnect --wallet /tmp/<user_id>/
  5. Get session_token from .session.json
  6. Cache {user_id → session_token, expires_at} in memory (30-min idle timeout)
  7. Wipe temp files + plaintext mnemonic from memory

Beast: "🔓 Wallet unlocked for 30 minutes. Use /lock to end session."
```

#### Trade (Session Active)

```
User: /buy CLAW 5000

Beast internally:
  1. Check session cache for user_id
  2. Session exists and not expired? → use session_token
  3. Call UTXO API: POST /swap with Bearer session_token
  4. Return result to user
  5. Reset idle timeout to 30 minutes

  If session expired: "🔒 Session expired. Use /unlock to continue."
```

#### Lock (End Session)

```
User: /lock
Beast: disconnect session on UTXO, wipe session from cache
Beast: "🔒 Wallet locked."
```

### Session-on-Demand Strategy

Beast does NOT keep all users connected simultaneously:
- UTXO server allows max **50 concurrent sessions**
- Beast maintains an **LRU session cache** in memory
- When cache is full, the oldest idle session is evicted (UTXO's 15-min timeout handles cleanup)
- Evicted users simply `/unlock` again (~2-3s reconnect delay)
- For Telegram with <20 concurrent active users, this is not a bottleneck

### Wrong Password Handling

- PBKDF2 + AES-256-GCM: wrong password → decryption fails (auth tag mismatch)
- Beast responds: "❌ Wrong password. Try again."
- Rate limit: max 5 attempts per 10 minutes per user
- If user forgets password: **wallet is unrecoverable** (non-custodial property)

---

## 5. Telegram Bot

### Framework: grammY

- TypeScript-native, webhook-first
- Render's web service receives Telegram webhook → grammY processes → responds
- Webhook endpoint: `POST /telegram/webhook` on Beast's Express server

### Commands

| Command | Auth | Description |
|---------|------|-------------|
| `/start` | No | Welcome message, getting started guide |
| `/help` | No | List all commands |
| `/trending` | No | Show top trending tokens on UTXO (free tier) |
| `/token <ticker>` | No | Token info, price, volume |
| `/create-wallet` | No | Provision a new Spark wallet |
| `/import-wallet` | No | Import existing wallet via seed phrase |
| `/unlock` | No → Password | Decrypt wallet, start trading session |
| `/lock` | Session | End trading session |
| `/balance` | Session | Show Spark wallet balance |
| `/deposit` | Session | Show deposit instructions (FixedFloat) |
| `/buy <ticker> <sats>` | Session | Buy token on UTXO |
| `/sell <ticker> <sats>` | Session | Sell token on UTXO |
| `/portfolio` | Session | Show all token holdings |
| `/send <address> <sats>` | Session | Send sats to Spark address |
| `/history` | Session | Recent trade history |
| `/settings` | Session | Timeout duration, notifications |
| `/logout` | Session | Lock wallet + clear session |

### Inline Keyboards

Trading actions will use Telegram inline keyboards for confirmation:
```
Buy 5000 sats of $CLAW?
[✅ Confirm]  [❌ Cancel]
```

---

## 6. AI Agent API + S402

### Endpoint Design

All AI agent endpoints live under `/api/agent/` on Beast's Express server, gated by S402.

| Endpoint | S402 Price | Description |
|----------|-----------|-------------|
| `POST /api/agent/trending` | Free (null) | Top trending tokens |
| `POST /api/agent/token-info` | 10 sats | Token details by ticker |
| `POST /api/agent/balance` | 50 sats | Agent's wallet balance |
| `POST /api/agent/swap` | 100 sats | Buy/sell tokens |
| `POST /api/agent/launch` | 5,000 sats | Launch a new token |
| `POST /api/agent/portfolio` | 50 sats | Portfolio holdings |
| `POST /api/agent/subscribe` | 50,000 sats | 30-day Pro subscription |

### S402 Integration

```typescript
import { createS402Handler, expressAdapter } from '@s402/server';
import { createSparkProvider } from '@s402/spark';

const provider = createSparkProvider({
  wallet: beastSparkWallet,      // Beast's own wallet receives payments
  sparkAddress: beastSparkAddress,
  network: 'MAINNET',
});

// Example: swap endpoint
const swapHandler = createS402Handler({
  ...provider,
  fixedPriceSats: 100,
  description: 'Execute token swap on UTXO',
  execute: async (params, payment) => {
    // params.agent_address identifies the agent
    // Agent must have provisioned a wallet via /api/agent/wallet/provision
    return await executeSwapForAgent(params);
  },
});

app.post('/api/agent/swap', expressAdapter(swapHandler));
```

### Subscription (Pro Tier)

- Agent pays 50K sats once → receives a credential token (valid 30 days)
- Subsequent requests include `X-S402-Credential: <token>` → skip payment
- `verifyCredential()` checks token validity + agent address binding
- `issueCredential()` generates token after payment with 30-day TTL

### AI Agent Wallet

AI agents provision their own wallets via the same UTXO wallet system:
- Agent provides its own Spark address in `agent_address` field
- Beast connects to UTXO on the agent's behalf using the agent's wallet credentials
- Same session-on-demand model as Telegram users

---

## 7. Deposit System

### FixedFloat Integration

Users deposit non-BTC crypto → FixedFloat converts to Lightning BTC → arrives at user's Spark wallet.

Supported deposit currencies:
- **SOL** (Solana)
- **ETH** (Ethereum, Arbitrum, Base)
- **BNB** (BSC)
- **USDC** (Solana, Ethereum, Arbitrum, Base, TRON)
- **USDT** (Solana, Ethereum, Arbitrum, Base, TRON, BSC)

### Deposit Flow

```
User: /deposit
Beast: "Select currency to deposit:"
       [SOL] [ETH] [BNB] [USDC] [USDT]

User taps: SOL
Beast internally:
  1. POST FixedFloat API: create order (SOL → BTCLN, destination = user's Spark address)
  2. Get: deposit address (Solana) + expected amount + order ID

Beast: "Send SOL to this address:
        HxR4...kP9q
        Minimum: 0.05 SOL
        Order expires in 30 minutes"

User sends SOL...
FixedFloat converts SOL → Lightning BTC → sends to user's Spark address.

Beast: "✅ Deposit received: 48,500 sats"
```

### Deposit Monitoring

- Beast polls FixedFloat order status via cron or webhook
- Status transitions: waiting → confirming → exchanging → sending → completed
- User gets a Telegram notification at each stage

---

## 8. Database Schema

### New Tables

```sql
-- Per-user wallet storage (password-encrypted)
CREATE TABLE user_wallets (
  user_id TEXT PRIMARY KEY,                -- 'tg_123456' or 'agent_spark1q...'
  platform TEXT NOT NULL,                  -- 'telegram' | 'api'
  wallet_json TEXT NOT NULL,               -- .wallet.json contents (mnemonic already encrypted by wallet_key)
  wallet_key_enc TEXT NOT NULL,            -- .wallet.key encrypted with user's password (PBKDF2+AES-256-GCM)
  salt TEXT NOT NULL,                      -- PBKDF2 salt (hex)
  spark_address TEXT NOT NULL,             -- User's Spark address
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

-- Trade history
CREATE TABLE trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES user_wallets(user_id),
  action TEXT NOT NULL,                    -- 'buy' | 'sell' | 'launch' | 'send'
  ticker TEXT,
  amount_sats BIGINT,
  result JSONB,                            -- Raw UTXO API response
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Deposit tracking (FixedFloat orders)
CREATE TABLE deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES user_wallets(user_id),
  ff_order_id TEXT NOT NULL,               -- FixedFloat order ID
  from_currency TEXT NOT NULL,             -- 'SOL', 'ETH', etc.
  from_amount TEXT,                        -- Amount sent by user
  to_amount_sats BIGINT,                  -- BTC received
  status TEXT NOT NULL DEFAULT 'waiting',  -- waiting | confirming | exchanging | sending | completed | failed
  deposit_address TEXT,                    -- Address user sends to
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- S402 subscription management
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_address TEXT NOT NULL,             -- Agent's Spark address
  credential_token TEXT NOT NULL,          -- Opaque token for X-S402-Credential
  tx_id TEXT NOT NULL,                     -- Payment transaction ID
  amount_sats BIGINT NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE(agent_address)
);
```

### Existing Tables (Unchanged)

| Table | Purpose |
|-------|---------|
| `knowledge` | RAG: static docs with pgvector embeddings |
| `memories` | RAG: interaction history with embeddings |
| `tweets_posted` | Tweet dedup with embeddings |
| `token_snapshots` | Token price/metrics history |
| `mentions_handled` | Twitter mention dedup |
| `operator_commands` | Operator command log |
| `agent_state` | Key-value state store |
| `agent_wallet_files` | Beast's own wallet files (envelope-encrypted) |

---

## 9. Directory Structure

### New Modules to Build

```
src/
  accounts/                         ← NEW: per-user wallet management
    user-wallet-store.ts               CRUD for user_wallets table
    session-cache.ts                   LRU in-memory session cache (user_id → UTXO session)
    wallet-ops.ts                      Provision/connect/disconnect per-user (wraps wallet-connect.cjs)
    password-crypto.ts                 PBKDF2 key derivation + AES-256-GCM encrypt/decrypt
    
  telegram/                         ← NEW: Telegram bot
    bot.ts                             grammY bot instance, webhook handler
    middleware.ts                      Auth middleware, rate limiting, session checks
    commands/                          Command handlers
      start.ts                           /start, /help
      wallet.ts                          /create-wallet, /import-wallet, /unlock, /lock
      trading.ts                         /buy, /sell, /portfolio
      info.ts                            /trending, /token, /balance
      deposit.ts                         /deposit flow
      settings.ts                        /settings, /history
      
  api/                              ← NEW: AI agent REST API
    agent-routes.ts                    Express router for /api/agent/* endpoints
    s402-config.ts                     S402 handler setup, provider config
    subscription.ts                    Subscription CRUD, credential verify/issue
    
  deposits/                         ← NEW: FixedFloat integration
    fixedfloat-client.ts               FixedFloat API wrapper
    deposit-monitor.ts                 Poll order status, notify user
```

### Existing Modules (Unchanged)

```
src/
  index.ts                          — Add Telegram webhook route + agent API routes
  commands/webhook.ts               — Existing operator webhook (unchanged)
  content/                          — Content engine (unchanged)
  knowledge/                        — GitHub fetcher (unchanged)
  llm/                              — LLM client (unchanged)
  memory/                           — PG pool, RAG, embeddings (unchanged)
  personality/                      — System prompt + templates (unchanged)
  twitter/                          — Twitter pipeline (unchanged)
  utxo-api/
    wallet.ts                       — Beast's own wallet (unchanged, singleton)
    wallet-store.ts                 — Beast's wallet persistence (unchanged)
    client.ts                       — UTXO API calls: add optional session_token parameter
  cron-queue.ts                     — Serial cron queue (unchanged)
  cron-registry.ts                  — Cron types (add deposit-monitor behavior)
```

### Key Change: `utxo-api/client.ts`

The existing `authFetch()` always uses Beast's global session token. It needs a small change to accept an **optional** session token parameter so user-scoped calls can pass their own token:

```typescript
// Before: always uses Beast's global session
async function authFetch(url: string, options?: RequestInit): Promise<Response>

// After: optional token override for per-user sessions
async function authFetch(url: string, options?: RequestInit, sessionToken?: string): Promise<Response>
```

---

## 10. Implementation Phases

### Phase 1: Telegram Foundation
- Install grammY, set up webhook on Express server
- `/start`, `/help`, `/trending` commands (read-only, no wallet needed)
- Telegram bot token in env vars
- Register webhook URL with Telegram API

### Phase 2: Per-User Wallet System
- `accounts/` module: password-crypto, user-wallet-store, wallet-ops, session-cache
- `user_wallets` table creation
- `/create-wallet`, `/import-wallet`, `/unlock`, `/lock` commands
- `/balance` command (requires unlocked session)
- Wrong password handling, rate limiting

### Phase 3: Trading
- `/buy`, `/sell` commands with inline keyboard confirmation
- `trades` table
- Modify `utxo-api/client.ts` to accept per-user session tokens
- `/portfolio`, `/history` commands

### Phase 4: Deposits
- FixedFloat API integration
- `/deposit` command flow (currency selection, address display, status tracking)
- `deposits` table
- Deposit monitoring cron (poll FixedFloat status)

### Phase 5: AI Agent API
- `/api/agent/*` Express routes
- S402 handler setup with `createSparkProvider()` using Beast's wallet
- Per-call pricing + subscription endpoint
- `subscriptions` table
- Credential issue/verify for Pro tier

### Phase 6: Autonomous Features
- Price alerts (user sets threshold → Beast monitors → Telegram notification)
- Auto-buy signals (Beast's content engine identifies opportunities)
- Stop-loss triggers
- This phase is stretch — depends on adoption and feedback

---

## 11. Infrastructure & Deployment

### Render Configuration

| Service | Type | Plan |
|---------|------|------|
| utxo-beast | Web Service | Starter |
| utxo-beast-db | PostgreSQL 16 | basic-256mb (may need upgrade for user wallets) |

### Environment Variables (New)

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | grammY bot token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Webhook verification secret |
| `FIXEDFLOAT_API_KEY` | FixedFloat API key |
| `FIXEDFLOAT_API_SECRET` | FixedFloat API secret |

### Existing Environment Variables (Unchanged)

```
DATABASE_URL, DATABASE_CA_CERT, WALLET_ENCRYPTION_KEY,
TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET,
OPENAI_API_KEY, UTXO_API_BASE_URL, OPERATOR_SECRET, AUTO_TWEET, PORT
```

---

## 12. Security Model

### Password-Encrypted Wallet Storage

```
User's password
      │
      ▼
  PBKDF2(password, salt, 210_000 iterations, SHA-512) → derived_key (32 bytes)
      │
      ▼
  AES-256-GCM(derived_key, .wallet.key) → wallet_key_enc (stored in PG)
                                            │
      .wallet.json contains:                │
      encrypted_mnemonic = AES-256-GCM(     │
        .wallet.key,  ◄────────────────────┘ decrypted at unlock time
        BIP39 mnemonic
      )
```

**Three layers of encryption at rest:**
1. Mnemonic encrypted by `.wallet.key` (in `.wallet.json`)
2. `.wallet.key` encrypted by user's password + PBKDF2 salt (in `user_wallets.wallet_key_enc`)
3. Beast's own `WALLET_ENCRYPTION_KEY` is NOT used for user wallets — users own their encryption

### Plaintext Mnemonic Exposure Window

The mnemonic exists in Beast's memory **only during the 2-3 second ECDH handshake** with UTXO's server:
1. User enters password → Beast decrypts .wallet.key → decrypts mnemonic
2. Mnemonic written to temp file → `wallet-connect.cjs` sends it encrypted via ECDH to UTXO
3. Temp files wiped, mnemonic wiped from variables
4. Session token cached (no mnemonic needed until next unlock)

### If User Forgets Password

**Wallet is unrecoverable from Beast.** This is the non-custodial guarantee.
The user can still restore from their seed phrase if they saved it separately.

### Rate Limiting

- Password attempts: max 5 per 10 minutes per user
- Telegram commands: max 30 per minute per user
- AI agent API: S402 built-in rate limiter (configurable per endpoint)

---

## 13. Current Codebase Reference

### Commits (Pushed)

| Commit | Description |
|--------|-------------|
| `559db60` | Twitter API v2 migration + security audit + content engine |
| `d61a495` | 429 rate limit fix with smart wait |
| `4c9e821` | Hung crons fix (PG timeouts + Promise.race) |
| `91e8da0` | Serial cron queue + PG pool health hardening |
| `85e09f3` | PG pool anti-stampede (max:2, warmDb probe, resetPool) |

### GitHub

- Repository: `DavidYashar/BTC_Beast.git`
- Branch: `main`

### Key Dependencies

| Package | Purpose |
|---------|---------|
| `twitter-api-v2` | Twitter OAuth 1.0a |
| `openai` | GPT-5.2 LLM |
| `pg` | PostgreSQL client |
| `pgvector` | Vector similarity search |
| `node-cron` | Scheduled tasks |
| `express` | HTTP server |
| **To add:** `grammy` | Telegram bot framework |
| **To add:** `@s402/server` | S402 payment gating middleware |
| **To add:** `@s402/spark` | Spark payment provider |

---

*Last updated: March 18, 2026*
*Status: Planning complete. Ready for Phase 1 implementation.*
