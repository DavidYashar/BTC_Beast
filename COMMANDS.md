# BTC Beast — Command Reference

All commands require HMAC-SHA256 authentication via the `X-Operator-Signature` header.

> **Note:** Twitter crons (trending tweets, mention replies, engagement) start **automatically on boot**. Use the stop/start commands below to control them at runtime.

---

## Setup (PowerShell)

Run once per terminal session:

```powershell
$BaseUrl = "https://utxo-beast.onrender.com"
$Secret = "your_OPERATOR_SECRET_value"

function Sign($body) {
    $hmac = New-Object System.Security.Cryptography.HMACSHA256(
        [Text.Encoding]::UTF8.GetBytes($Secret))
    $hash = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($body))
    "sha256=" + [Convert]::ToHexString($hash).ToLower()
}

function Beast($method, $path, $body = "") {
    $headers = @{ "X-Operator-Signature" = Sign $body }
    if ($body) { $headers["Content-Type"] = "application/json" }
    Invoke-RestMethod "$BaseUrl$path" -Method $method -Headers $headers -Body $body
}
```

## Setup (Render Shell / Bash)

Use this from Render Shell or any Linux/macOS terminal. From inside Render Shell, use `localhost:10000` (internal port). From outside, use the public URL.

> **Important:** Multi-line `curl` with backslash continuations (`\`) can break when pasted into Render Shell. The function below uses single-line `curl` commands to avoid this.

```bash
BASE_URL="http://localhost:10000"   # Use https://utxo-beast.onrender.com from outside Render
SECRET="$OPERATOR_SECRET"           # Auto-reads from env var on Render

beast() {
  local METHOD=$1 URL_PATH=$2 BODY="${3:-}"
  local SIG="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"
  if [ -n "$BODY" ]; then
    curl -s -X "$METHOD" "$BASE_URL$URL_PATH" -H "X-Operator-Signature: $SIG" -H "Content-Type: application/json" -d "$BODY"
  else
    curl -s -X "$METHOD" "$BASE_URL$URL_PATH" -H "X-Operator-Signature: $SIG"
  fi
  echo ""
}
```

---

## Twitter Commands

### POST /commands/tweet

Post a tweet — exact text or LLM-generated.

```powershell
# Exact text
Beast POST "/commands/tweet" '{"text":"gm bitcoin degens"}'

# LLM generates from prompt
Beast POST "/commands/tweet" '{"prompt":"Write about the top trending token on UTXO"}'
```

```bash
# Exact text
beast POST /commands/tweet '{"text":"gm bitcoin degens"}'

# LLM generates from prompt
beast POST /commands/tweet '{"prompt":"Write about the top trending token on UTXO"}'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | one of | Exact tweet text (max 280 chars) |
| `prompt` | string | one of | Instruction for LLM to generate tweet |

---

## Twitter Cron Control

All three Twitter behaviors run automatically on startup. Use these to control them without redeploying.

**Behaviors:** `trending` (tweets every 4h), `mentions` (replies every 5min), `engagement` (UTXO mentions every 15min)

### POST /commands/start-tweeting

```powershell
# Resume all
Beast POST "/commands/start-tweeting" '{}'

# Resume only trending
Beast POST "/commands/start-tweeting" '{"behaviors":["trending"]}'
```

```bash
beast POST /commands/start-tweeting '{}'
beast POST /commands/start-tweeting '{"behaviors":["trending"]}'
```

### POST /commands/stop-tweeting

```powershell
# Stop all
Beast POST "/commands/stop-tweeting" '{}'

# Stop only engagement
Beast POST "/commands/stop-tweeting" '{"behaviors":["engagement"]}'
```

```bash
beast POST /commands/stop-tweeting '{}'
beast POST /commands/stop-tweeting '{"behaviors":["engagement"]}'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `behaviors` | string[] | no | `["trending"]`, `["mentions"]`, `["engagement"]`, or omit for all |

### GET /commands/cron-status

```powershell
Beast GET "/commands/cron-status"
```

```bash
beast GET /commands/cron-status
```

Returns running/paused state, schedule, last run time, and last error for each behavior.

---

## Memory

### POST /commands/remember

Inject knowledge into the agent's RAG memory. It will recall this in future tweets and replies.

```powershell
Beast POST "/commands/remember" '{"content":"UTXO.fun has zero platform fees","type":"manual"}'
```

```bash
beast POST /commands/remember '{"content":"UTXO.fun has zero platform fees","type":"manual"}'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | yes | Text to remember |
| `type` | string | no | Memory type (default: `"manual"`) |

---

## Status

### GET /commands/status

```powershell
Beast GET "/commands/status"
```

```bash
beast GET /commands/status
```

Returns uptime, tweets posted count, mentions handled count, and total memories.

---

## Wallet

### POST /commands/wallet

Provision a new wallet or check the current one. Send empty body.

```powershell
Beast POST "/commands/wallet" '{}'
```

```bash
beast POST /commands/wallet '{}'
```

Returns `status: "connected"` (existing wallet) or `status: "provisioned"` (new wallet).

### POST /commands/balance

```powershell
Beast POST "/commands/balance" '{}'
```

```bash
beast POST /commands/balance '{}'
```

Returns BTC balance in sats and all token holdings.

---

## Token Swap (Buy / Sell)

### POST /commands/swap

Buy or sell any token on UTXO.fun. Uses the agent's wallet.

#### Buy (spend sats → receive tokens)

```powershell
Beast POST "/commands/swap" '{"action":"buy","token":"btkn1abc123...","amount":5000}'
```

```bash
beast POST /commands/swap '{"action":"buy","token":"btkn1abc123...","amount":5000}'
```

- `amount` = **sats to spend** (1 USDB ≈ 1,000 sats)
- You receive tokens in return (amount depends on AMM price)

#### Sell (spend tokens → receive sats)

```powershell
Beast POST "/commands/swap" '{"action":"sell","token":"btkn1abc123...","amount":50000000}'
```

```bash
beast POST /commands/swap '{"action":"sell","token":"btkn1abc123...","amount":50000000}'
```

- `amount` = **token base units to sell** (check token's `decimals` for scaling)
- You receive sats in return

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | yes | `"buy"` or `"sell"` |
| `token` | string | yes | Token address (`btkn1...`) |
| `amount` | number | yes | Sats (buy) or token units (sell) |

**Slippage:** 1% tolerance (automatic). Swap fails if price moves beyond that.

**Dollar shortcut:**
```powershell
# 1 USDB = 1,000 sats
# Buy $10 worth:
Beast POST "/commands/swap" '{"action":"buy","token":"btkn1abc...","amount":10000}'
```

```bash
# 1 USDB = 1,000 sats — Buy $10 worth:
beast POST /commands/swap '{"action":"buy","token":"btkn1abc...","amount":10000}'
```

---

## Token Launch (Create New Token)

### POST /commands/launch

Create a new token with a bonding curve on UTXO.fun.

```powershell
Beast POST "/commands/launch" '{"name":"Beast Token","ticker":"BEAST","supply":1000000000,"decimals":6}'
```

```bash
beast POST /commands/launch '{"name":"Beast Token","ticker":"BEAST","supply":1000000000,"decimals":6}'
```

With optional initial buy + metadata:

```powershell
Beast POST "/commands/launch" '{
  "name":"Beast Token",
  "ticker":"BEAST",
  "supply":1000000000,
  "decimals":6,
  "initialBuyAmountSats":5000,
  "bio":"The official BTC Beast token",
  "x":"beast_btc15135",
  "website":"https://utxo.fun"
}'
```

```bash
beast POST /commands/launch '{"name":"Beast Token","ticker":"BEAST","supply":1000000000,"decimals":6,"initialBuyAmountSats":5000,"bio":"The official BTC Beast token","x":"beast_btc15135","website":"https://utxo.fun"}'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Token name |
| `ticker` | string | yes | Token ticker (auto-uppercased) |
| `supply` | number | yes | Total supply in base units |
| `decimals` | number | no | Decimal places (default: 6) |
| `initialBuyAmountSats` | number | no | Sats to spend buying your own token at launch |
| `bio` | string | no | Token description |
| `x` | string | no | Twitter handle |
| `website` | string | no | Website URL |
| `telegram` | string | no | Telegram link |
| `imageUrl` | string | no | Token icon URL |

**Response includes:** `token_address`, `pool_id`, `trade_url`, `issuer_address`

---

## Token Chat

### POST /commands/chat

Post a message on a token's chat page.

```powershell
Beast POST "/commands/chat" '{"coinId":"btkn1abc...","message":"Beast is bullish on this one"}'
```

```bash
beast POST /commands/chat '{"coinId":"btkn1abc...","message":"Beast is bullish on this one"}'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `coinId` | string | yes | Token address (`btkn1...`) |
| `message` | string | yes | Chat message text |
| `parentId` | string | no | Reply to a specific message |

---

## Token Info

### POST /commands/token-info

Get price, TVL, volume, holders, and bonding progress for any token.

```powershell
Beast POST "/commands/token-info" '{"address":"btkn1abc..."}'
```

```bash
beast POST /commands/token-info '{"address":"btkn1abc..."}'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `address` | string | yes | Token address (`btkn1...`) |

**Response:** name, ticker, price_sats, tvl_sats, volume_24h_sats, price_change_24h_pct, holders, bonding_progress_pct

---

## UTXO Agent API Endpoints (Under the Hood)

These are the UTXO.fun platform APIs that BTC Beast calls internally. You don't call these directly — they're handled by the commands above.

| UTXO API | Used By | Auth |
|----------|---------|------|
| `GET /api/agent/trending` | Trending tweets cron | No |
| `GET /api/agent/token/info` | `/commands/token-info` | No |
| `GET /api/agent/wallet/balance` | `/commands/balance` | Bearer token |
| `POST /api/agent/swap` | `/commands/swap` | Bearer token |
| `POST /api/agent/token/launch` | `/commands/launch` | Bearer token |
| `POST /api/agent/chat/message` | `/commands/chat` | Bearer token |
| `GET /api/agent/fees` | Fee checking (coming soon) | Bearer token |
| `POST /api/agent/fees/claim` | Fee claiming (coming soon) | Bearer token |

The agent's wallet session (Bearer token) is managed automatically — it auto-provisions on first boot and auto-refreshes before expiry.

---

## Database Management (Render Shell)

BTC Beast stores wallet files in PostgreSQL (not the filesystem). Use these commands from the Render Shell to manage the database directly.

### Connect to Database

```bash
psql $DATABASE_URL
```

### List All Tables

```bash
psql $DATABASE_URL -c "\dt"
```

Tables: `agent_state`, `agent_wallet_files`, `knowledge`, `memories`, `mentions_handled`, `operator_commands`, `token_snapshots`, `tweets_posted`

### Inspect Table Schema

```bash
psql $DATABASE_URL -c "\d agent_wallet_files"
```

### View Wallet Files

```bash
psql $DATABASE_URL -c "SELECT filename, length(content) as size, updated_at FROM agent_wallet_files;"
```

### Back Up Wallet

```bash
psql $DATABASE_URL -c "COPY agent_wallet_files TO STDOUT;" > /tmp/wallet_backup.txt
```

### Reset Wallet (provision fresh)

Deletes the current wallet so the next `/commands/wallet` call creates a new one with a new identity key and spark address.

```bash
# Back up first
psql $DATABASE_URL -c "COPY agent_wallet_files TO STDOUT;" > /tmp/wallet_backup.txt

# Delete wallet + session records
psql $DATABASE_URL -c "DELETE FROM agent_wallet_files;"

# Provision fresh wallet
beast POST /commands/wallet '{}'
```

### Restore Wallet from Backup

```bash
# Clear current
psql $DATABASE_URL -c "DELETE FROM agent_wallet_files;"

# Restore
psql $DATABASE_URL -c "COPY agent_wallet_files FROM STDIN;" < /tmp/wallet_backup.txt

# Reconnect
beast POST /commands/wallet '{}'
```

> **Warning:** Deleting the wallet is irreversible if you don't have a backup. The wallet's mnemonic and encryption key are stored only in this table.
