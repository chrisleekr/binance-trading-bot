// Strategy-emitted metric entries, followed from `tick()` to the exposition.
//
// The failure this pins is not "the handler forgot to call the sink". It is that
// a call CAN reach the sink and still produce nothing: the prom-client adapter
// drops a name the catalogue does not carry, silently and without error, so a
// drain written against an uncatalogued name reads as working code and exports
// zero series. Asserting `record()` was called would pass in exactly that case.
//
// So the sink here is the real one over a real registry, and the assertions read
// the scrape body. Nothing short of the entry reaching /metrics satisfies them.

import type { Job } from 'bullmq';
import type { MarketDataPort } from '@app/binance';
import { createMetricsRegistry } from '@app/observability';
import { createRegistry, metric, type Strategy, type SymbolInfo } from '@app/strategy-core';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { describe, expect, it, vi } from 'vitest';

// The entry-blocker on-change writer resolves a bound repo from the scope, so the
// binding is stubbed to keep the handler off a real database.
const appendSpy = vi.fn(async () => undefined);
vi.mock('@app/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@app/db')>();
  return { ...actual, profileRepoFromScope: () => ({ actionLogs: { append: appendSpy } }) };
});

import { createWorkerMetricsSink } from '../../src/boot/metrics-sink.js';
import { createChainByKey } from '../../src/lib/chain-by-key.js';
import { createTickHandler, type TickHandlerDeps } from '../../src/tick/tick-handler.js';
import type { ProfileTickContext } from '../../src/tick/build-tick-input.js';
import type { TickJobData } from '../../src/queues/job-payloads.js';

const OPERATOR = asUserId('11111111-1111-4111-8111-111111111111');
const ACCOUNT = asAccountId('33333333-3333-4333-8333-333333333333');
const PROFILE = asProfileId('22222222-2222-4222-8222-222222222222');
const SYMBOL = 'BTCUSDT';
const STRATEGY = 'stub-strategy-metrics';

const SYMBOL_INFO: SymbolInfo = {
  symbol: SYMBOL,
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  filters: { minQty: '0.00001', stepSize: '0.00001', minNotional: '10', tickSize: '0.01' },
};

/** Key-aware ioredis stub. Every queued GET answers a clean cache miss. */
const buildFakeRedis = (): import('ioredis').Redis => {
  const makePipeline = () => {
    const queued: string[] = [];
    const pipeline = {
      get(key: string) {
        queued.push(key);
        return pipeline;
      },
      exec: async () => queued.map(() => [null, null]),
    };
    return pipeline;
  };
  return {
    pipeline: () => makePipeline(),
    exists: async () => 0,
    get: async () => null,
    set: async () => 'OK',
    del: async () => 1,
  } as unknown as import('ioredis').Redis;
};

const marketDataPort = { loadWindow: async () => [] } as unknown as MarketDataPort;

/**
 * Stub strategy whose tick emits the metric shapes the real plugins do: a bare
 * name, a name carrying a promoted `reason`, a repeated name that has to
 * accumulate, and one carrying tags the series does not declare.
 */
const buildStrategy = (): Strategy =>
  ({
    name: STRATEGY,
    version: '1.0.0',
    displayName: 'stub',
    description: 'stub',
    capabilities: {
      candleIntervals: ['1h'],
      needsUserDataStream: false,
      needsMiniTicker: false,
      bundleProviders: [],
      operatorActions: [],
    },
    initialState: () => ({ schemaVersion: '1.0.0' }),
    // The handler validates the assembled bundle before calling `tick()`, so the
    // stub needs a schema that accepts anything or the tick never runs.
    bundleSchema: { parse: (value: unknown) => value },
    tick: () => ({
      nextState: { schemaVersion: '1.0.0' },
      decisions: [],
      logs: [],
      metrics: [
        metric('momentum.entry'),
        metric('momentum.skip', { side: 'BUY', reason: 'cooldown' }),
        metric('momentum.skip', { side: 'BUY', reason: 'cooldown' }),
        metric('tt_risk_cap_veto', { symbol: 'WRONGUSDT', cap: 'per-symbol' }),
      ],
    }),
  }) as unknown as Strategy;

