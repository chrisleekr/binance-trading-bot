import { describe, expect, it } from 'vitest';
import type {
  Candle,
  CandleInterval,
  OrderParams,
  Strategy,
  SymbolInfo,
  TickInput,
  TickOutput,
} from '@app/strategy-core';

import { runBacktest } from '../src/run.js';
import { OhlcvFillModel } from '../src/ohlcv-fill.js';
import { IdealFillModel } from '../src/ideal-fill.js';
import { arrayMarketDataSource } from '../src/portfolio-source.js';
import type { BacktestReport, EquityPoint, FillModel } from '../src/types.js';
import { idleStrategy, SYMBOL, SYMBOL_INFO, type TestState } from './_fixtures.js';

const MIN = 60_000;
const m = (minutes: number): number => minutes * MIN;
// The closing millisecond of a bar that ends at minute `minutes`.
const closeAt = (minutes: number): number => m(minutes) - 1;

type BarShape = Partial<Pick<Candle, 'open' | 'high' | 'low' | 'close'>>;

const bar = (openMinute: number, shape: BarShape = {}): Candle => ({
  openTimeMs: m(openMinute),
  closeTimeMs: closeAt(openMinute + 1),
  open: shape.open ?? '100',
  high: shape.high ?? shape.close ?? '100',
  low: shape.low ?? shape.close ?? '100',
  close: shape.close ?? '100',
  volume: '1000',
  isClosed: true,
});

// One 1m bar per minute in [firstMinute, firstMinute + count), reshaped where `shapes` names a minute.
const bars = (
  firstMinute: number,
  count: number,
  shapes: Readonly<Record<number, BarShape>> = {},
): Candle[] =>
  Array.from({ length: count }, (_, i) => bar(firstMinute + i, shapes[firstMinute + i] ?? {}));

const infoFor = (symbol: string): SymbolInfo => ({
  ...SYMBOL_INFO,
  symbol,
  baseAsset: symbol.replace('USDT', ''),
});

const NO_COSTS = new OhlcvFillModel({ makerBps: 0, takerBps: 0, slippageBps: 0 });

interface TickSeen {
  readonly symbol: string;
  readonly atMs: number;
}

type Bundle = Readonly<Record<string, never>>;

// Records every tick and places `order` once per symbol on its first tick.
const probe = (
  seen: TickSeen[],
  order?: OrderParams,
): Strategy<Record<string, never>, TestState, Bundle> => ({
  ...idleStrategy,
  tick: (input: TickInput<Record<string, never>, TestState, Bundle>): TickOutput<TestState> => {
    seen.push({ symbol: input.market.symbol, atMs: input.clock.nowMs() });
    const place = order !== undefined && !input.state.bought;
    return {
      nextState: { bought: input.state.bought || place },
      decisions: place
        ? [
            {
              type: 'place-order',
              intent: {
                symbol: input.market.symbol,
                side: 'BUY',
                reason: 'manual',
                clientOrderId: `dc-${input.market.symbol}`,
              },
              params: order,
            },
          ]
        : [],
      logs: [],
      metrics: [],
    };
  },
});

const LIMIT_95: OrderParams = { type: 'LIMIT', price: '95', quantity: '1' };
const MARKET_1: OrderParams = { type: 'MARKET', quantity: '1' };

interface ReplayArgs {
  readonly series: Readonly<Record<string, readonly Candle[]>>;
  readonly fromMs: number;
  readonly toMs: number;
  readonly order?: OrderParams;
  readonly balance?: string;
  readonly decisionMs?: number;
  readonly strategyInterval?: CandleInterval;
  readonly fillModel?: FillModel;
}

interface Replayed {
  readonly report: BacktestReport;
  readonly ticks: readonly TickSeen[];
  readonly progress: readonly number[];
  readonly marks: readonly EquityPoint[];
}

async function replay(args: ReplayArgs): Promise<Replayed> {
  const ticks: TickSeen[] = [];
  const progress: number[] = [];
  const marks: EquityPoint[] = [];
  const symbols = Object.keys(args.series);
  // Spread from a plain object so options the engine does not declare yet still compile.
  const clock: object = {
    decisionClock: {
      intervalMs: args.decisionMs ?? m(5),
      strategyInterval: args.strategyInterval ?? '5m',
    },
    onEquityMark: (point: EquityPoint) => marks.push(point),
  };
  const report = await runBacktest({
    strategy: probe(ticks, args.order),
    config: {},
    dataSource: arrayMarketDataSource(
      symbols.map((symbol) => ({
        symbol,
        interval: '1m' as const,
        candles: args.series[symbol] ?? [],
      })),
    ),
    fillModel: args.fillModel ?? NO_COSTS,
    request: { symbols, intervals: ['1m'], fromMs: args.fromMs, toMs: args.toMs },
    initialBalances: { USDT: args.balance ?? '100000' },
    quoteAsset: 'USDT',
    symbolInfos: symbols.map(infoFor),
    onProgress: (n) => progress.push(n),
    ...clock,
  });
  return { report, ticks, progress, marks };
}

