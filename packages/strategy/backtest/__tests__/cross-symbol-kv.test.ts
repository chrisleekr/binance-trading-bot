import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CandleInterval, Strategy, TickInput, TickOutput } from '@app/strategy-core';
import type { SymbolInfo } from '@app/strategy-core';
import { runBacktest } from '../src/run.js';
import { IdealFillModel } from '../src/ideal-fill.js';
import { arrayMarketDataSource } from '../src/portfolio-source.js';
import { candleSource, flatCandles, SYMBOL, SYMBOL_INFO } from './_fixtures.js';

type EmptyBundle = Readonly<Record<string, never>>;
interface KvState {
  readonly ticks: number;
}

const baseOpts = {
  request: { symbols: [SYMBOL], intervals: ['1m'] as const, fromMs: 0, toMs: 600_000 },
  initialBalances: { USDT: '1000' },
  quoteAsset: 'USDT',
  symbolInfos: [SYMBOL_INFO],
};

/**
 * A strategy that each tick publishes an incrementing counter under a KV key and
 * records the `profileKv` snapshot it was handed. Proves the backtest applies
 * set-kv / delete-kv to its in-memory store and injects it back into the next
 * tick (the cross-symbol seam end-to-end), without a multi-symbol harness.
 */
const makeKvStrategy = (
  opts: { needsProfileKv: boolean; deleteAfter?: number },
  seen: (Record<string, unknown> | undefined)[],
): Strategy<Record<string, never>, KvState, EmptyBundle> => ({
  name: 'kv-test',
  version: '1.0.0',
  displayName: 'KV test',
  description: 'cross-symbol KV seam test',
  capabilities: {
    candleIntervals: ['1m'] as CandleInterval[],
    needsUserDataStream: false,
    needsMiniTicker: false,
    needsProfileKv: opts.needsProfileKv,
    bundleProviders: [],
    operatorActions: [],
  },
  configSchema: z.object({}),
  overrideConfigSchema: z.object({}),
  stateSchema: z.object({ ticks: z.number() }),
  bundleSchema: z.object({}),
  events: {},
  defaultConfig: {},
  initialState: () => ({ ticks: 0 }),
  tick: (input: TickInput<Record<string, never>, KvState, EmptyBundle>): TickOutput<KvState> => {
    seen.push(input.profileKv);
    const n = input.state.ticks + 1;
    const decisions =
      opts.deleteAfter !== undefined && n > opts.deleteAfter
        ? ([{ type: 'delete-kv', key: 'counter' }] as const)
        : ([{ type: 'set-kv', key: 'counter', value: n }] as const);
    return { nextState: { ticks: n }, decisions: [...decisions], logs: [], metrics: [] };
  },
});

describe('cross-symbol KV seam in the backtest engine', () => {
  it('applies set-kv and feeds the store back as profileKv on the next tick', async () => {
    const seen: (Record<string, unknown> | undefined)[] = [];
    await runBacktest({
      ...baseOpts,
      strategy: makeKvStrategy({ needsProfileKv: true }, seen),
      config: {},
      fillModel: new IdealFillModel(),
      dataSource: candleSource(flatCandles(3, '100')),
    });
    // Tick 1 sees the empty store; each later tick sees the prior tick's write.
    expect(seen[0]).toEqual({});
    expect(seen[1]).toEqual({ counter: 1 });
    expect(seen[2]).toEqual({ counter: 2 });
  });

  it('applies delete-kv: the key is gone from the next snapshot', async () => {
    const seen: (Record<string, unknown> | undefined)[] = [];
    await runBacktest({
      ...baseOpts,
      strategy: makeKvStrategy({ needsProfileKv: true, deleteAfter: 1 }, seen),
      config: {},
      fillModel: new IdealFillModel(),
      dataSource: candleSource(flatCandles(3, '100')),
    });
    expect(seen[1]).toEqual({ counter: 1 }); // tick 1 wrote it
    expect(seen[2]).toEqual({}); // tick 2 deleted it → tick 3 sees nothing
  });

  it('never passes profileKv to a strategy that does not opt in', async () => {
    const seen: (Record<string, unknown> | undefined)[] = [];
    await runBacktest({
      ...baseOpts,
      strategy: makeKvStrategy({ needsProfileKv: false }, seen),
      config: {},
      fillModel: new IdealFillModel(),
      dataSource: candleSource(flatCandles(2, '100')),
    });
    expect(seen.every((kv) => kv === undefined)).toBe(true);
  });

  it('one symbol reads a fact a SIBLING symbol published (the cross-symbol point)', async () => {
    // BTC closes first (t=60k), ETH later (t=120k). BTC's tick publishes its
    // price under `value:BTCUSDT`; ETH's later tick must see it in profileKv.
    const ethInfo: SymbolInfo = { ...SYMBOL_INFO, symbol: 'ETHUSDT', baseAsset: 'ETH' };
    const seenByEth: Record<string, unknown> = {};
    const publisher: Strategy<Record<string, never>, KvState, EmptyBundle> = {
      ...makeKvStrategy({ needsProfileKv: true }, []),
      tick: (input): TickOutput<KvState> => {
        if (input.market.symbol === 'ETHUSDT') Object.assign(seenByEth, input.profileKv ?? {});
        return {
          nextState: input.state,
          decisions: [
            {
              type: 'set-kv',
              key: `value:${input.market.symbol}`,
              value: input.market.currentPrice,
            },
          ],
          logs: [],
          metrics: [],
        };
      },
    };
    await runBacktest({
      request: { symbols: ['BTCUSDT', 'ETHUSDT'], intervals: ['1m'], fromMs: 0, toMs: 600_000 },
      initialBalances: { USDT: '1000' },
      quoteAsset: 'USDT',
      symbolInfos: [SYMBOL_INFO, ethInfo],
      strategy: publisher,
      config: {},
      fillModel: new IdealFillModel(),
      dataSource: arrayMarketDataSource([
        { symbol: 'BTCUSDT', interval: '1m', candles: flatCandles(1, '111', 60_000) },
        { symbol: 'ETHUSDT', interval: '1m', candles: flatCandles(1, '222', 120_000) },
      ]),
    });
    // ETH's tick ran after BTC's and saw BTC's published value.
    expect(seenByEth['value:BTCUSDT']).toBe('111');
  });
});
