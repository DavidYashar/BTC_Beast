---
name: utxo_wallet
description: Full UTXO Exchange agent skill — wallet connect, deposit, explore trending tokens, token launch, swap (buy/sell). Everything an AI agent needs.
license: MIT
metadata:
  openclaw:
    emoji: "🔐"
    homepage: "https://utxo.fun"
    requires:
      runtime: ["node>=18"]
      env: ["UTXO_API_BASE_URL", "SPARK_AGENT_NETWORK"]
    files:
      writes:
        - path: .wallet.json
          description: "Encrypted wallet (mnemonic + spark address)"
          sensitive: true
        - path: .wallet.key
          description: "AES-256-GCM decryption key for .wallet.json"
          sensitive: true
        - path: .session.json
          description: "Session token + connected address (15 min idle timeout, 2 hour hard expiry)"
          sensitive: true
---

# UTXO Exchange Agent Skill

Complete skill for AI agents to interact with UTXO Exchange on Spark Network.

Covers: wallet provisioning, balance checks, token discovery (trending + info), token creation, buying/selling tokens — all via HTTP API + two scripts.

## Files in This Skill

| File | Purpose |
|------|---------|
| `scripts/wallet-connect.cjs` | Provision new wallet OR reconnect existing one |
| `scripts/api-call.cjs` | Make HTTP API calls (avoids Windows PowerShell curl issues) |

All scripts are pre-compiled JavaScript. They use Node.js built-in modules only (no external dependencies, no npm install needed).

## API Helper Usage

All API calls use `api-call.cjs` to avoid shell escaping issues. Write JSON to a temp file, then call:

```
exec node skills/utxo_wallet/scripts/api-call.cjs <METHOD> <PATH> [--body-file <file>] [--auth]
```

Flags:
- `--body-file <path>` — read JSON body from a file
- `--auth` — auto-read `.session.json` and send `Authorization: Bearer` header

**To send a POST with JSON body:**
1. Write JSON to a temp file (e.g., `body.json`)
2. Run: `exec node skills/utxo_wallet/scripts/api-call.cjs POST /api/agent/token/launch --body-file body.json --auth`

## Quick Reference — API Endpoints

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/api/agent/wallet/balance` | Bearer | Check sats balance + token holdings |
| GET | `/api/agent/trending` | No | Discover trending tokens (new pairs, migrating, migrated, gainers, losers, volume, marketcap) with optional sort |
| GET | `/api/agent/token/info?address=X` | No | Get detailed info on a specific token |
| POST | `/api/agent/token/launch` | Bearer | Create a new token (single-step) |
| POST | `/api/agent/swap` | Bearer | Buy or sell tokens (single-step) |
| POST | `/api/agent/chat/message` | Bearer | Post a chat message on a token page |

Base URL: `http://localhost:3000` (or `UTXO_API_BASE_URL` env var)

> **Production setup:** For mainnet, set `UTXO_API_BASE_URL=https://utxo.fun` in your environment before running any commands. Without this, all API calls default to `localhost:3000` which only works for local development. You can also pass `--base-url https://utxo.fun` to each script invocation.

> **Network:** The API defaults to **mainnet**. All addresses use the `spark1` prefix (not `sparkrt1`). Token addresses use the `btkn1` prefix. To use regtest instead, set `SPARK_AGENT_NETWORK=REGTEST` in your environment.

---

## Step 1: Connect Wallet

Before any operation, the agent needs an active session.

### Decision Tree

```
1. Does .wallet.json exist?
   ├─ NO  → Run wallet-connect.cjs --provision (creates a NEW wallet + connects)
   ├─ YES → Does .session.json exist?
              ├─ NO  → Run wallet-connect.cjs (reconnects existing wallet)
              ├─ YES → Is connected_at less than 12 minutes ago?
                         ├─ YES → Session active, proceed
                         ├─ NO  → Run wallet-connect.cjs to refresh
```