const atTimes = (ticks: readonly TickSeen[]): number[] => ticks.map((t) => t.atMs);

describe('fills a resting order at minute 3 without ticking; ticks at minutes 5 and 10', () => {
  // Minute 60 is a decision boundary, so the order rests from there and minute 63 is three minutes in.
  const run = () =>
    replay({
      series: { [SYMBOL]: bars(55, 15, { 62: { low: '90' } }) },
      fromMs: m(55),
      toMs: m(70),
      order: LIMIT_95,
    });

  it('fills the resting order on the detail bar that crosses it', async () => {
    const { report } = await run();
    expect(report.trades.map((t) => [t.price, t.tsMs])).toEqual([['95', closeAt(63)]]);
  });

  it('does not tick on the bar that filled the order', async () => {
    const { ticks } = await run();
    expect(atTimes(ticks)).not.toContain(closeAt(63));
  });

  it('ticks only on the decision boundaries', async () => {
    const { ticks } = await run();
    expect(atTimes(ticks)).toEqual([closeAt(60), closeAt(65), closeAt(70)]);
  });
});

describe('OHLCV order cannot fill from its decision candle; ideal model still fills immediately', () => {
  it('does not fill an order from the candle that decided it', async () => {
    // Only the decision bar crosses, so any fill here came from that bar.
    const { report } = await replay({
      series: { [SYMBOL]: bars(0, 10, { 4: { low: '90' } }) },
      fromMs: 0,
      toMs: m(10),
      order: LIMIT_95,
    });
    expect(report.trades).toEqual([]);
  });

  it('fills the same order from the bar after its decision', async () => {
    const { report } = await replay({
      series: { [SYMBOL]: bars(0, 10, { 5: { low: '90' } }) },
      fromMs: 0,
      toMs: m(10),
      order: LIMIT_95,
    });
    expect(report.trades.map((t) => t.tsMs)).toEqual([closeAt(6)]);
  });

  it('fills an ideal-model order at the decision itself', async () => {
    const { report } = await replay({
      series: { [SYMBOL]: bars(0, 10) },
      fromMs: 0,
      toMs: m(10),
      order: MARKET_1,
      fillModel: new IdealFillModel(),
    });
    expect(report.trades.map((t) => [t.price, t.tsMs])).toEqual([['100', closeAt(5)]]);
  });
});

describe('trades only in [fromMs,toMs); bar opening at toMs is ignored; warm-up never trades', () => {
  const window = { fromMs: m(60), toMs: m(70) };

  it('never ticks before fromMs or on the bar opening at toMs', async () => {
    const { ticks } = await replay({ series: { [SYMBOL]: bars(55, 16) }, ...window });
    expect(atTimes(ticks)).toEqual([closeAt(65), closeAt(70)]);
  });

  it('places nothing during warm-up', async () => {
    const { report } = await replay({
      series: { [SYMBOL]: bars(55, 16) },
      ...window,
      order: MARKET_1,
    });
    expect(report.trades.map((t) => t.tsMs)).toEqual([closeAt(66)]);
  });

  it('does not fill a resting order from the bar opening at toMs', async () => {
    const { report } = await replay({
      series: { [SYMBOL]: bars(55, 16, { 70: { low: '90' } }) },
      ...window,
      order: LIMIT_95,
    });
    expect(report.trades).toEqual([]);
  });

  it('values only the frames inside the window', async () => {
    const { report } = await replay({ series: { [SYMBOL]: bars(55, 16) }, ...window });
    expect(report.equityCurve.map((p) => p.tsMs)).toEqual(
      Array.from({ length: 10 }, (_, i) => closeAt(61 + i)),
    );
  });
});

