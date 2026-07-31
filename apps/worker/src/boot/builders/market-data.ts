// Market-data leaves: the shared WS factory, the per-IP weight governor, the
// process-wide kline port, and the indicator computer that reads it.
//
// The kline fetcher is the single MarketDataPort — one combined-stream WS plus
// one per-(symbol, interval) ring shared across every consumer. It is a leaf
// here (needs only ws + weight-governor + REST fallback); its one back-edge,
// the reconnect resync, is late-bound in the fleet builder.

import WebSocket from 'ws';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import {
  createKlineFetcher,
  createRedisWeightGovernor,
  createWsFactory,
  fetchClosedKlines,
  type KlineFetcher,
  type WeightGovernor,
} from '@app/binance';
import { sleep } from '@app/core/sleep';

import { createIndicatorComputer } from 'indicator-computer/indicator-computer.js';

import type { BootEnv } from '../boot-env.js';

export interface MarketDataDeps {
  readonly env: BootEnv;
  readonly redis: Redis;
  readonly logger: Logger;
}

export interface MarketData {
  readonly wsFactory: ReturnType<typeof createWsFactory>;
  readonly weightGovernor: WeightGovernor;
  readonly klineFetcher: KlineFetcher;
  readonly indicatorComputer: ReturnType<typeof createIndicatorComputer>;
}

export const buildMarketData = ({ env, redis, logger }: MarketDataDeps): MarketData => {
  const wsFactory = createWsFactory(WebSocket);
  // One per-IP weight governor shared across every Binance REST caller — and,
  // via Redis, across every worker pod that egresses the same NAT IP (epic
  // #561). budget = Binance's real per-IP spot REST limit (6000/min); 80%
  // utilisation leaves headroom for unmetered paths like ping. Tick and cron
  // callers reserve weight ahead of issuing the request so a busy cron tick
  // cannot 429 the tick path. orderReserve keeps the top 8 weight free for order
  // placement/cancellation, so an urgent protective SELL is never stalled behind
  // a bulk-read cron (discovery/technicals) near the ceiling: orders admit
  // against the full ceiling, bulk reads against ceiling - 8. On Redis-down the
  // governor fails open for orders (local backstop) and closed for bulk reads.
  const weightGovernor = createRedisWeightGovernor({
    budget: 6000,
    orderReserve: 8,
    redis,
    logger,
  });
  // Local variable typed as the concrete KlineFetcher so the lifecycle
  // stop step can call `shutdown` (not on the narrower MarketDataPort
  // interface). The BootContext exposes it as MarketDataPort so consumers
  // see only the port surface. The REST cold-load path uses the public
  // `/api/v3/klines` endpoint (unsigned) and reserves its flat weight (2).
  const klineFetcher: KlineFetcher = createKlineFetcher({
    wsUrl: env.binanceWsUrl ?? 'wss://stream.binance.com:9443/stream',
    wsFactory,
    // Strict decode + open-bar drop is shared with technicals-compute via
    // @app/binance. No reserveWeight here: createKlineFetcher reserves the
    // flat klines weight before invoking this callback (passing it again
    // would double-count the per-IP budget).
    fetchRestKlines: (symbol, interval, limit) =>
      fetchClosedKlines(
        { baseUrl: 'https://api.binance.com', symbol, interval, limit },
        {
          fetch,
          nowMs: () => Date.now(),
          sleep,
        },
      ),
    weightGovernor,
    logger,
  });

  const indicatorComputer = createIndicatorComputer({
    redis,
    logger,
    loadWindow: (symbol, interval, size) => klineFetcher.loadWindow(symbol, interval, size),
  });

  return { wsFactory, weightGovernor, klineFetcher, indicatorComputer };
};