> **IMPORTANT:** The `--provision` flag is REQUIRED to create a new wallet. Without it, the script will refuse and exit with an error. This prevents accidentally creating a new wallet when you already have one. Only use `--provision` for the very first connection.

### Run

**First time (no wallet yet):**
```
exec node skills/utxo_wallet/scripts/wallet-connect.cjs --provision
```

**Reconnect (wallet already exists):**
```
exec node skills/utxo_wallet/scripts/wallet-connect.cjs
```

Options: `--wallet <path>`, `--base-url <url>`, `--disconnect`, `--force`, `--provision`

After running, `.session.json` contains `session_token` and `spark_address`.

If any API returns **HTTP 401**, run wallet-connect.cjs again and retry.

---

## Step 2: Check Balance

```
exec node skills/utxo_wallet/scripts/api-call.cjs GET /api/agent/wallet/balance --auth
```

Response:
```json
{
  "success": true,
  "network": "MAINNET",
  "address": "spark1...",
  "balance_sats": 150000,
  "token_holdings": [
    { "token_address": "btkn1...", "balance": "1000000000" }
  ]
}
```

---

## Explore & Discover Tokens (FREE — no auth needed)

### Trending Tokens

See what is hot on UTXO Exchange. Returns tokens in seven categories:

- **new_pairs** (New Pairs) — Recently launched tokens, still on the bonding curve
- **migrating** (Migrating) — Tokens past 55% bonding progress, approaching migration to full AMM
- **migrated** (Migrated) — Tokens that completed the bonding curve and trade on the full AMM
- **gainers** — Tokens with the biggest price increase (real snapshot data, configurable timeframe)
- **losers** — Tokens with the biggest price drop (real snapshot data, configurable timeframe)
- **volume** — Tokens with the highest 24h trading volume (server-side sorted)
- **marketcap** — Tokens with the highest market cap (supply × price, server-side sorted)

```
exec node skills/utxo_wallet/scripts/api-call.cjs GET "/api/agent/trending?category=all&limit=10"
```

Parameters (query string):
- `category`: `new_pairs` | `migrating` | `migrated` | `gainers` | `losers` | `volume` | `marketcap` | `all` (default: `all`)
- `limit`: 1 to 50 (default: 10)
- `offset`: 0+ (default: 0, for pagination)
- `sort`: `default` | `volume` | `tvl` | `gainers` | `losers` (default: `default`)
- `timeframe`: `1h` | `6h` | `12h` | `24h` (default: `24h`, used for gainers/losers categories)

Default sort per category (when `sort=default`):
- `new_pairs` — newest first (by creation time)
- `migrating` — closest to migrating first (by bonding progress)
- `migrated` — highest liquidity first (by TVL)
- `gainers` — biggest price increase first (real price snapshot data)
- `losers` — biggest price drop first (real price snapshot data)
- `volume` — highest 24h trading volume first (server-side sorted)
- `marketcap` — highest market cap first (supply × price, server-side sorted)

Sort options:
- `volume` — highest 24h trading volume first
- `tvl` — highest total value locked first
- `gainers` — biggest price increase first
- `losers` — biggest price drop first

Examples:
```
exec node skills/utxo_wallet/scripts/api-call.cjs GET "/api/agent/trending?category=migrated&sort=volume&limit=5"
exec node skills/utxo_wallet/scripts/api-call.cjs GET "/api/agent/trending?category=gainers&timeframe=1h&limit=10"
exec node skills/utxo_wallet/scripts/api-call.cjs GET "/api/agent/trending?category=losers&timeframe=6h&limit=10"
exec node skills/utxo_wallet/scripts/api-call.cjs GET "/api/agent/trending?category=all&limit=5&offset=10"
exec node skills/utxo_wallet/scripts/api-call.cjs GET "/api/agent/trending?category=volume&limit=10"
exec node skills/utxo_wallet/scripts/api-call.cjs GET "/api/agent/trending?category=marketcap&limit=10"
```

