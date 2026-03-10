import { getSessionToken, handleAuthError } from './wallet.js';

const BASE_URL = process.env.UTXO_API_BASE_URL || 'https://utxo.fun/api/agent';

const HEADERS: Record<string, string> = {
  'User-Agent': 'BTCBeast/1.0 (https://utxo.fun)',
  'Accept': 'application/json',
};

export interface TrendingToken {
  ticker: string;
  name: string;
  address: string;
  price_sats: number;
  tvl_sats: number;
  volume_24h_sats: number;
  price_change_24h_pct: number;
  holders: number;
  bonding_progress_pct: number;
  links: { trade: string };
}

export interface TrendingResponse {
  success: boolean;
  category: string;
  new_pairs?: TrendingToken[];
  migrating?: TrendingToken[];
  migrated?: TrendingToken[];
}

export interface TokenInfo {
  name: string;
  ticker: string;
  address: string;
  supply: string;
  decimals: number;
  price_sats: number;
  tvl_sats: number;
  volume_24h_sats: number;
  price_change_24h_pct: number;
  holders: number;
  bonding_progress_pct: number;
  description?: string;
  links: { trade: string };
}

/**
 * Fetch trending tokens from UTXO Exchange.
 */
export async function fetchTrending(
  category: 'new_pairs' | 'migrating' | 'migrated' | 'all' = 'all',
  limit: number = 10,
): Promise<TrendingToken[]> {
  const url = `${BASE_URL}/trending?category=${category}&limit=${limit}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Trending API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as TrendingResponse;

  // Flatten category arrays into a single list
  const raw = [
    ...(data.new_pairs ?? []),
    ...(data.migrating ?? []),
    ...(data.migrated ?? []),
  ];

  // Map API field names to our interface
  return raw.map((t: any) => ({
    ticker: t.ticker,
    name: t.name,
    address: t.token_address ?? t.address,
    price_sats: t.price_sats,
    tvl_sats: t.tvl_sats,
    volume_24h_sats: t.volume_24h_sats,
    price_change_24h_pct: t.price_change_24h_pct,
    holders: t.holders ?? 0,
    bonding_progress_pct: t.bonding_progress_pct,
    links: t.links ?? { trade: '' },
  }));
}

/**
 * Fetch detailed info about a specific token.
 */
export async function fetchTokenInfo(address: string): Promise<TokenInfo> {
  const url = `${BASE_URL}/token/info?address=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Token info API ${res.status}: ${await res.text()}`);
  return (await res.json()) as TokenInfo;
}

/**
 * Format trending tokens into human-readable summary for LLM context.
 */
export function formatTrendingForPrompt(tokens: TrendingToken[]): string {
  if (tokens.length === 0) return 'No trending tokens found.';
  return tokens
    .map((t, i) => {
      const change = t.price_change_24h_pct >= 0
        ? `+${t.price_change_24h_pct.toFixed(1)}%`
        : `${t.price_change_24h_pct.toFixed(1)}%`;
      const bonding = t.bonding_progress_pct < 100
        ? `bonding ${t.bonding_progress_pct.toFixed(0)}%`
        : 'migrated';
      return `${i + 1}. $${t.ticker} (${t.name}) — ${t.price_sats} sats, ${change} 24h, ${t.holders} holders, ${bonding}, TVL ${t.tvl_sats} sats`;
    })
    .join('\n');
}

/**
 * Format a single token's info for LLM context.
 */
export function formatTokenInfoForPrompt(t: TokenInfo): string {
  const change = t.price_change_24h_pct >= 0
    ? `+${t.price_change_24h_pct.toFixed(1)}%`
    : `${t.price_change_24h_pct.toFixed(1)}%`;
  const bonding = t.bonding_progress_pct < 100
    ? `bonding ${t.bonding_progress_pct.toFixed(0)}%`
    : 'migrated';
  return [
    `$${t.ticker} (${t.name})`,
    `Price: ${t.price_sats} sats (${change} 24h)`,
    `TVL: ${t.tvl_sats} sats | Volume 24h: ${t.volume_24h_sats} sats`,
    `Holders: ${t.holders} | Status: ${bonding}`,
    t.description ? `Description: ${t.description}` : '',
    `Trade: ${t.links.trade}`,
  ].filter(Boolean).join('\n');
}

// ─── Authenticated API Calls (require wallet session) ───

/** Helper: make an authenticated request with auto-retry on 401 */
async function authFetch(urlPath: string, opts: RequestInit = {}): Promise<Response> {
  const token = await getSessionToken();
  const headers: Record<string, string> = {
    ...HEADERS,
    'Authorization': `Bearer ${token}`,
    ...(opts.headers as Record<string, string> || {}),
  };

  let res = await fetch(`${BASE_URL}${urlPath}`, { ...opts, headers });

  // Auto-retry once on 401 (session expired)
  if (res.status === 401) {
    const newToken = await handleAuthError();
    headers['Authorization'] = `Bearer ${newToken}`;
    res = await fetch(`${BASE_URL}${urlPath}`, { ...opts, headers });
  }

  return res;
}

// ─── Balance ───

export interface BalanceResponse {
  ok: boolean;
  address: string;
  balance_sats: number;
  token_holdings: Array<{ token_id: string; balance: string }>;
}

export async function fetchBalance(): Promise<BalanceResponse> {
  const res = await authFetch('/wallet/balance');
  if (!res.ok) throw new Error(`Balance API ${res.status}: ${await res.text()}`);
  return (await res.json()) as BalanceResponse;
}

// ─── Swap (Buy/Sell) ───

export interface SwapRequest {
  token: string;
  action: 'buy' | 'sell';
  amount: number;
}

export interface SwapResult {
  success: boolean;
  result: {
    type: 'swap';
    action: 'buy' | 'sell';
    token: string;
    amount_in: string;
    amount_out: string;
    tx_id: string;
    pool_id: string;
  };
}

export async function executeSwap(params: SwapRequest): Promise<SwapResult> {
  const res = await authFetch('/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`Swap API ${res.status}: ${await res.text()}`);
  return (await res.json()) as SwapResult;
}

// ─── Token Launch ───

export interface LaunchRequest {
  name: string;
  ticker: string;
  supply: number;
  decimals: number;
  initialBuyAmountSats?: number;
  bio?: string;
  x?: string;
  website?: string;
  telegram?: string;
  imageUrl?: string;
}

export interface LaunchResult {
  success: boolean;
  result: {
    type: 'launch';
    token_address: string;
    name: string;
    ticker: string;
    supply: number;
    decimals: number;
    pool_id: string;
    trade_url: string;
    issuer_address: string;
    issuer_public_key?: string;
    initial_buy?: {
      accepted: boolean;
      amountOut?: string;
      error?: string;
    } | null;
  };
}

export async function launchToken(params: LaunchRequest): Promise<LaunchResult> {
  const res = await authFetch('/token/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`Launch API ${res.status}: ${await res.text()}`);
  return (await res.json()) as LaunchResult;
}

// ─── Chat Message ───

export interface ChatRequest {
  coinId: string;
  message: string;
  parentId?: string;
}

export interface ChatResult {
  success: boolean;
  data: {
    messageId: string;
    coinId: string;
    sparkAddress: string;
  };
}

export async function postChatMessage(params: ChatRequest): Promise<ChatResult> {
  const res = await authFetch('/chat/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`Chat API ${res.status}: ${await res.text()}`);
  return (await res.json()) as ChatResult;
}

// ─── Format helpers for trading context ───

export function formatBalanceForPrompt(balance: BalanceResponse): string {
  const lines = [
    `Wallet: ${balance.address}`,
    `BTC Balance: ${balance.balance_sats} sats`,
  ];
  if (balance.token_holdings.length > 0) {
    lines.push('Token Holdings:');
    for (const h of balance.token_holdings) {
      lines.push(`  ${h.token_id}: ${h.balance} units`);
    }
  } else {
    lines.push('Token Holdings: none');
  }
  return lines.join('\n');
}
