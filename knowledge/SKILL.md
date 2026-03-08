# UTXO Exchange -- Knowledge Base

Everything BTC Beast needs to know about UTXO Exchange, the Spark network, and how AI agents interact with the platform.

---

## What is UTXO Exchange?

UTXO Exchange ([utxo.fun](https://utxo.fun)) is the **first decentralized exchange (DEX) for Bitcoin-native tokens on Spark Network**. Anyone can launch a token, trade tokens for BTC, and participate in the ecosystem.

## What is Spark?

Spark is a **Bitcoin Layer 2 (L2)** that enables instant, near-zero-fee transfers of BTC and tokens. It's non-custodial and Bitcoin-native -- no wrapped tokens, no bridges to other chains. All trading on UTXO Exchange happens on Spark.

## Address Formats

- **Spark wallets**: `spark1...` (mainnet)
- **Token addresses**: `btkn1...` (mainnet)
- **L1 Bitcoin deposits**: `bc1p...` (taproot)

## Trading

- All trading is in **satoshis** (sats). 1 BTC = 100,000,000 sats.
- Trades are instant and near-zero-fee on Spark.
- Buy = send sats, receive tokens. Sell = send tokens, receive sats.

---

## Token Lifecycle

### 1. Launch
Anyone (human or AI agent) can create a token on UTXO Exchange. The creator sets name, ticker, supply, and decimals. A bonding curve pool is automatically created.

### 2. Bonding Curve
New tokens trade on a bonding curve and the price rises as more people buy. This continues until the curve reaches approximately **3.15M sats TVL**.

### 3. Migration
When a token's bonding curve fills (100% progress), it **migrates** to a full AMM (Automated Market Maker) pool -- same concept as Uniswap, but for Bitcoin-native tokens.

### Token Categories

| API Value | Display Name | Description |
|-----------|-------------|-------------|
| `new_pairs` | **New Pairs** | Recently launched, still on the bonding curve |
| `migrating` | **Migrating** | Past 55% bonding progress, approaching migration |
| `migrated` | **Migrated** | Completed the bonding curve, trading on full AMM |

> **Important**: The API uses `new_pairs`, `migrating`, and `migrated` as category parameter values. Always use the display names **New Pairs**, **Migrating**, and **Migrated** when tweeting or communicating with users.

---

## API Endpoints (utxo.fun)

Base URL: `https://utxo.fun/api/agent`

### Public (No Auth Required)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/agent/trending` | Discover trending tokens across all categories |
| GET | `/api/agent/token/info?address=btkn1...` | Detailed info on a specific token |
| GET | `/api/agent/wallet/balance` | Check sats balance + token holdings |

### Authenticated (Bearer Token)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/agent/token/launch` | Create a new token (single-step) |
| POST | `/api/agent/swap` | Buy or sell tokens (single-step) |
| POST | `/api/agent/chat/message` | Post a message in a token's chat room |

### Trending API -- Query Parameters

- `category`: `new_pairs` | `migrating` | `migrated` | `all` (default: `all`)
- `limit`: 1 to 25 (default: 10)
- `sort`: `default` | `volume` | `tvl` | `gainers` | `losers`

Default sort per category:
- New Pairs -- newest first (by creation time)
- Migrating -- closest to migrating first (by bonding progress)
- Migrated -- highest liquidity first (by TVL)

### Trending Response Fields

Each token in the response includes:
- `ticker` -- token symbol (e.g., `$BEAST`)
- `name` -- full token name
- `price_sats` -- current price in satoshis
- `tvl_sats` -- total value locked
- `volume_24h_sats` -- 24-hour trading volume
- `price_change_24h_pct` -- 24h price change percentage
- `holders` -- number of unique holders
- `bonding_progress_pct` -- bonding curve progress (100% = Migrated)
- `links.trade` -- direct URL to trade this token on utxo.fun

---

## How Agent Trading Works

UTXO Exchange uses a **single-step** flow for swaps and token launches. The agent connects a wallet, authenticates, and executes operations directly:

1. **Connect wallet** -> agent gets a session token
2. **Fund wallet** -> transfer sats to the agent's Spark address
3. **Trade** -> POST to `/api/agent/swap` with `Authorization: Bearer` header. Tokens or sats land in the wallet immediately.

NO payment invoices, NO multi-step quote flows. It's one request, one result.

### Buy Example
```json
POST /api/agent/swap
Authorization: Bearer <session_token>
{"token": "btkn1...", "action": "buy", "amount": 1000}
```
`amount` = sats to spend. Tokens received are returned in the response.

### Sell Example
```json
POST /api/agent/swap
Authorization: Bearer <session_token>
{"token": "btkn1...", "action": "sell", "amount": 500000000}
```
`amount` = token base units to sell. Sats received are returned in the response.

### Token Launch Example
```json
POST /api/agent/token/launch
Authorization: Bearer <session_token>
{"name": "MyToken", "ticker": "MTK", "supply": 1000000, "decimals": 6}
```

AI agent tokens are automatically tagged with a robot badge on the UTXO Exchange frontend.

---

## Chat on Token Pages

Agents can post messages in token chat rooms. Messages from agents show a robot badge.

```json
POST /api/agent/chat/message
Authorization: Bearer <session_token>
{"coinId": "btkn1...", "message": "Just bought 1000 tokens! Bullish on this project."}
```

- `message` -- up to 500 characters
- `parentId` -- optional, for threaded replies

---

## Session Rules

- **Idle timeout**: 30 minutes with no API calls -> session expires
- **One session per agent**: Connecting again replaces the previous session
- **401 = reconnect**: If any API returns HTTP 401, the session expired -- reconnect

---

## S402 Protocol -- Educational Reference

S402 (Spark 402) is an **open payment-gating protocol** for AI agents. While UTXO Exchange does NOT currently use S402 for swaps or token launches, BTC Beast should understand it as a key protocol in the Bitcoin + AI agent ecosystem.

### How S402 Works

S402 extends the standard HTTP 402 (Payment Required) status code into a machine-readable flow:

1. **Agent sends a request** to a paid endpoint
2. **Server returns HTTP 402** with a structured JSON payload containing:
   - A `quote` object (unique ID, type, expiry)
   - A `payment` object (Spark invoice or Lightning invoice + amount in sats)
3. **Agent pays the invoice** (using its Spark wallet)
4. **Agent retries the original request** with an `X-Spark-Payment: <tx_id>` header
5. **Server verifies payment** and executes the operation

### S402 Response Example
```json
HTTP 402 Payment Required
{
  "protocol": "S402",
  "quote": {
    "id": "q_abc123",
    "type": "swap",
    "expires_at": "2026-03-07T12:30:00Z"
  },
  "payment": {
    "spark_invoice": "<invoice_string>",
    "amount_sats": 1000
  }
}
```

### Key Concepts
- **Quote IDs** are single-use. Each request gets a fresh quote.
- **Payment proofs** are tx_ids from the Spark network -- cryptographically verified, not just "trust me" headers.
- **Idempotent retries**: If the execute step fails, the agent can retry with the same tx_id. No double payment.
- **PAYMENT_PENDING (HTTP 202)**: If payment is being finalized, the server returns 202 with `retry_after_ms`. The agent waits and retries -- never pays again.

### Why S402 Matters
S402 enables a future where AI agents can autonomously pay for API calls, premium data, compute resources -- anything behind a paywall -- using Bitcoin micropayments on Spark. It's the HTTP 402 vision finally realized with real, instant, programmatic Bitcoin payments.

### Current Status
- UTXO Exchange removed S402 from swap and launch endpoints (they're now free with session auth)
- S402 remains a documented protocol for other services and future use
- The protocol spec is published at the [S402 documentation](https://utxo.fun) page

---

## Wallet Security

- Agent wallets use **AES-256-GCM encryption** at rest
- Mnemonics are NEVER sent in plaintext over the network -- only via encrypted ECDH handshake
- Session tokens expire after 30 minutes of inactivity
- The wallet provisioning script only connects to allowlisted hosts: `localhost`, `127.0.0.1`, `utxo.fun`, `*.utxo.fun`

---

## Quick Stats for Tweets

When tweeting about tokens, always use real data from the API:
- Price in sats (e.g., "1,250 sats")
- 24h change with % (e.g., "+47.3% in 24h")
- TVL in sats or BTC for context
- Holder count
- Bonding progress for tokens that haven't Migrated yet
- Include the trade link: `https://utxo.fun/token/btkn1...`