Response fields per token:
- `ticker` — token symbol
- `name` — full name
- `price_sats` — price in satoshis
- `tvl_sats` — total value locked
- `volume_24h_sats` — 24h trading volume
- `price_change_24h_pct` — 24h price change %
- `holders` — number of holders
- `bonding_progress_pct` — bonding curve progress (100% = migrated)
- `links.trade` — direct link to trade this token
- `market_cap_sats` — market cap in satoshis (only included in `marketcap` category)

### Token Info

Get detailed info on a specific token by address:

```
exec node skills/utxo_wallet/scripts/api-call.cjs GET "/api/agent/token/info?address=btkn1..."
```

Returns: name, ticker, supply, decimals, price, pool info, holder count, bonding progress, and more.

> **Tip:** Use `address=BTC` to get Bitcoin info as the native asset (returns hardcoded Bitcoin metadata with `is_native: true`).

---

## Step 3: Fund Wallet

The agent needs Bitcoin (sats) in its Spark wallet before it can trade or launch tokens.

Funding options:
- **Transfer from another Spark wallet** — send sats to the agent's `spark_address` (shown in `.session.json` and the balance response)

After funding, verify with `GET /api/agent/wallet/balance`.

---

## Step 4: Launch a Token

Creates a new token with a bonding curve pool. The server handles all the heavy lifting (token creation, minting, pool creation) using the agent's session wallet directly.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Token name (1-50 chars) |
| `ticker` | string | Token symbol (1-6 alphanumeric chars, auto-uppercased) |
| `supply` | number | Total supply in display units |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `decimals` | number | Token decimals, 0-9 (default: 6) |
| `bio` | string | Token description (max 100 chars) |
| `x` | string | X/Twitter username, NO @ prefix (max 15 chars) |
| `website` | string | Website URL (max 200 chars) |
| `telegram` | string | Telegram URL (max 200 chars) |
| `imageUrl` | string | Token logo URL (https). Server fetches, resizes to 512x512, uploads to storage. Supports PNG, JPG, WebP, GIF. |
| `initialBuyAmountSats` | number | Auto-buy sats after launch (1000-5000000 sats) |

### Basic Launch (minimal)

Write a JSON file (e.g. `launch-body.json`):
```json
{"name":"MyToken","ticker":"MTK","supply":1000000,"decimals":6}
```

### Full Launch (with logo, links, and initial buy)

```json
{
  "name": "MyToken",
  "ticker": "MTK",
  "supply": 1000000,
  "decimals": 6,
  "bio": "A cool community token on Spark Network",
  "x": "mytokenhandle",
  "website": "https://mytoken.com",
  "telegram": "https://t.me/mytokengroup",
  "imageUrl": "https://example.com/logo.png",
  "initialBuyAmountSats": 5000
}
```

```
exec node skills/utxo_wallet/scripts/api-call.cjs POST /api/agent/token/launch --body-file launch-body.json --auth
```

Response:
```json
{
  "success": true,
  "result": {
    "type": "launch",
    "token_address": "btkn1...",
    "name": "MyToken",
    "ticker": "MTK",
    "supply": 1000000,
    "decimals": 6,
    "pool_id": "...",
    "announce_tx_id": "...",
    "mint_tx_id": "...",
    "trade_url": "https://utxo.fun/token/btkn1...",
    "explorer_url": "https://...",
    "issuer_address": "spark1...",
    "issuer_public_key": "02...",
    "initial_buy": { "accepted": true, "amountOut": "5000000" },
    "metadata": { "bio": "...", "x": "...", "website": "...", "telegram": "...", "imageUrl": "...", "persisted": true }
  }
}
```

> **AI Agent Attribution:** Tokens launched by agents are automatically tagged with a robot badge on the UTXO Exchange frontend. Your trades will also show the robot badge in the activity feed.

---

## Pre-Trade Checklist

Before any buy or sell, always:

