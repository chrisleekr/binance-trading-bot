import { Decimal } from '@app/money';
import { describe, expect, it, vi } from 'vitest';

import { adoptOne, runBacktest } from '../src/run.js';
import { IdealFillModel } from '../src/ideal-fill.js';
import {
  candleSource,
  flatCandles,
  makePositionStrategy,
  SYMBOL,
  SYMBOL_INFO,
} from './_fixtures.js';

const baseOpts = {
  request: { symbols: [SYMBOL], intervals: ['1m'] as const, fromMs: 0, toMs: 600_000 },
  initialBalances: { USDT: '1000' },
  quoteAsset: 'USDT',
  symbolInfos: [SYMBOL_INFO],
  config: {},
};

// The engine adopts executor fills into the plugin's position state (its
// analogue of the live fill-adopter). Without it, a strategy that reads its
// position from state — and writes the position only via the adapter, like
// TT — never learns it bought and re-buys every candle.
describe('runBacktest — fill adoption converges position state', () => {
  it('a position-managing strategy buys exactly once, not every candle', async () => {
    const report = await runBacktest({
      ...baseOpts,
      strategy: makePositionStrategy('0.01'),
      fillModel: new IdealFillModel(),
      dataSource: candleSource(flatCandles(10, '100')),
    });
    // 10 candles: tick 1 emits a buy, adoption sets avgEntryPrice, ticks 2..10
    // see the position and hold. Exactly one trade.
    expect(report.summary.tradeCount).toBe(1);
    expect(report.trades[0]).toMatchObject({ side: 'BUY', qty: '0.01', price: '100' });
  });

  // Momentum writes its order quantity into state when it places the entry. Folding the fill onto that state doubled the held quantity, so the exit sell for twice the wallet was rejected and the strategy re-entered on top of coins it still held.
  it('does not double a position the strategy pre-filled into state when it placed the order', async () => {
    const base = makePositionStrategy('0.01');
    let lastHeld: string | null = null;
    const prefilling = {
      ...base,
      tick: (input: Parameters<typeof base.tick>[0]) => {
        lastHeld = input.state.heldQuantity;
        const out = base.tick(input);
        return out.decisions.length > 0
          ? { ...out, nextState: { avgEntryPrice: '100', heldQuantity: '0.01' } }
          : out;
      },
    };
    await runBacktest({
      ...baseOpts,
      strategy: prefilling,
      fillModel: new IdealFillModel(),
      dataSource: candleSource(flatCandles(3, '100')),
    });
    expect(lastHeld).toBe('0.01');
  });

  // Live discards a tick's state when its order never executes. Without the same here, a strategy that pre-fills its position at placement kept claiming coins a refused BUY never bought: the phantom blocked re-entry and armed stops against nothing.
  it('flattens a position the strategy pre-filled for a BUY the fill model refused', async () => {
    const base = makePositionStrategy('0.01');
    const seen: (string | null)[] = [];
    const prefilling = {
      ...base,
      tick: (input: Parameters<typeof base.tick>[0]) => {
        seen.push(input.state.heldQuantity);
        const out = base.tick(input);
        return out.decisions.length > 0
          ? { ...out, nextState: { avgEntryPrice: '100', heldQuantity: '0.01' } }
          : out;
      },
    };
    const report = await runBacktest({
      ...baseOpts,
      // 0.01 at 100 costs 1 USDT; half that cannot fund it.
      initialBalances: { USDT: '0.5' },
      strategy: prefilling,
      fillModel: new IdealFillModel(),
      dataSource: candleSource(flatCandles(3, '100')),
    });
    expect(report.summary.tradeCount).toBe(0);
    expect(seen).toEqual([null, null, null]);
  });

  // Momentum flattens its state when it places the exit. A refused SELL left it flat on coins it still held, so it stopped guarding them and a re-entry folded onto them. Restoring by re-adopting a buy also reset the trailing high-water mark, so the retry trailed a newer, lower peak.
  it('restores the pre-exit state, trailing mark included, for a SELL the fill model refused', async () => {
    const base = makePositionStrategy('0.01');
    type TrailState = Parameters<typeof base.tick>[0]['state'] & { high?: string };
    const seen: [string | null, string | undefined][] = [];
    const flattening = {
      ...base,
      tick: (input: Parameters<typeof base.tick>[0]) => {
        const state = input.state as TrailState;
        seen.push([state.heldQuantity, state.high]);
        if (state.heldQuantity === null) return base.tick(input);
        if (state.high === undefined) {
          const marked: TrailState = { ...state, high: '105' };
          return { nextState: marked, decisions: [], logs: [], metrics: [] };
        }
        // Sell twice the holding, which the balance cannot cover, and flatten at placement as momentum does.
        return {
          nextState: { avgEntryPrice: null, heldQuantity: null },
          decisions: [
            {
              type: 'place-order' as const,
              intent: {
                symbol: input.market.symbol,
                side: 'SELL' as const,
                reason: 'exit' as const,
                clientOrderId: `bt-exit-${input.market.symbol}-${seen.length}`,
              },
              params: { type: 'MARKET' as const, quantity: '0.02' },
            },
          ],
          logs: [],
          metrics: [],
        };
      },
    };
    const report = await runBacktest({
      ...baseOpts,
      strategy: flattening,
      fillModel: new IdealFillModel(),
      dataSource: candleSource(flatCandles(5, '100')),
    });
    // One BUY. Every tick after the refused exit still sees the 0.01 it holds and the 105 mark the exit fired from, instead of re-entering on top of it.
    expect(report.summary.tradeCount).toBe(1);
    expect(seen).toEqual([
      [null, undefined],
      ['0.01', undefined],
      ['0.01', '105'],
      ['0.01', '105'],
      ['0.01', '105'],
    ]);
  });
});

