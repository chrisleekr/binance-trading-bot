import { describe, expect, it } from 'vitest';

import { BacktestSubmitSchema, MAX_REPLAY_SYMBOL_CANDLES } from '../src/backtest.js';
import { BACKTEST_DECISION_INTERVALS } from '../src/kline-intervals.js';
import * as contracts from '../src/index.js';

const { BacktestParamsSchema, marketOf } = contracts;

const DAY = 86_400_000;
const MIN = 60_000;

const VALID = {
  symbols: ['BTCUSDT'],
  fromMs: 100 * DAY,
  toMs: 101 * DAY,
  strategyInterval: '1h',
  decisionInterval: '5m',
  detailInterval: '1m',
  initialQuoteBalance: '1000',
  fees: { makerBps: 10, takerBps: 10 },
  slippageBps: 2,
  spreadBps: 2,
  volumeCapPct: 10,
};

function submit(input: Record<string, unknown>) {
  return BacktestSubmitSchema.safeParse(input);
}

const paths = (input: Record<string, unknown>): string[] => {
  const parsed = submit(input);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'));
};

const symbolsOf = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `S${String(i)}USDT`);

describe('BacktestSubmitSchema', () => {
  it('accepts a complete, aligned submission', () => {
    expect(submit(VALID).success).toBe(true);
  });

  it('requires decisionInterval', () => {
    const { decisionInterval: _omitted, ...rest } = VALID;
    expect(paths(rest)).toContain('decisionInterval');
  });

  it('allows decision intervals from 1m through 1d', () => {
    expect(BACKTEST_DECISION_INTERVALS).toEqual([
      '1m',
      '3m',
      '5m',
      '15m',
      '30m',
      '1h',
      '2h',
      '4h',
      '6h',
      '8h',
      '12h',
      '1d',
    ]);
  });

  it.each(['3d', '1w'])('rejects a %s decision interval', (decisionInterval) => {
    expect(paths({ ...VALID, strategyInterval: '1w', decisionInterval })).toContain(
      'decisionInterval',
    );
  });

  it('rejects a detail interval that does not divide the decision interval', () => {
    expect(paths({ ...VALID, detailInterval: '3m', decisionInterval: '5m' })).toContain(
      'detailInterval',
    );
  });

  it('rejects a detail interval coarser than the decision interval', () => {
    expect(paths({ ...VALID, detailInterval: '15m', decisionInterval: '5m' })).toContain(
      'detailInterval',
    );
  });

  it('accepts a detail interval equal to the decision interval', () => {
    expect(submit({ ...VALID, detailInterval: '5m', decisionInterval: '5m' }).success).toBe(true);
  });

  it('rejects a fromMs off the detail grid rather than shifting it', () => {
    expect(paths({ ...VALID, fromMs: VALID.fromMs + 1 })).toContain('fromMs');
  });

  it('rejects a toMs off the detail grid rather than shifting it', () => {
    expect(paths({ ...VALID, toMs: VALID.toMs + 1 })).toContain('toMs');
  });

  it('measures the grid in detail bars', () => {
    expect(paths({ ...VALID, detailInterval: '5m', fromMs: VALID.fromMs + MIN })).toContain(
      'fromMs',
    );
  });

  it('rejects duplicate symbols', () => {
    expect(paths({ ...VALID, symbols: ['BTCUSDT', 'ETHUSDT', 'BTCUSDT'] })).toContain('symbols');
  });

  it('pins the replay budget', () => {
    expect(MAX_REPLAY_SYMBOL_CANDLES).toBe(576_000);
  });

  it('accepts a run exactly at the budget', () => {
    const atBudget = { ...VALID, symbols: symbolsOf(4), toMs: VALID.fromMs + 100 * DAY };
    expect(submit(atBudget).success).toBe(true);
  });

  it('rejects a run one symbol over the budget', () => {
    const over = { ...VALID, symbols: symbolsOf(5), toMs: VALID.fromMs + 100 * DAY };
    expect(submit(over).success).toBe(false);
  });

  it('tells the operator what to shorten when over budget', () => {
    const parsed = submit({ ...VALID, symbols: symbolsOf(5), toMs: VALID.fromMs + 100 * DAY });
    const message = parsed.success ? '' : parsed.error.issues.map((i) => i.message).join(' ');
    expect(message).toMatch(/shorten|fewer symbols|coarser/i);
  });

  it('counts the 1-minute series every run loads, whatever the detail interval', () => {
    const coarse = {
      ...VALID,
      symbols: symbolsOf(50),
      strategyInterval: '1d',
      decisionInterval: '1d',
      detailInterval: '1d',
      toMs: VALID.fromMs + 400 * DAY,
    };
    expect(paths(coarse)).toContain('symbols');
  });

  it('strips a client-supplied snapshot', () => {
    const parsed = submit({ ...VALID, snapshot: { strategyName: 'forged' } });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('snapshot');
  });
});

describe('historical params decode', () => {
  const { decisionInterval: _omitted, ...LEGACY } = VALID;

  it('decodes a row with no decision interval', () => {
    expect(BacktestParamsSchema.safeParse(LEGACY).success).toBe(true);
  });

  it('decodes a row the new alignment rules would refuse', () => {
    const offGrid = { ...LEGACY, fromMs: LEGACY.fromMs + 1, symbols: ['BTCUSDT', 'BTCUSDT'] };
    expect(BacktestParamsSchema.safeParse(offGrid).success).toBe(true);
  });

  it('gives a legacy row no decision interval in its market dimensions', () => {
    const market = marketOf(BacktestParamsSchema.parse(LEGACY)) as Record<string, unknown>;
    expect(market['decisionInterval']).toBeNull();
  });

  it('keeps the decision interval in the market dimensions of a new row', () => {
    const market = marketOf(BacktestParamsSchema.parse(VALID)) as Record<string, unknown>;
    expect(market['decisionInterval']).toBe('5m');
  });
});