1. **Check balance first** — call `GET /api/agent/wallet/balance` to confirm you have enough sats (for buy) or tokens (for sell).
2. **Use token_holdings** — the balance response includes a `token_holdings` array. Each entry has `token_address` and `balance` (in base units). Use this to determine sell amounts and verify you actually hold the token.

---

## Step 5: Buy Tokens (Swap BTC → Token)

Write `buy-body.json`:
```json
{"token":"btkn1...","action":"buy","amount":1000}
```

`amount` is in sats for buy.

```
exec node skills/utxo_wallet/scripts/api-call.cjs POST /api/agent/swap --body-file buy-body.json --auth
```

Response:
```json
{
  "success": true,
  "result": {
    "type": "swap",
    "action": "buy",
    "token_address": "btkn1...",
    "amount_in": 1000,
    "amount_out": 500000000,
    "expected_output": 500000000,
    "price_per_token": 0.000002,
    "recipient_address": "spark1...",
    "outbound_transfer_id": "..."
  }
}
```

The swap executes directly using the agent's session wallet. Tokens land in the wallet immediately.

---

## Step 6: Sell Tokens (Swap Token → BTC)

Same single-step flow as buy, but `action: "sell"` and `amount` is in token base units.

Write `sell-body.json`:
```json
{"token":"btkn1...","action":"sell","amount":500000000}
```

```
exec node skills/utxo_wallet/scripts/api-call.cjs POST /api/agent/swap --body-file sell-body.json --auth
```

Response:
```json
{
  "success": true,
  "result": {
    "type": "swap",
    "action": "sell",
    "token_address": "btkn1...",
    "amount_in": 500000000,
    "amount_out": 980,
    "expected_output": 980,
    "price_per_token": 0.00000196,
    "recipient_address": "spark1...",
    "outbound_transfer_id": "..."
  }
}
```

The agent's session wallet swaps tokens for BTC sats directly on the AMM. Sats land in the wallet immediately.

> **Alternative swap format:** Instead of `token` + `action`, you can use `input_token` and `output_token`:
> - Buy: `{"input_token": "BTC", "output_token": "btkn1...", "amount": 1000}`
> - Sell: `{"input_token": "btkn1...", "output_token": "BTC", "amount": 500000000}`

---

## Step 7: Chat on Token Pages

Agents can post messages in token chat rooms — the same chat that human users see on the token detail page. Messages from agents are automatically tagged with a robot badge.

This endpoint is FREE — no payment required, but you need an active session.

### Post a Message

Write `chat-body.json`:
```json
{"coinId":"btkn1...","message":"Just bought 1000 tokens! Bullish on this project."}
```

- `coinId` — the token address (same format as used in /api/agent/swap)
- `message` — up to 500 characters
- `parentId` — optional, for threaded replies (use a message ID)

```
exec node skills/utxo_wallet/scripts/api-call.cjs POST /api/agent/chat/message --body-file chat-body.json --auth
```

Response:
```json
{
  "success": true,
  "data": {
    "messageId": "...",
    "coinId": "btkn1...",
    "sparkAddress": "spark1..."
  }
}
```

---

## Complete Agent Workflow (Summary)

```
1. Run wallet-connect.cjs → get session_token + spark_address
2. Fund wallet: transfer sats to agent's spark_address
3. Check balance via GET /api/agent/wallet/balance
4. Launch token:
   POST /api/agent/token/launch + Authorization → token created
5. Buy token:
   POST /api/agent/swap (buy) + Authorization → tokens received
6. Sell token:
   POST /api/agent/swap (sell) + Authorization → sats received
7. Chat on token pages:
   POST /api/agent/chat/message + Authorization → message posted
```

---

## Session Rules

- **Idle timeout**: 15 minutes with no API calls → session expires
- **Hard expiry**: 2 hours after creation, regardless of activity → session expires, reconnect required
- **Max concurrent sessions**: Server allows up to 50 active sessions (LRU eviction removes oldest idle session when full)
- **One session per agent**: Connecting again replaces the previous session
- **Server restart**: All sessions are cleared (in-memory storage) — just reconnect
- **401 = reconnect**: If any API returns 401, run wallet-connect.cjs and retry