const run = async (): Promise<string> => {
  appendSpy.mockClear();
  // `version` is pinned so the exposition does not depend on npm_package_version.
  const promRegistry = createMetricsRegistry({ service: 'worker-test', version: 'test' });
  const registry = createRegistry();
  registry.register(buildStrategy());

  const profile: ProfileTickContext = {
    operatorId: OPERATOR,
    accountId: ACCOUNT,
    profileId: PROFILE,
    scope: { operatorId: OPERATOR, accountId: ACCOUNT, profileId: PROFILE },
    symbol: SYMBOL,
    strategyName: STRATEGY,
    strategyVersion: '1.0.0',
    config: {},
    bundleProvider: async () => ({ bundle: {} }),
    binanceMode: 'test',
    quoteAsset: 'USDT',
    weightLimit1m: 1200,
    candleInterval: '1h',
    technicalsConfig: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
    needsAccountDeployedQuote: false,
    reserveBaseQuantity: null,
  } as unknown as ProfileTickContext;

  const deps = {
    redis: buildFakeRedis(),
    registry,
    metrics: createWorkerMetricsSink(promRegistry),
    executor: { applyAll: vi.fn(async () => []) },
    chain: createChainByKey(),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    coldLoad: {
      loadAccount: async () => ({ balances: {} }),
      loadAccountDeployedQuote: async () => '0',
      loadOpenOrders: async () => [],
      loadSymbolState: async () => null,
    },
    symbolInfoCache: { get: async () => SYMBOL_INFO },
    statePort: {
      loadForTick: async () => ({
        state: { schemaVersion: '1.0.0' },
        commit: async () => undefined,
      }),
    },
    marketDataPort,
    resolveProfile: async () => profile,
    auditShipper: { publish: async () => undefined },
    settleOverrideAction: vi.fn(async () => {}),
  } as unknown as TickHandlerDeps;

  const job = {
    data: {
      userId: String(OPERATOR),
      accountId: String(ACCOUNT),
      profileId: String(PROFILE),
      symbol: SYMBOL,
      event: 'tick',
      enqueuedAtMs: 0,
      payload: {},
    } satisfies TickJobData,
  } as unknown as Job<TickJobData>;

  await createTickHandler(deps)(job);
  return promRegistry.metrics();
};

/** The one exported sample for `name`, with whatever labels it carried. */
const sampleFor = (body: string, name: string): string =>
  body
    .split('\n')
    .find((line) => line.startsWith('strategy_metric_total{') && line.includes(`name="${name}"`)) ??
  '';

describe('tick handler — strategy metric drain', () => {
  it('exports an entry the strategy emitted, attributed to strategy and profile', async () => {
    const body = await run();
    const sample = sampleFor(body, 'momentum.entry');
    expect(sample).toContain(`strategy="${STRATEGY}"`);
    expect(sample).toContain(`profileId="${PROFILE}"`);
    expect(sample).toContain(`symbol="${SYMBOL}"`);
    expect(sample).toMatch(/\}\s+1$/);
  });

  it('accumulates repeated entries onto one series and promotes reason', async () => {
    const body = await run();
    const sample = sampleFor(body, 'momentum.skip');
    expect(sample).toContain('reason="cooldown"');
    expect(sample).toMatch(/\}\s+2$/);
  });

  it('stamps reason unknown when the entry carries none', async () => {
    const body = await run();
    expect(sampleFor(body, 'momentum.entry')).toContain('reason="unknown"');
  });

  it('drops undeclared tags and keeps the canonical symbol', async () => {
    // `cap` and `side` are per-strategy dimensions the series does not declare,
    // and a strategy tag named `symbol` must not displace the tick's own symbol —
    // otherwise one mislabelled emit misattributes the whole series.
    const body = await run();
    const sample = sampleFor(body, 'tt_risk_cap_veto');
    expect(sample).toContain(`symbol="${SYMBOL}"`);
    expect(sample).not.toContain('WRONGUSDT');
    expect(sample).not.toContain('cap=');
  });

  it('registers the series as a counter under its catalogued name', async () => {
    const body = await run();
    expect(body).toContain('# TYPE strategy_metric_total counter');
  });
});
