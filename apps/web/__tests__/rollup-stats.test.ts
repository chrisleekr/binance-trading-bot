import { SymbolSource } from '@app/contracts';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { RollupStatsLine } from '@/shared/components/rollup-stats-line';

import {
  avgLoss,
  avgWin,
  expectancy,
  formatExpectancy,
  formatProfitFactor,
  payoffRatio,
  profitFactor,
  type RollupStatsBucket,
  sourceLabel,
  winPct,
} from '@/shared/lib/rollup-stats';

/** Bucket with sensible defaults; override only what a case exercises. `netTradeCount` is deliberately absent from the defaults so a case that does not name it exercises the fallback a pre-split payload takes. */
function bucket(p: Partial<RollupStatsBucket> = {}): RollupStatsBucket {
  return {
    tradeCount: 0,
    wins: 0,
    losses: 0,
    grossProfit: '0',
    grossLoss: '0',
    totalFees: '0',
    ...p,
  };
}

describe('rollup-stats trader metrics', () => {
  it('winPct rounds wins / fee-valued trades to a whole percent; 0 valued trades is 0', () => {
    expect(winPct(bucket({ tradeCount: 4, netTradeCount: 4, wins: 1 }))).toBe(25);
    // `wins` only ever counts rows whose fees were known, so the rate divides by those rows. Reading the whole-window count would report 10% here on the same four classified cycles.
    expect(winPct(bucket({ tradeCount: 10, netTradeCount: 4, wins: 1 }))).toBe(25);
    expect(winPct(bucket({ tradeCount: 0, netTradeCount: 0 }))).toBe(0);
  });

  it('falls back to the trade count when a payload carries no second denominator', () => {
    // A payload written before the split computed its counts over every row it had, so `tradeCount` is that payload's own honest denominator. Falling back to zero would render a real 4-trade bucket as `0% win`, replacing a right number with a wrong one.
    expect(winPct(bucket({ tradeCount: 4, wins: 1 }))).toBe(25);
    expect(expectancy(bucket({ tradeCount: 3, grossProfit: '12', grossLoss: '6' }))).toBe(2);
  });

  it('avgWin / avgLoss divide gross magnitudes by their counts, null when none', () => {
    expect(avgWin(bucket({ wins: 2, grossProfit: '10' }))).toBe(5);
    expect(avgWin(bucket({ wins: 0, grossProfit: '0' }))).toBeNull();
    expect(avgLoss(bucket({ losses: 4, grossLoss: '8' }))).toBe(2);
    expect(avgLoss(bucket({ losses: 0 }))).toBeNull();
  });

  it('expectancy is net profit per fee-valued trade (grossProfit − grossLoss) / valued trades', () => {
    // 3 valued trades, +12 winners, −6 losers → net 6 over 3 = +2/trade.
    expect(
      expectancy(bucket({ tradeCount: 3, netTradeCount: 3, grossProfit: '12', grossLoss: '6' })),
    ).toBe(2);
    // Both magnitudes span the valued rows alone, so dividing by every row would drag the average towards zero in proportion to the evidence that was missing.
    expect(
      expectancy(bucket({ tradeCount: 9, netTradeCount: 3, grossProfit: '12', grossLoss: '6' })),
    ).toBe(2);
    // A negative-edge bucket reads negative.
    expect(
      expectancy(bucket({ tradeCount: 2, netTradeCount: 2, grossProfit: '1', grossLoss: '5' })),
    ).toBe(-2);
    expect(expectancy(bucket({ tradeCount: 4, netTradeCount: 0 }))).toBeNull();
  });

  it('payoffRatio is avgWin / avgLoss, null when a side is empty', () => {
    expect(payoffRatio(bucket({ wins: 1, losses: 1, grossProfit: '6', grossLoss: '3' }))).toBe(2);
    expect(payoffRatio(bucket({ wins: 1, losses: 0, grossProfit: '6' }))).toBeNull();
  });

  it('profitFactor: 0 when no winners, null (∞) when no losers, else the ratio', () => {
    expect(profitFactor(bucket({ grossProfit: '0', grossLoss: '5' }))).toBe(0);
    expect(profitFactor(bucket({ grossProfit: '5', grossLoss: '0' }))).toBeNull();
    expect(profitFactor(bucket({ grossProfit: '6', grossLoss: '3' }))).toBe(2);
  });

  it('formatExpectancy: U+2212 minus for negatives, 2 sig-figs sub-1, 2 decimals else', () => {
    expect(formatExpectancy(-0.5)).toBe('−0.50'); // negative → U+2212, sub-1 → 2 sig-figs
    expect(formatExpectancy(0.0033)).toBe('+0.0033'); // small edge keeps 2 sig-figs, not 0
    expect(formatExpectancy(12.5)).toBe('+12.50'); // >= 1 → 2 decimals
    expect(formatExpectancy(0)).toBe('+0.0'); // zero is non-negative → '+'
  });

  // `toPrecision(2)` flips to exponential once the exponent drops below -6, which put a literal `+3.6e-7` in the stats line sitting directly above the archive table.
  it('formatExpectancy keeps a sub-microunit edge in plain notation', () => {
    expect(formatExpectancy(3.6e-7)).toBe('+0.00000036');
    expect(formatExpectancy(-3.6e-7)).toBe('−0.00000036');
  });

  // React stringifies a bare number, so the band rendered whatever `String()` produced; the sub-1 branch of `profitFactor` reaches magnitudes where that is an exponent.
  it('formatProfitFactor spells a sub-1 factor plainly and leaves the rest as-is', () => {
    expect(formatProfitFactor(3.6e-7)).toBe('0.00000036');
    // The readings the bands already show, pinned so the notation fix does not quietly repaint them.
    expect(formatProfitFactor(0)).toBe('0');
    expect(formatProfitFactor(0.5)).toBe('0.5');
    expect(formatProfitFactor(0.0033)).toBe('0.0033');
    expect(formatProfitFactor(6)).toBe('6');
    expect(formatProfitFactor(1.25)).toBe('1.25');
  });
});