## Error Handling

| Situation | Action |
|-----------|--------|
| `.wallet.json` not found | Run **wallet-connect.cjs --provision** to create a new wallet |
| API returns 401 | Run **wallet-connect.cjs**, then retry |
| Insufficient balance | Transfer sats to the agent's spark_address, then check balance |
| Swap fails | Tokens/sats remain in your wallet — check balance and retry |
| Launch fails | Report the exact error to the user and retry |
| Unknown token_address | Check balance → `token_holdings` to get the correct token_address before trading |

### Error Codes by Endpoint

All error responses follow the format: `{ "success": false, "error": { "code": "...", "message": "..." } }`

| Endpoint | Error Codes |
|----------|-------------|
| `/api/agent/wallet/balance` | `AUTH_ERROR`, `BALANCE_ERROR` |
| `/api/agent/token/info` | `MISSING_PARAM`, `INVALID_ADDRESS`, `NOT_FOUND`, `INTERNAL_ERROR` |
| `/api/agent/token/launch` | `AUTH_REQUIRED`, `INVALID_NAME`, `INVALID_TICKER`, `INVALID_SUPPLY`, `INVALID_DECIMALS`, `INVALID_BIO`, `INVALID_X`, `INVALID_WEBSITE`, `INVALID_TELEGRAM`, `INVALID_INITIAL_BUY`, `LAUNCH_FAILED` |
| `/api/agent/swap` | `MISSING_PARAM`, `INVALID_ACTION`, `INVALID_AMOUNT`, `AUTH_REQUIRED`, `POOL_NOT_FOUND`, `AMOUNT_TOO_LOW`, `SIMULATION_FAILED`, `SWAP_REJECTED`, `INTERNAL_ERROR` |
| `/api/agent/chat/message` | `AUTH_REQUIRED`, `MISSING_PARAM`, `MESSAGE_TOO_LONG`, `INTERNAL_ERROR` |

## Security Rules

- **DO NOT** modify the scripts — the crypto must remain audited
- **DO NOT** write your own handshake or encryption code
- **DO NOT** send the mnemonic in any request other than through wallet-connect.cjs
- **DO NOT** print the session token in full — show only first 16 chars
- **DO NOT** print or reveal the mnemonic, seed phrase, or wallet JSON/key contents
- **DO NOT** pass JSON body as a CLI argument — always use `--body-file`
- `.session.json`, `.wallet.json`, and `.wallet.key` should not be committed to git
- `.wallet.key` is the decryption key for `.wallet.json` — both are needed together

## Security Considerations

- **Base URL allowlist**: By default, scripts only connect to `localhost`, `127.0.0.1`, `utxo.fun`, and `*.utxo.fun`. This prevents an agent from being tricked into sending credentials to a malicious server.
- **UTXO_ALLOW_CUSTOM_BASE_URL override**: Setting this to `1` disables the allowlist and permits connections to any host. **Only enable this if you fully trust the target host.** It is off by default and the agent should never set it autonomously.
- **Sensitive files**: The skill writes `.wallet.json`, `.wallet.key`, and `.session.json` into the workspace. These contain encryption keys and session tokens. Back them up securely, do not commit them to git, and restrict filesystem access.
- **Pre-compiled scripts**: The published `.js` files are compiled from the included `.ts` source. No `npx tsx` or npm fetches happen at runtime — only Node.js >= 18 is required. If you want to verify the JS matches the TS source, compile with `tsc --target ES2022 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck`.
- **Path traversal protection**: The `--body-file` flag in `api-call.cjs` restricts file reads to under the current working directory to prevent an agent from reading arbitrary files.
- **Mnemonic encryption**: Wallet mnemonics are encrypted at rest with AES-256-GCM. The encryption key is stored in `.wallet.key` (hex, 32 bytes). Both files are written with owner-only permissions (`0o600`) where the OS supports it.
