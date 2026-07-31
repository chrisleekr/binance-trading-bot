// Type-level contract for the kline-interval tuples. A compile error here
// surfaces as a tsc failure during `bun run typecheck`. The point is to prove
// the `as const` spreads did NOT widen `readonly [...]` to `string[]`: a widened
// tuple both breaks `z.enum` (which needs `[string, ...string[]]`) and collapses
// the literal unions to `string`.

import { z } from 'zod';

import {
  BACKTEST_INTERVALS,
  BINANCE_KLINE_INTERVALS,
  CANDLE_INTERVALS,
  type BinanceKlineInterval,
  type CandleInterval,
} from '../src/kline-intervals.js';

// `BacktestInterval` type is owned by `./backtest.ts`; here we assert the
// backtest tuple's own element type directly off the canonical spine.
type BacktestInterval = (typeof BACKTEST_INTERVALS)[number];

// z.enum only accepts a non-empty readonly literal tuple. If a spread widened
// any of these to `string[]`, these three lines fail to compile — the strongest
// signal the tuple shape survived.
const enumCandle = z.enum(CANDLE_INTERVALS);
const enumBacktest = z.enum(BACKTEST_INTERVALS);
const enumBinance = z.enum(BINANCE_KLINE_INTERVALS);
void enumCandle;
void enumBacktest;
void enumBinance;

// Element types are exact literal unions, not `string`. Each `@ts-expect-error`
// fires only if the union widened (a plain `string` would accept the value).
// @ts-expect-error '2M' is not a CandleInterval
const _notCandle: CandleInterval = '2M';
// @ts-expect-error 1s is Binance-only, not in the closed candle set
const _noSecondCandle: CandleInterval = '1s';
// @ts-expect-error 1M has no constant duration, excluded from the backtest spine
const _noMonthBacktest: BacktestInterval = '1M';
void _notCandle;
void _noSecondCandle;
void _noMonthBacktest;

// Positive membership: the expected literals are assignable.
const _candle: CandleInterval = '1M';
const _backtest: BacktestInterval = '1w';
const _binanceSecond: BinanceKlineInterval = '1s';
void _candle;
void _backtest;
void _binanceSecond;
