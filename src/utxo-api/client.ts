const BASE_URL = process.env.UTXO_API_BASE_URL || 'https://utxo.fun/api/agent';

const HEADERS = {
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