describe('runBacktest — exit time on the emptying fill', () => {
  it('stamps the replay clock at adoption on the SELL that empties the position', async () => {
    const base = makePositionStrategy('0.01');
    const applyFill = vi.fn(base.position!.applyFill);
    let ticks = 0;
    const selling = {
      ...base,
      position: { ...base.position!, applyFill },
      tick: (input: Parameters<typeof base.tick>[0]) => {
        ticks += 1;
        if (ticks !== 3) return base.tick(input);
        return {
          nextState: input.state,
          decisions: [
            {
              type: 'place-order' as const,
              intent: {
                symbol: input.market.symbol,
                side: 'SELL' as const,
                reason: 'exit' as const,
                clientOrderId: 'bt-exit-1',
              },
              params: { type: 'MARKET' as const, quantity: '0.01' },
            },
          ],
          logs: [],
          metrics: [],
        };
      },
    };
    await runBacktest({
      ...baseOpts,
      strategy: selling,
      fillModel: new IdealFillModel(),
      dataSource: candleSource(flatCandles(5, '100')),
    });
    const empties = applyFill.mock.calls.map((c) => c[1]).filter((f) => f.kind === 'empty');
    expect(empties).toHaveLength(1);
    // 1m candles: a candle close is the last ms of its minute.
    expect(empties[0]).toEqual({ kind: 'empty', atMs: expect.any(Number) });
    const atMs = (empties[0] as { atMs: number }).atMs;
    expect(atMs).toBeGreaterThan(0);
    expect((atMs + 1) % 60_000).toBe(0);
  });
});

