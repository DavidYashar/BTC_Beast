# BTC Beast — Complete Operator Guide

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Autonomous Behaviors (Cron Jobs)](#autonomous-behaviors-cron-jobs)
- [RAG Learning System](#rag-learning-system)
- [Operator Commands (API)](#operator-commands-api)
- [Trading Commands](#trading-commands)
- [How to Call Commands from PowerShell](#how-to-call-commands-from-powershell)
- [Autonomous Trading — Future](#autonomous-trading--future)
- [OpenClaw vs BTC Beast (Standalone)](#openclaw-vs-btc-beast-standalone)
- [Configuration Reference](#configuration-reference)

---

## Architecture Overview

BTC Beast is a **standalone AI agent** deployed on Render (web service + PostgreSQL).

```
┌─────────────────────────────────────────────┐
│                BTC Beast (Render)            │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Twitter  │  │ Wallet   │  │ Command   │ │
│  │ (crons)  │  │ Manager  │  │ Server    │ │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘ │
│       │              │              │       │
│  ┌────┴──────────────┴──────────────┴─────┐ │
│  │          PostgreSQL + pgvector         │ │
│  │       (RAG memories, wallet files)     │ │
│  └────────────────────────────────────────┘ │
│       │              │                      │
│  ┌────┴─────┐  ┌────┴──────┐               │
│  │ OpenAI   │  │ UTXO API  │               │
│  │ (GPT)    │  │ (trading) │               │
│  └──────────┘  └───────────┘               │
└─────────────────────────────────────────────┘
```

### Components

| Component | File | Purpose |
|-----------|------|---------|
| Command Server | `src/commands/webhook.ts` | Express API for operator commands (HMAC-authenticated) |
| Twitter Client | `src/twitter/client.ts` | Posts tweets and replies via rettiwt-api |
| Trending Tweets | `src/twitter/post-trending.ts` | Fetches trending tokens, generates tweet with LLM |
| Mention Handler | `src/twitter/mention-handler.ts` | Polls @mentions, generates replies |
| Engagement | `src/twitter/engagement.ts` | Searches "utxo.fun" tweets, replies with value |
| UTXO Client | `src/utxo-api/client.ts` | All UTXO platform API calls (trending, swap, launch, chat) |
| Wallet Manager | `src/utxo-api/wallet.ts` | Provisions/reconnects wallet, manages session tokens |
| Wallet Store | `src/utxo-api/wallet-store.ts` | Persists wallet files in PostgreSQL (survives redeploys) |
| RAG Memory | `src/memory/store.ts` | Vector memory with similarity search, deduplication |
| LLM | `src/llm/client.ts` | OpenAI chat completion wrapper |
| Personality | `src/personality/prompts.ts` | System prompt defining voice and behavior |

---

## Autonomous Behaviors (Cron Jobs)

Three scheduled tasks run automatically. All schedules configurable via environment variables.

### 1. Post Trending Tweets

**Schedule:** Every 4 hours (`TRENDING_CRON=0 */4 * * *`)

**What it does:**
1. Calls `GET /api/agent/trending?category=all&limit=10` — fetches top 10 trending tokens
2. Formats data: ticker, price, 24h change, holders, bonding progress, TVL
3. Queries RAG memory for the 5 most relevant past tweets about these tokens
4. Sends to LLM with system prompt + trending data + past tweet context
5. LLM generates a fresh tweet (≤ 280 chars)
6. Deduplication check: vector similarity against last 48h of tweets (85% threshold)
7. If too similar → retries with higher temperature
8. Posts to Twitter
9. Stores the tweet text + embedding in RAG memory for future context

**Example output:**
```
$PEPE pumping +340% 24h, 892 holders, still bonding at 67%.
$NODL quietly stacking — TVL 2.1M sats, only 31 holders. Early plays.
Which one you riding? 🐂
```

### 2. Handle @Mentions

**Schedule:** Every 5 minutes (`MENTIONS_CRON=*/5 * * * *`)

**What it does:**
1. Polls Twitter for @mentions newer than `last_mention_id` (stored in DB)
2. For each mention (oldest first):
   - Queries RAG for relevant context about the topic mentioned
   - LLM generates a contextual reply
   - Posts reply to Twitter
   - Marks mention as handled (prevents re-processing)
   - Stores the interaction as a memory

### 3. UTXO Engagement

**Schedule:** Every 15 minutes (`ENGAGEMENT_CRON=*/15 * * * *`)

**What it does:**
1. Searches Twitter for tweets mentioning "utxo.fun"
2. Filters out bot's own tweets
3. Queries RAG for relevant platform knowledge
4. LLM generates value-adding replies (not generic engagement bait)
5. Posts reply, stores interaction

### Startup Behavior

On boot, after database + wallet init, the agent waits 10 seconds then runs an initial trending tweet immediately (doesn't wait for the 4-hour cron).

---

## RAG Learning System

The RAG (Retrieval-Augmented Generation) system is the agent's long-term memory. It uses PostgreSQL + pgvector for vector similarity search.

### What Gets Stored

| Event | Stored As | Used For |
|-------|-----------|----------|
| Every tweet posted | Text + vector embedding | Deduplication, context for future tweets |
| Every mention handled | Mention text + reply + embedding | Learning conversation patterns |
| Every engagement reply | Reply text + embedding | Avoiding repetitive responses |
| Operator `/remember` commands | Manual memory + embedding | Injecting knowledge the agent should know |
| Token snapshots (trending) | Ticker + data (deduped per 3h per ticker) | Historical price context |

### How It's Used

When the agent needs to generate content, it:
1. Takes the current context (e.g., "trending tokens" or "mention about $PEPE")
2. Creates a vector embedding of that context
3. Queries pgvector for the 5 nearest memories (cosine similarity)
4. Includes those memories in the LLM prompt as additional context

**Result:** Over time, the agent learns patterns — which tokens it's talked about, what resonated, what's changed. It won't repeat the same take twice and it builds on its own history.

### For Future Trading (Not Yet Active)

When autonomous trading is added, the RAG system will also store:
- Trade decisions: "Bought $X because volume spiked +200%, TVL growing"
- Trade outcomes: "Sold $X for +15% profit after 6 hours"
- Failed trades: "Bought $Y but it rugged in 30 min, lost 80%"

This means the agent will literally **learn from its own trades** — querying past wins/losses when making future decisions.

---

## Operator Commands (API)

All commands are HMAC-SHA256 authenticated. You call them from your local terminal (PowerShell) to the Render URL.

### Authentication

Every request to `/commands/*` must include:
```
X-Operator-Signature: sha256=<hmac_hex_digest>
```

The signature is computed as: `HMAC-SHA256(OPERATOR_SECRET, request_body_string)`

For GET requests with no body, sign an empty string.

### Existing Commands

#### POST /commands/tweet

Post a tweet — either exact text or LLM-generated from a prompt.

```json
// Option A: Exact text
{ "text": "gm bitcoin degens 🐂" }

// Option B: LLM generates from prompt
{ "prompt": "Write about the current top trending token on UTXO" }
```

**Response:**
```json
{ "ok": true, "tweetId": "1234567890", "text": "the actual tweet text" }
```

#### POST /commands/remember

Inject a memory into the RAG system. The agent will recall this when generating future content.

```json
{ "content": "UTXO.fun has zero platform fees for trading", "type": "manual" }
```

**Response:**
```json
{ "ok": true }
```

#### GET /commands/status

Get agent stats.

**Response:**
```json
{
  "ok": true,
  "uptime": 86400,
  "tweets_posted": 42,
  "mentions_handled": 128,
  "memories": 256
}
```

---

## Trading Commands

These commands use the UTXO platform Agent API. The agent's wallet handles all transactions.

### POST /commands/swap — Buy or Sell Tokens

Buy or sell any token listed on UTXO.fun.

#### BUY (spend sats → receive tokens)

```json
{
  "action": "buy",
  "token": "btkn1abc123...",
  "amount": 5000
}
```

- `amount` = sats you're spending (5000 sats = 0.00005 BTC)
- You receive tokens in return (amount depends on AMM price)

#### SELL (spend tokens → receive sats)

```json
{
  "action": "sell",
  "token": "btkn1abc123...",
  "amount": 50000000
}
```

- `amount` = token units you're selling (base units, accounting for decimals)
- You receive sats in return

#### About BTC vs USDB

The agent swap API operates in **sats only** for buys. There is no `currency` or `denomination` field. To think in dollar terms:

```
1 USDB = 1,000 sats
So if you want to "buy $5 worth":  amount = 5 × 1000 = 5000 sats
```

For sells, amount is always in token base units. Check the token's `decimals` value to know the scaling (e.g., if decimals = 6, then 1 whole token = 1,000,000 base units).

#### Response (both buy and sell):

```json
{
  "success": true,
  "result": {
    "type": "swap",
    "action": "buy",
    "token_address": "btkn1abc123...",
    "amount_in": 5000,
    "amount_out": 250000000,
    "price_per_token": 0.00002,
    "recipient_address": "spark1...",
    "outbound_transfer_id": "tr_xyz..."
  }
}
```

#### Slippage & Fees

- **Slippage tolerance:** 1% (hardcoded, automatic)
- **Integrator fee:** 0.15% for human-created tokens, 0.40% for AI-created tokens (automatic)
- If price moves more than 1% during execution, the swap fails (protecting you)

### POST /commands/launch — Launch a New Token

Create a new token with an automatic bonding curve on UTXO.fun.

```json
{
  "name": "Beast Token",
  "ticker": "BEAST",
  "supply": 1000000000,
  "decimals": 6
}
```

**Response:**
```json
{
  "success": true,
  "result": {
    "type": "launch",
    "token_address": "btkn1newtoken...",
    "name": "Beast Token",
    "ticker": "BEAST",
    "supply": 1000000000,
    "decimals": 6,
    "pool_id": "pool_abc...",
    "trade_url": "https://utxo.fun/token/btkn1newtoken...",
    "issuer_address": "spark1..."
  }
}
```

### POST /commands/balance — Check Wallet Balance

```json
{}
```

**Response:**
```json
{
  "ok": true,
  "address": "spark1abc...",
  "balance_sats": 150000,
  "token_holdings": [
    { "token_id": "btkn1abc...", "balance": "50000000" }
  ]
}
```

### POST /commands/wallet — Provision or Check Wallet

If the agent already has a wallet, returns its address and balance. If no wallet exists, provisions a new one.

```json
{}
```

**Response (existing wallet):**
```json
{
  "ok": true,
  "status": "connected",
  "address": "spark1abc...",
  "balance_sats": 150000,
  "token_holdings": [...]
}
```

**Response (new wallet provisioned):**
```json
{
  "ok": true,
  "status": "provisioned",
  "address": "spark1newaddress...",
  "network": "MAINNET"
}
```

### POST /commands/chat — Post to Token Chat

Post a message on a token's chat page.

```json
{
  "coinId": "btkn1abc123...",
  "message": "Beast is bullish on this one 🐂"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "messageId": "msg_xyz...",
    "coinId": "btkn1abc...",
    "sparkAddress": "spark1..."
  }
}
```

### POST /commands/token-info — Get Token Details

```json
{
  "address": "btkn1abc123..."
}
```

**Response:**
```json
{
  "success": true,
  "token": {
    "name": "Example Token",
    "ticker": "EXMPL",
    "price_sats": 45,
    "tvl_sats": 2100000,
    "volume_24h_sats": 890000,
    "price_change_24h_pct": 12.5,
    "holders": 234,
    "bonding_progress_pct": 78.3
  }
}
```

---

## How to Call Commands from PowerShell

### Setup (run once per session)

```powershell
# Your Render URL and secret
$BaseUrl = "https://utxo-beast.onrender.com"
$Secret = "your_OPERATOR_SECRET_value"

# HMAC signing function
function Sign($body) {
    $hmac = New-Object System.Security.Cryptography.HMACSHA256(
        [Text.Encoding]::UTF8.GetBytes($Secret))
    $hash = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($body))
    "sha256=" + [Convert]::ToHexString($hash).ToLower()
}

# Helper to make signed requests
function Beast($method, $path, $body = "") {
    $headers = @{ "X-Operator-Signature" = Sign $body }
    if ($body) { $headers["Content-Type"] = "application/json" }
    Invoke-RestMethod "$BaseUrl$path" -Method $method -Headers $headers -Body $body
}
```

### Quick Commands

```powershell
# Check status
Beast GET "/commands/status"

# Post exact tweet
Beast POST "/commands/tweet" '{"text":"gm degens 🐂"}'

# Generate tweet from prompt
Beast POST "/commands/tweet" '{"prompt":"Write about top trending tokens"}'

# Inject a memory
Beast POST "/commands/remember" '{"content":"Always be bullish on BTC","type":"manual"}'

# Provision wallet (or check existing)
Beast POST "/commands/wallet" '{}'

# Check wallet balance
Beast POST "/commands/balance" '{}'

# Buy a token (spend 5000 sats)
Beast POST "/commands/swap" '{"action":"buy","token":"btkn1abc...","amount":5000}'

# Sell a token (sell 50M base units)
Beast POST "/commands/swap" '{"action":"sell","token":"btkn1abc...","amount":50000000}'

# Launch a new token
Beast POST "/commands/launch" '{"name":"Beast Token","ticker":"BEAST","supply":1000000000,"decimals":6}'

# Post to token chat
Beast POST "/commands/chat" '{"coinId":"btkn1abc...","message":"Beast is here 🐂"}'

# Get token info
Beast POST "/commands/token-info" '{"address":"btkn1abc..."}'
```

### Dollar Conversion Helper

```powershell
# USDB to sats: 1 USDB = 1000 sats
function Usdb($dollars) { $dollars * 1000 }

# Buy $10 worth of a token
$amount = Usdb 10
Beast POST "/commands/swap" "{`"action`":`"buy`",`"token`":`"btkn1abc...`",`"amount`":$amount}"
```

---

## Autonomous Trading — Future

Currently, trading functions exist but are NOT auto-triggered. The agent only tweets and engages autonomously.

### How Autonomous Trading Would Work

```
┌─────────────────────────────────────────────────┐
│ Cron fires (e.g., every 30 minutes)             │
│                                                 │
│  1. Fetch trending tokens (top 10)              │
│  2. For each token, fetch detailed info:        │
│     - Price, volume, TVL, holders, bonding %    │
│     - 24h price change                          │
│  3. Query RAG: "What do I know about $TICKER?"  │
│     - Past trades, outcomes, patterns            │
│  4. Evaluate criteria:                          │
│     - Volume above threshold?                   │
│     - Positive momentum?                        │
│     - Not already holding too much?             │
│     - Risk budget allows it?                    │
│  5. LLM decides: BUY / SELL / HOLD             │
│     - Given data + RAG context + rules          │
│  6. If BUY/SELL → executeSwap()                 │
│  7. Store decision + reasoning in RAG           │
│  8. Store outcome later (profit/loss tracking)  │
│                                                 │
│  Over time: agent learns which patterns profit  │
└─────────────────────────────────────────────────┘
```

### What the RAG Stores for Trading

| What | Example | Purpose |
|------|---------|---------|
| Trade entry | "Bought $PEPE at 45 sats, volume +200%, 892 holders" | Know what was bought and why |
| Trade exit | "Sold $PEPE at 68 sats, +51% gain after 6 hours" | Learn from wins |
| Failed trade | "Bought $RUG at 12 sats, dropped to 0.3 sats, -97%" | Learn from losses |
| Market patterns | "Tokens with >500 holders and <70% bonding tend to pump" | Pattern recognition |
| Operator rules | "Never invest more than 10000 sats per trade" | Risk management |

### Risk Controls (to be configured)

- **Max per trade:** e.g., 10,000 sats
- **Max portfolio exposure:** e.g., 50,000 sats total in tokens
- **Cooldown between trades:** e.g., minimum 10 minutes
- **Stop loss:** e.g., sell if any position drops 30%
- **Approval threshold:** e.g., trades > 50,000 sats need operator confirmation

---

## OpenClaw vs BTC Beast (Standalone)

### What is OpenClaw?

OpenClaw is an AI agent runtime based on **skills** (SKILL.md instruction files). An OpenClaw agent (like "Clawdbot") reads skills and executes them step-by-step. The `utxo-wallet` skill on ClawHub teaches OpenClaw agents how to interact with UTXO.fun.

### Can an OpenClaw Agent Trade on UTXO?

**Yes, but with significant differences:**

| Capability | OpenClaw + utxo_wallet Skill | BTC Beast (Standalone) |
|-----------|------------------------------|------------------------|
| **Create wallet** | ✅ Via wallet-connect.js | ✅ Via wallet-connect.js |
| **Buy/sell tokens** | ✅ Via `/api/agent/swap` | ✅ Via `/api/agent/swap` |
| **Launch tokens** | ✅ Via `/api/agent/token/launch` | ✅ Via `/api/agent/token/launch` |
| **Browse trending** | ✅ Via `/api/agent/trending` | ✅ Via `/api/agent/trending` |
| **Post to chat** | ✅ Via `/api/agent/chat/message` | ✅ Via `/api/agent/chat/message` |
| **Check balance** | ✅ Via `/api/agent/wallet/balance` | ✅ Via `/api/agent/wallet/balance` |
| **Post to Twitter** | ❌ No Twitter integration | ✅ Autonomous tweeting |
| **RAG memory** | ❌ No persistent memory | ✅ Full pgvector RAG |
| **Scheduled tasks** | ❌ No cron jobs | ✅ Configurable cron |
| **Auto-trading** | ❌ Request/response only | ✅ Can be added |
| **24/7 uptime** | ❌ Runs on local machine | ✅ Cloud-hosted on Render |
| **Wallet persistence** | ⚠️ Local filesystem (lost if machine changes) | ✅ Backed up to PostgreSQL |
| **Session management** | ⚠️ Manual reconnect if expired | ✅ Auto-refresh before expiry |
| **Learning over time** | ❌ Stateless between sessions | ✅ Accumulates memories |

### How OpenClaw Agents Work

1. **Runtime** must run on a local machine (not cloud) — it reads SKILL.md files
2. **No autonomy grades** — OpenClaw doesn't have predefined autonomy levels
3. **Request/response only** — the operator asks it to do something, it does it, that's it
4. **SOUL.md policy** — defines guardrails like "ask before spending > 50k sats"
5. **No scheduled tasks** — cannot auto-trade, auto-tweet, or auto-engage
6. **Encrypted sessions** — same X25519 ECDH handshake as BTC Beast

### Why BTC Beast is Better for Our Use Case

OpenClaw + utxo_wallet is great for **interactive** use — an operator sits at their machine and asks the agent to execute trades. It's like having a smart assistant that follows instructions.

BTC Beast is built for **autonomous operation** — it runs 24/7 on Render, tweets on schedule, replies to mentions, and can be extended to trade autonomously. It has long-term memory and learns from every interaction.

**Bottom line:** OpenClaw agents are users of our platform. BTC Beast is our platform's agent.

---

## Configuration Reference

### Environment Variables (set on Render dashboard)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `10000` | Express server port |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `RETTIWT_API_KEY` | — | Twitter cookie auth (base64) |
| `TWITTER_USERNAME` | — | Bot's Twitter handle |
| `UTXO_API_BASE_URL` | `https://utxo.fun/api/agent` | UTXO platform API |
| `SPARK_AGENT_NETWORK` | `MAINNET` | `MAINNET` or `REGTEST` |
| `OPERATOR_SECRET` | — | HMAC secret for API auth |
| `TRENDING_CRON` | `0 */4 * * *` | Trending tweet schedule |
| `MENTIONS_CRON` | `*/5 * * * *` | Mention check schedule |
| `ENGAGEMENT_CRON` | `*/15 * * * *` | UTXO engagement schedule |

### Changing Autonomy

**Make it less active:**
```
TRENDING_CRON=0 */12 * * *    # tweet every 12 hours instead of 4
MENTIONS_CRON=*/30 * * * *    # check mentions every 30 min instead of 5
ENGAGEMENT_CRON=0 * * * *     # engage every hour instead of 15 min
```

**Disable a behavior entirely:**
Set the cron to a date that never comes: `0 0 31 2 *` (Feb 31 = never)

**Make it more active:**
```
TRENDING_CRON=0 */2 * * *    # tweet every 2 hours
MENTIONS_CRON=*/2 * * * *    # check mentions every 2 min
ENGAGEMENT_CRON=*/5 * * * *  # engage every 5 min
```

After changing env vars on Render, the service restarts automatically with the new schedule.
