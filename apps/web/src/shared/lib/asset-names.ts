// Ticker → full asset name for the balances panel's Binance-style rows. A small
// curated map covering the operator's current holdings plus the top majors;
// `assetName` falls back to the ticker itself for anything unmapped so a new
// coin still renders (as its ticker) rather than blank.

const ASSET_NAMES: Record<string, string> = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  USDT: 'TetherUS',
  USDC: 'USD Coin',
  BNB: 'BNB',
  SOL: 'Solana',
  XRP: 'XRP',
  ADA: 'Cardano',
  DOGE: 'Dogecoin',
  AVAX: 'Avalanche',
  DOT: 'Polkadot',
  MATIC: 'Polygon',
  LINK: 'Chainlink',
  TRX: 'TRON',
  LTC: 'Litecoin',
  UNI: 'Uniswap',
  ATOM: 'Cosmos',
  AAVE: 'Aave',
  ENA: 'Ethena',
  WLD: 'Worldcoin',
};

/** Full display name for an asset ticker, or the ticker itself when unmapped. */
export function assetName(ticker: string): string {
  return ASSET_NAMES[ticker] ?? ticker;
}
