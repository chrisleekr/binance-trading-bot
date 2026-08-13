export type BinanceMode = 'live' | 'test';

export interface BinanceEndpointSet {
  readonly rest: Readonly<Record<BinanceMode, string>>;
  readonly marketStream: Readonly<Record<BinanceMode, string>>;
  readonly userStream: Readonly<Record<BinanceMode, string>>;
}

const DEFAULT_ENDPOINTS: BinanceEndpointSet = {
  rest: {
    live: 'https://api.binance.com',
    test: 'https://testnet.binance.vision',
  },
  marketStream: {
    live: 'wss://stream.binance.com:9443/stream',
    test: 'wss://testnet.binance.vision/stream',
  },
  userStream: {
    live: 'wss://ws-api.binance.com:443/ws-api/v3',
    test: 'wss://ws-api.testnet.binance.vision/ws-api/v3',
  },
};

const OVERRIDE_KEYS = ['BINANCE_REST_URL', 'BINANCE_MARKET_WS_URL', 'BINANCE_USER_WS_URL'] as const;

const assertLoopbackUrl = (key: (typeof OVERRIDE_KEYS)[number], raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${key} must be a valid URL`);
  }
  const expectedProtocol = key === 'BINANCE_REST_URL' ? 'http:' : 'ws:';
  if (url.protocol !== expectedProtocol) {
    throw new Error(`${key} must use ${expectedProtocol} in app-e2e`);
  }
  // Literal addresses only. `localhost` is a NAME, resolved at connect time, so
  // an /etc/hosts entry or a rebinding resolver can point it off-box and defeat
  // the check this function exists to make.
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(`${key} must target loopback in app-e2e`);
  }
  return raw.replace(/\/+$/, '');
};

/**
 * Production endpoints are fixed. A complete loopback-only override is accepted
 * only for the explicit test app-e2e runtime, so operator input cannot turn the
 * Binance client into a general outbound-request surface.
 */
export const resolveBinanceEndpoints = (
  raw: NodeJS.ProcessEnv = process.env,
): BinanceEndpointSet => {
  const requested = OVERRIDE_KEYS.some((key) => raw[key] !== undefined);
  if (!requested) return DEFAULT_ENDPOINTS;
  if (raw['NODE_ENV'] !== 'test' || raw['APP_E2E'] !== '1') {
    throw new Error('Binance endpoint overrides are only allowed with NODE_ENV=test APP_E2E=1');
  }
  const missing = OVERRIDE_KEYS.filter((key) => !raw[key]);
  if (missing.length > 0) {
    throw new Error(`Binance endpoint overrides must be complete, missing: ${missing.join(', ')}`);
  }
  const rest = assertLoopbackUrl('BINANCE_REST_URL', raw['BINANCE_REST_URL']!);
  const marketStream = assertLoopbackUrl('BINANCE_MARKET_WS_URL', raw['BINANCE_MARKET_WS_URL']!);
  const userStream = assertLoopbackUrl('BINANCE_USER_WS_URL', raw['BINANCE_USER_WS_URL']!);
  return {
    rest: { live: rest, test: rest },
    marketStream: { live: marketStream, test: marketStream },
    userStream: { live: userStream, test: userStream },
  };
};

const resolved = resolveBinanceEndpoints();

export const BINANCE_HOSTS: Readonly<Record<BinanceMode, string>> = resolved.rest;
export const BINANCE_WS_HOSTS: Readonly<Record<BinanceMode, string>> = resolved.marketStream;
export const BINANCE_WS_API_HOSTS: Readonly<Record<BinanceMode, string>> = resolved.userStream;
