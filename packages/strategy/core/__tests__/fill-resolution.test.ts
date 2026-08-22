import { Decimal } from '@app/money';
import { describe, expect, it } from 'vitest';
import {
  resolveFill,
  realizedPnlOnSell,
  isBelowMinNotional,
  isValuelessResidue,
} from '../src/fill-resolution.js';
import type { PositionView } from '../src/contract.js';

const buy = (price: string, quantity: string) => ({
  side: 'BUY' as const,
  price: new Decimal(price),
  quantity: new Decimal(quantity),
});
const sell = (quantity: string, price = '0') => ({
  side: 'SELL' as const,
  price: new Decimal(price),
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

  it('flattens a residual that clears stepSize but is worth less than minNotional', () => {
    // ENAUSDT's real filters and price, on a residual constructed to land between them: a fee-net 420.88184 held, 420.87 sold at 0.1094, leaving 0.01184 against a 0.01 step and a $5 NOTIONAL floor. The crumb is 1.18 steps wide so LOT_SIZE passes it, but it is worth $0.0013 and selling it needs ~45.7 ENA. The live strand carried the same 0.01184 as untracked wallet dust rather than as a fold residual, so this pins the bound against a shape the fold could produce, not against the case that was observed.
    expect(
      resolveFill(
        held('0.0984', '420.88184'),
        sell('420.87', '0.1094'),
        new Decimal('0.01'),
        new Decimal('5'),
      ),
    ).toEqual({ kind: 'empty' });
  });

  it('keeps a residual worth at least minNotional as a partial reduce', () => {
    // 100 units at 0.1094 is $10.94, comfortably sellable, so the position is genuinely still open.
    expect(
      resolveFill(
        held('0.0984', '521.30'),
        sell('421.30', '0.1094'),
        new Decimal('0.01'),
        new Decimal('5'),
      ),
    ).toEqual({ kind: 'sell-reduce', heldQuantity: '100' });
  });

  it('skips the notional flatten when the sell carries no usable price', () => {
    // A zero price would value every residual at zero and empty every position, so an unpriced sell must fall through to the step test alone.
    expect(
      resolveFill(held('0.0984', '521.30'), sell('421.30'), new Decimal('0.01'), new Decimal('5')),
    ).toEqual({ kind: 'sell-reduce', heldQuantity: '100' });
  });

  it('does NOT flatten a deliberate partial sell whose remainder is below minNotional', () => {
    // `rebalance` trims to a target weight on purpose, and a small target is legitimately worth less than the floor. Held 12 at 1.0, sold 8, remainder 4 is under the 5 floor but is 33% of the position, so it is a holding and not a crumb.
    expect(
      resolveFill(held('1', '12'), sell('8', '1'), new Decimal('0.01'), new Decimal('5')),
    ).toEqual({ kind: 'sell-reduce', heldQuantity: '4' });
  });

  it('without minNotional keeps the stepSize-only behavior (replay-safe)', () => {
    // Exactly what shipped: the step test alone passes the crumb through as a live position.
    expect(
      resolveFill(held('0.0984', '420.88184'), sell('420.87', '0.1094'), new Decimal('0.01')),
    ).toEqual({ kind: 'sell-reduce', heldQuantity: '0.01184' });
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

describe('isValuelessResidue', () => {
  // The delete-side bound. `isBelowMinNotional` asks whether a balance clears the
  // exchange's floor; this asks whether it is a rounding error AGAINST that floor,
  // which is a different question with a factor of 100 between the answers. The gap
  // is where a `rebalance` target weight and a mostly-reserved holding live, and
  // both are real positions whose cost basis a delete-side caller must not destroy.
  const price = new Decimal('1');
  const floor = new Decimal('5');

  it('is false for a balance that merely sits below the floor', () => {
    // 4 of 5 is 80% of one minimum order — the exact case a bare floor would delete.
    expect(isBelowMinNotional(new Decimal('4'), price, floor)).toBe(true);
    expect(isValuelessResidue(new Decimal('4'), price, floor)).toBe(false);
  });

  it('is true only once the balance is worth under 1% of one minimum order', () => {
    expect(isValuelessResidue(new Decimal('0.049'), price, floor)).toBe(true);
  });

  it('holds the 1% boundary strictly, so exactly 1% is not residue', () => {
    expect(isValuelessResidue(new Decimal('0.05'), price, floor)).toBe(false);
  });

  it('stands down without a price, because it can only ever remove a position', () => {
    expect(isValuelessResidue(new Decimal('0.0001'), null, floor)).toBe(false);
  });

  it('stands down without a floor, since the floor is its denominator', () => {
    expect(isValuelessResidue(new Decimal('0.0001'), price, null)).toBe(false);
  });

  it('agrees with the live ENAUSDT numbers that motivated it', () => {
    // 0.01184 ENA at 0.1158 is USD 0.00137 against a USD 5 floor: 0.027% of one order.
    expect(
      isValuelessResidue(new Decimal('0.01184'), new Decimal('0.1158'), new Decimal('5')),
    ).toBe(true);
  });
});