describe('reversed symbols give identical trades and valuations', () => {
  // One balance funds exactly one buy, and the two prices then diverge, so the funded order decides the result.
  const competing = (rising: string, input: readonly string[]) => {
    const series: Record<string, readonly Candle[]> = {};
    for (const symbol of input) {
      const close = symbol === rising ? '120' : '80';
      series[symbol] = bars(0, 3, {
        2: {
          close,
          high: symbol === rising ? '120' : '100',
          low: symbol === rising ? '100' : '80',
        },
      });
    }
    return replay({
      series,
      fromMs: 0,
      toMs: m(3),
      order: MARKET_1,
      balance: '100',
      decisionMs: m(1),
      strategyInterval: '1m',
    });
  };
  const AAA = 'AAAUSDT';
  const BBB = 'BBBUSDT';

  it('funds the codepoint-first symbol when the input lists it last', async () => {
    const { report } = await competing(AAA, [BBB, AAA]);
    expect(report.trades.map((t) => t.symbol)).toEqual([AAA]);
    expect(report.summary.finalBalance).toBe('120');
  });

  it('produces identical trades for either input order', async () => {
    const forward = await competing(AAA, [AAA, BBB]);
    const reversed = await competing(AAA, [BBB, AAA]);
    expect(forward.report.trades).toHaveLength(1);
    expect(reversed.report.trades).toEqual(forward.report.trades);
  });

  it('produces identical valuations for either input order', async () => {
    const forward = await competing(AAA, [AAA, BBB]);
    const reversed = await competing(AAA, [BBB, AAA]);
    expect(forward.report.equityCurve.at(-1)?.equity).toBe('120');
    expect(reversed.report.equityCurve).toEqual(forward.report.equityCurve);
  });

  it('orders by codepoint, where uppercase sorts before lowercase', async () => {
    const lower = 'aaaUSDT';
    const { report } = await competing(BBB, [lower, BBB]);
    expect(report.trades.map((t) => t.symbol)).toEqual([BBB]);
  });
});

describe('equal-close frame records one mark and progress; marks advance without decisions', () => {
  const twoSymbols = () =>
    replay({
      series: { AAAUSDT: bars(0, 10), BBBUSDT: bars(0, 10) },
      fromMs: 0,
      toMs: m(10),
    });
  const everyClose = Array.from({ length: 10 }, (_, i) => closeAt(i + 1));

  it('records one equity point per frame', async () => {
    const { report } = await twoSymbols();
    expect(report.equityCurve.map((p) => p.tsMs)).toEqual(everyClose);
  });

  it('reports progress once per frame', async () => {
    const { progress } = await twoSymbols();
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('hands the observer the full-resolution marks', async () => {
    const { marks } = await twoSymbols();
    expect(marks.map((p) => p.tsMs)).toEqual(everyClose);
  });

  it('values every frame between decisions at its own close', async () => {
    // The minute-3 spike precedes the first decision, so it is flat cash; the minute-8 spike is held.
    const { report } = await replay({
      series: {
        [SYMBOL]: bars(0, 10, { 2: { close: '150' }, 7: { close: '150' } }),
      },
      fromMs: 0,
      toMs: m(10),
      order: MARKET_1,
      balance: '1000',
    });
    expect(report.equityCurve.map((p) => p.equity)).toEqual([
      '1000',
      '1000',
      '1000',
      '1000',
      '1000',
      '1000',
      '1000',
      '1050',
      '1000',
      '1000',
    ]);
  });
});

describe('symbol with no candle keeps mark, no tick, no fill', () => {
  const AAA = 'AAAUSDT';
  const BBB = 'BBBUSDT';
  // Minute 10 is a decision boundary, so the gap has a decision to skip.
  const withoutMinuteTen = (shapes: Readonly<Record<number, BarShape>> = {}): Candle[] =>
    bars(0, 15, shapes).filter((c) => c.openTimeMs !== m(9));

  it('skips the decision for the symbol with no candle', async () => {
    const { ticks } = await replay({
      series: { [AAA]: bars(0, 15), [BBB]: withoutMinuteTen() },
      fromMs: 0,
      toMs: m(15),
    });
    expect(ticks).toEqual([
      { symbol: AAA, atMs: closeAt(5) },
      { symbol: BBB, atMs: closeAt(5) },
      { symbol: AAA, atMs: closeAt(10) },
      { symbol: AAA, atMs: closeAt(15) },
      { symbol: BBB, atMs: closeAt(15) },
    ]);
  });

  it('values the gap frame once, at the symbol last close', async () => {
    // BBB closes at 200 on minute 9 and has no bar on minute 10, so its 200 mark must last through the gap.
    const { report } = await replay({
      series: { [AAA]: bars(0, 15), [BBB]: withoutMinuteTen({ 8: { close: '200' } }) },
      fromMs: 0,
      toMs: m(15),
      order: MARKET_1,
      balance: '1000',
    });
    expect(report.equityCurve.map((p) => [p.tsMs, p.equity])).toEqual(
      Array.from({ length: 15 }, (_, i) => [closeAt(i + 1), i === 8 || i === 9 ? '1100' : '1000']),
    );
  });

  it('does not fill a resting order on a frame where its symbol has no candle', async () => {
    // BBB has no minute-6 bar, so re-crossing its last bar there would fill at minute 6 instead of minute 7.
    const { report } = await replay({
      series: {
        [AAA]: bars(0, 15),
        [BBB]: bars(0, 15, { 4: { low: '90' }, 6: { low: '90' } }).filter(
          (c) => c.openTimeMs !== m(5),
        ),
      },
      fromMs: 0,
      toMs: m(15),
      order: LIMIT_95,
    });
    expect(report.trades.filter((t) => t.symbol === BBB).map((t) => t.tsMs)).toEqual([closeAt(7)]);
  });
});