describe('sourceLabel', () => {
  it.each([
    ['auto', 'Discovery (auto-found)'],
    ['manual', 'You added it'],
    ['unknown', 'Recovered by the bot'],
  ])('glosses %s for an operator who did not write the enum', (source, label) => {
    expect(sourceLabel(source)).toBe(label);
  });

  // Derived from the contract enum at runtime, not from a hand-copied list: a fourth provenance would otherwise ship to the archive page as a bare column value with nothing telling the operator what it means.
  it('glosses every provenance the contract can produce', () => {
    for (const source of SymbolSource.options) {
      expect(sourceLabel(source)).not.toBe(source);
    }
  });

  // Archive rows predate the enum and are never rewritten, so an unrecognised value must render as itself instead of blanking the column.
  it('passes an unrecognised value through unchanged', () => {
    expect(sourceLabel('legacy-import')).toBe('legacy-import');
  });
});

describe('<RollupStatsLine> fee-tier gating', () => {
  // ONE numeric bucket, driven through all three tiers. 5 trades, 4 wins, gross 12 against 2: 80% win, profit factor 6, payoff 1.5, expectancy +2.00 per trade. Anything that reads differently between the cases below is the tier, not the arithmetic.
  const NUMBERS = {
    tradeCount: 5,
    netTradeCount: 5,
    wins: 4,
    losses: 1,
    grossProfit: '12',
    grossLoss: '2',
    totalFees: '0',
  };

  /** Render the line at one tier and hand back its text. */
  const lineAt = (feeBasis: string): string => {
    const { container, unmount } = render(
      createElement(RollupStatsLine, {
        bucket: { ...NUMBERS, feeBasis } as Parameters<typeof RollupStatsLine>[0]['bucket'],
      }),
    );
    const text = container.textContent ?? '';
    unmount();
    return text;
  };

  it('withholds every fee-derived statistic at the unknown tier, keeping the trade count', () => {
    // The tier is reached only when NO cycle in the bucket could be valued, so there is nothing left for a ratio to be a ratio of. The win rate goes with the other three: a cycle counts as a win by clearing its fees, so a rate stated where no fee was ever read is classified against a charge nobody has. Under-stating a fee only ever flatters it, which is the same one-way bias that withholds the other three.
    const text = lineAt('unknown');
    expect(text).toContain('5 trades');
    expect(text).not.toContain('% win');
    expect(text).not.toContain('PF');
    expect(text).not.toContain('payoff');
    expect(text).not.toContain('exp ');
  });

  it('states the covered count when the bucket left cycles out, and stays silent when it did not', () => {
    // The ratios on this line have a different denominator from the trade count beside them, and this is the only place the reader is told so.
    const { container, unmount } = render(
      createElement(RollupStatsLine, {
        bucket: { ...NUMBERS, tradeCount: 7, netTradeCount: 5, feeBasis: 'exact' } as Parameters<
          typeof RollupStatsLine
        >[0]['bucket'],
      }),
    );
    const partial = container.textContent ?? '';
    unmount();
    expect(partial).toContain('7 trades');
    expect(partial).toContain('5 of 7 cycles');
    // Win rate and expectancy stay on the five rows that were valued, not the seven.
    expect(partial).toContain('80% win');
    expect(partial).toContain('exp +2.00');
    // A bucket that valued everything says nothing extra, or the disclosure becomes noise the reader learns to skip.
    expect(lineAt('exact')).not.toContain('cycles');
  });

  it('renders all five statistics at the estimated tier and says so in words', () => {
    // Marked in TEXT, not by colour: the operator reads this on a phone, and a tint is not a claim anyone can repeat back.
    const text = lineAt('estimated');
    expect(text).toContain('5 trades');
    expect(text).toContain('80% win');
    expect(text).toContain('PF 6');
    expect(text).toContain('payoff 1.50');
    expect(text).toContain('exp +2.00');
    expect(text.toLowerCase()).toContain('estimated');
  });

  it('renders all five statistics unmarked at the exact tier', () => {
    // The no-change case. Without it, a line that marks everything estimated satisfies the case above.
    const text = lineAt('exact');
    expect(text).toContain('5 trades');
    expect(text).toContain('80% win');
    expect(text).toContain('PF 6');
    expect(text).toContain('payoff 1.50');
    expect(text).toContain('exp +2.00');
    expect(text.toLowerCase()).not.toContain('estimated');
  });
});
