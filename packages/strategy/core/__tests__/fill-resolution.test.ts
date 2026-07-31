import { Decimal } from '@app/money';
import { describe, expect, it } from 'vitest';
import { resolveFill, realizedPnlOnSell } from '../src/fill-resolution.js';
import type { PositionView } from '../src/contract.js';

const buy = (price: string, quantity: string) => ({
  side: 'BUY' as const,
  price: new Decimal(price),
  quantity: new Decimal(quantity),
});
const sell = (quantity: string) => ({
  side: 'SELL' as const,
  price: new Decimal(0),
  quantity: new Decimal(quantity),
});
const held = (avgEntryPrice: string, heldQuantity: string): PositionView => ({
  avgEntryPrice,
  heldQuantity,
});

describe('resolveFill', () => {
  it('seeds the entry price and quantity on a fresh buy', () => {
    expect(resolveFill(null, buy('100', '2'))).toEqual({
      kind: 'buy',
      avgEntryPrice: '100',
      heldQuantity: '2',
    });
  });

  it('weighted-averages the entry price on a second buy', () => {
    // 2 @ 100 then 2 @ 200 → 4 held at a 150 average.
    expect(resolveFill(held('100', '2'), buy('200', '2'))).toEqual({
      kind: 'buy',
      avgEntryPrice: '150',
      heldQuantity: '4',
    });
  });

  it('folding sub-fills one at a time equals folding their combined VWAP once', () => {
    // The associativity invariant the live/backtest split relied on implicitly:
    // 100@0.5 then 120@1.5 (VWAP 115 over qty 2) must equal one 115@2 fold.
    const a = resolveFill(null, buy('100', '0.5'));
    const stepwise = resolveFill(held(a.avgEntryPrice, a.heldQuantity), buy('120', '1.5'));
    const combined = resolveFill(null, buy('115', '2'));
    expect(new Decimal(stepwise.avgEntryPrice).equals(new Decimal(combined.avgEntryPrice))).toBe(
      true,
    );
    expect(new Decimal(stepwise.heldQuantity).equals(new Decimal(combined.heldQuantity))).toBe(
      true,
    );
  });

  it('reduces the held quantity on a partial sell', () => {
    expect(resolveFill(held('100', '5'), sell('2'))).toEqual({
      kind: 'sell-reduce',
      heldQuantity: '3',
    });
  });

  it('flattens to empty when a sell takes the position to zero', () => {
    expect(resolveFill(held('100', '5'), sell('5'))).toEqual({ kind: 'empty' });
    expect(resolveFill(held('100', '5'), sell('6'))).toEqual({ kind: 'empty' });
  });

  it('treats a sell with no prior position as empty', () => {
    expect(resolveFill(null, sell('1'))).toEqual({ kind: 'empty' });
  });

  it('flattens a sub-stepSize residual to empty (unsellable fee dust)', () => {
    // Held 5, sold 4.99999, residual 0.00001 < step 0.0001 ⇒ flat.
    expect(resolveFill(held('100', '5'), sell('4.99999'), new Decimal('0.0001'))).toEqual({
      kind: 'empty',
    });
  });

  it('keeps a residual at or above stepSize as a partial reduce', () => {
    // Residual exactly one step is sellable ⇒ not flat.
    expect(resolveFill(held('100', '5'), sell('4.9999'), new Decimal('0.0001'))).toEqual({
      kind: 'sell-reduce',
      heldQuantity: '0.0001',
    });
  });

  it('without stepSize keeps the historical lte(0)-only behavior (replay-safe)', () => {
    // The same sub-step residual survives as a reduce when stepSize is omitted,
    // so existing fixtures and the backtest replay byte-identical.
    expect(resolveFill(held('100', '5'), sell('4.99999'))).toEqual({
      kind: 'sell-reduce',
      heldQuantity: '0.00001',
    });
  });
});

const sellFill = (soldQty: string, proceeds: string) => ({
  soldQty: new Decimal(soldQty),
  proceeds: new Decimal(proceeds),
});

describe('realizedPnlOnSell', () => {
  it('prices a profitable full exit against the cost basis', () => {
    // Bought 10 @ 100 (cost 1000), sold 10 for 1200 → +200.
    expect(realizedPnlOnSell(held('100', '10'), sellFill('10', '1200'))).toEqual({
      realizedPnl: '200',
      costBasisQuote: '1000',
    });
  });

  it('prices a losing exit (the protective-stop case)', () => {
    // Bought 172 @ 0.0885 (cost 15.222), sold 172 for 14.5168 → loss.
    const r = realizedPnlOnSell(held('0.0885', '172'), sellFill('172', '14.5168'));
    if (r === null) throw new Error('expected a costed result');
    expect(new Decimal(r.costBasisQuote).toFixed(4)).toBe('15.2220');
    expect(new Decimal(r.realizedPnl).toFixed(4)).toBe('-0.7052');
  });

  it('prices a partial sell on the sold quantity only', () => {
    // Hold 10 @ 100, sell 4 for 480 → cost 400, pnl +80; 6 still held (untouched).
    expect(realizedPnlOnSell(held('100', '10'), sellFill('4', '480'))).toEqual({
      realizedPnl: '80',
      costBasisQuote: '400',
    });
  });

  it('caps matched quantity at held — an overshoot books no un-costed base', () => {
    // The phantom class: sold 506 but only 172 were ever tracked. Only the
    // tracked 172 realises; its proceeds are pro-rata of the total proceeds.
    // Hold 172 @ 0.0885 (cost 15.222); total sold 506 for 43.53.
    const r = realizedPnlOnSell(held('0.0885', '172'), sellFill('506', '43.53'));
    if (r === null) throw new Error('expected a costed result');
    // costBasis = 172 × 0.0885 = 15.222
    expect(new Decimal(r.costBasisQuote).toFixed(4)).toBe('15.2220');
    // matchedProceeds = 43.53 × 172/506 = 14.795..., pnl = matched − cost < 0.
    // Crucially NOT 43.53 − 15.222 = +28.3 (the fabricated phantom).
    expect(new Decimal(r.realizedPnl).lt(0)).toBe(true);
    expect(new Decimal(r.realizedPnl).gt(-1)).toBe(true);
  });

  it('returns null when the prior position has no cost basis (never fabricate)', () => {
    expect(realizedPnlOnSell(null, sellFill('5', '100'))).toBeNull();
    expect(
      realizedPnlOnSell({ avgEntryPrice: null, heldQuantity: '5' }, sellFill('5', '100')),
    ).toBeNull();
    expect(realizedPnlOnSell(held('0', '0'), sellFill('5', '100'))).toBeNull();
  });

  it('returns null when held quantity is missing even with a known entry price', () => {
    expect(
      realizedPnlOnSell({ avgEntryPrice: '100', heldQuantity: null }, sellFill('5', '100')),
    ).toBeNull();
  });

  it('returns null on a non-positive sold quantity (never book a zero/negative fill)', () => {
    expect(realizedPnlOnSell(held('100', '10'), sellFill('0', '0'))).toBeNull();
  });
});