describe('adoptOne — fill-to-position math (mirrors the live fill-adopter)', () => {
  const position = makePositionStrategy('1').position;
  if (!position) throw new Error('position adapter expected on fixture strategy');
  const flat = { avgEntryPrice: null, heldQuantity: null };
  // The fixture's state IS its position view, so the fills-only prior equals the state here.
  const adopt = (
    state: typeof flat | { avgEntryPrice: string; heldQuantity: string },
    fill: Parameters<typeof adoptOne>[3],
  ) => adoptOne(position, state, state, fill).state;

  it('a first buy sets entry price and held quantity', () => {
    const after = adopt(flat, {
      symbol: SYMBOL,
      side: 'BUY',
      price: new Decimal('100'),
      qty: new Decimal('1'),
    });
    expect(after).toEqual({ avgEntryPrice: '100', heldQuantity: '1' });
  });

  it('a second buy adds at the weighted-average entry price', () => {
    // 1@100 then 1@200 → avg 150, qty 2.
    const after1 = adopt(flat, {
      symbol: SYMBOL,
      side: 'BUY',
      price: new Decimal('100'),
      qty: new Decimal('1'),
    });
    const after2 = adopt(after1, {
      symbol: SYMBOL,
      side: 'BUY',
      price: new Decimal('200'),
      qty: new Decimal('1'),
    });
    expect(after2).toEqual({ avgEntryPrice: '150', heldQuantity: '2' });
  });

  it('a partial sell reduces held quantity, keeping the entry price', () => {
    const held = { avgEntryPrice: '150', heldQuantity: '2' };
    const after = adopt(held, {
      symbol: SYMBOL,
      side: 'SELL',
      price: new Decimal('160'),
      qty: new Decimal('0.5'),
    });
    expect(after).toEqual({ avgEntryPrice: '150', heldQuantity: '1.5' });
  });

  it('a sell that empties the position flattens it', () => {
    const held = { avgEntryPrice: '150', heldQuantity: '2' };
    const after = adopt(held, {
      symbol: SYMBOL,
      side: 'SELL',
      price: new Decimal('160'),
      qty: new Decimal('2'),
    });
    expect(after).toEqual({ avgEntryPrice: null, heldQuantity: null });
  });

  it('a sell with no tracked position flattens rather than going negative', () => {
    const after = adopt(flat, {
      symbol: SYMBOL,
      side: 'SELL',
      price: new Decimal('160'),
      qty: new Decimal('1'),
    });
    expect(after).toEqual({ avgEntryPrice: null, heldQuantity: null });
  });

  it('folds two sequential buy fills (re-rest / partial completion) to the weighted average', () => {
    // A partial that later completes adopts as two fills; the entry price must
    // land on the same weighted average as a single combined fill.
    const after1 = adopt(flat, {
      symbol: SYMBOL,
      side: 'BUY',
      price: new Decimal('100'),
      qty: new Decimal('0.5'),
    });
    const after2 = adopt(after1, {
      symbol: SYMBOL,
      side: 'BUY',
      price: new Decimal('120'),
      qty: new Decimal('1.5'),
    });
    // (100*0.5 + 120*1.5) / 2 = 115, qty 2.
    expect(after2).toEqual({ avgEntryPrice: '115', heldQuantity: '2' });
  });
  it('passes the exit time on an emptying SELL and on nothing else', () => {
    const applyFill = vi.fn(position.applyFill);
    const spy = { ...position, applyFill };
    const mk = (side: 'BUY' | 'SELL', qty: string) => ({
      symbol: SYMBOL,
      side,
      price: new Decimal('100'),
      qty: new Decimal(qty),
    });
    const bought = adoptOne(spy, flat, null, mk('BUY', '2'), 111);
    expect(applyFill.mock.calls[0]?.[1]).toMatchObject({ kind: 'buy' });
    expect(applyFill.mock.calls[0]?.[1]).not.toHaveProperty('atMs');
    const reduced = adoptOne(spy, bought.state, bought.prior, mk('SELL', '0.5'), 222);
    expect(applyFill.mock.calls[1]?.[1]).not.toHaveProperty('atMs');
    adoptOne(spy, reduced.state, reduced.prior, mk('SELL', '1.5'), 333);
    expect(applyFill.mock.calls[2]?.[1]).toEqual({ kind: 'empty', atMs: 333 });
    adoptOne(spy, bought.state, bought.prior, mk('SELL', '2'));
    expect(applyFill.mock.calls[3]?.[1]).toEqual({ kind: 'empty' });
  });

  it('advances the fills-only prior through buy, partial sell, and flatten', () => {
    const fill = (side: 'BUY' | 'SELL', qty: string, price: string) => ({
      symbol: SYMBOL,
      side,
      price: new Decimal(price),
      qty: new Decimal(qty),
    });
    const bought = adoptOne(position, flat, null, fill('BUY', '2', '100'));
    expect(bought.prior).toEqual({ avgEntryPrice: '100', heldQuantity: '2' });
    const reduced = adoptOne(position, bought.state, bought.prior, fill('SELL', '0.5', '110'));
    expect(reduced.prior).toEqual({ avgEntryPrice: '100', heldQuantity: '1.5' });
    const closed = adoptOne(position, reduced.state, reduced.prior, fill('SELL', '1.5', '110'));
    expect(closed.prior).toBeNull();
  });
});
