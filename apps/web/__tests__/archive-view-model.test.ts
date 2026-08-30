// The basis resolver behind the archive panel. These are the assertions the
// panel-level tests cannot make cheaply: every basis/edge combination for one
// row, and the apportionment arithmetic that has to add up to 100 across a
// whole quote-coin group.

import { describe, expect, it } from 'vitest';

import {
  bucketPnl,
  rowPnl,
  sharesOfPnl,
  type ArchiveRowPnlFields,
} from '@/features/profile/lib/archive-view-model';

/** An archive row, defaulting the fields a given assertion does not care about. */
function row(partial: Partial<ArchiveRowPnlFields> = {}): ArchiveRowPnlFields {
  return {
    totalBuyQuote: '100',
    profit: '10',
    netProfit: '9',
    missingCostBasis: 0,
    feeBasis: 'exact',
    ...partial,
  };
}

/** A rollup bucket carrying only the fields the basis resolver reads. */
function bucket(quoteAsset: string, profitSum: string, netProfit: string, feeBasis = 'exact') {
  return { quoteAsset, profitSum, netProfit, feeBasis };
}

/** The percent of an available row, or `null` when the row reports no P/L. */
function percentOf(r: ArchiveRowPnlFields, basis: 'net' | 'gross'): string | null {
  const resolved = rowPnl(r, basis);
  return resolved.available ? resolved.pnlPercent : null;
}

describe('rowPnl', () => {
  it('divides the NET profit by the cost basis under the net basis', () => {
    expect(rowPnl(row(), 'net')).toEqual({
      available: true,
      pnl: '9',
      pnlPercent: '9',
      estimated: false,
    });
  });

  it('divides the GROSS profit by the cost basis under the gross basis', () => {
    expect(rowPnl(row(), 'gross')).toEqual({
      available: true,
      pnl: '10',
      pnlPercent: '10',
      estimated: false,
    });
  });

  it('flags a Net figure whose commission was reconstructed, and only under Net', () => {
    // The only place `estimated: true` is produced. Every other case in this file asserts `false`, so without this one `const estimated = false;` passes the whole suite and both `est` markers — the desktop table's and the mobile card's — vanish with it.
    const est = row({ feeBasis: 'estimated' });
    expect(rowPnl(est, 'net')).toEqual({
      available: true,
      pnl: '9',
      pnlPercent: '9',
      estimated: true,
    });
    // Recorded P/L does not subtract fees at all, so no fee tier can qualify it. Marking it would point at a caveat that does not apply to the number shown.
    expect(rowPnl(est, 'gross')).toEqual({
      available: true,
      pnl: '10',
      pnlPercent: '10',
      estimated: false,
    });
  });

  it('reports no P/L at all for an un-costed row, under either basis', () => {
    // Not "zero percent": a cycle whose sale had no recorded purchase price contributes nothing to `profit`, so any number here is an under-count wearing a confident face.
    const uncosted = row({ missingCostBasis: 2, totalBuyQuote: '0', profit: '0', netProfit: '0' });
    expect(rowPnl(uncosted, 'net')).toEqual({ available: false, reason: 'cost-basis' });
    expect(rowPnl(uncosted, 'gross')).toEqual({ available: false, reason: 'cost-basis' });
  });

  it('withholds only Net P/L when fee accounting is incomplete', () => {
    const incomplete = row({ feeBasis: 'unknown' });
    expect(rowPnl(incomplete, 'net')).toEqual({ available: false, reason: 'fees' });
    expect(rowPnl(incomplete, 'gross')).toEqual({
      available: true,
      pnl: '10',
      pnlPercent: '10',
      estimated: false,
    });
  });

  it('yields zero percent, not Infinity, when the cost basis is zero', () => {
    // A costed row can still have a zero buy total (a position carried in from outside the bot). Dividing by it produces Infinity or NaN, and either one renders as a percentage the operator cannot act on.
    const zeroCost = row({ totalBuyQuote: '0', profit: '5', netProfit: '4' });
    expect(rowPnl(zeroCost, 'net')).toEqual({
      available: true,
      pnl: '4',
      pnlPercent: '0',
      estimated: false,
    });
    expect(rowPnl(zeroCost, 'gross')).toEqual({
      available: true,
      pnl: '5',
      pnlPercent: '0',
      estimated: false,
    });
  });

  it('keeps a loss negative on both halves of the pair', () => {
    const loser = row({ totalBuyQuote: '200', profit: '-10', netProfit: '-13' });
    expect(rowPnl(loser, 'net')).toEqual({
      available: true,
      pnl: '-13',
      pnlPercent: '-6.5',
      estimated: false,
    });
    expect(rowPnl(loser, 'gross')).toEqual({
      available: true,
      pnl: '-10',
      pnlPercent: '-5',
      estimated: false,
    });
  });

  it('moves the percent whenever the basis moves on a fee-paying row', () => {
    // The defect in one line: the amount followed the toggle and the percent did not.
    const feePayer = row({ totalBuyQuote: '200', profit: '20', netProfit: '17' });
    expect(percentOf(feePayer, 'net')).not.toBe(percentOf(feePayer, 'gross'));
  });

  // The wire contract admits exponent notation, so a value that parses to Infinity is representable even though a numeric(20,10) column cannot emit one. These pin the guards that keep such a value from rendering as a percentage nobody can act on. Each uses an input that the guard actually changes the answer for: an unparseable cost basis divides to NaN, and an infinite amount divides to Infinity. (An INFINITE cost basis needs no guard — dividing by it already gives zero.)
  it('yields zero percent when the cost basis does not parse to a number at all', () => {
    expect(rowPnl(row({ totalBuyQuote: 'not-a-number' }), 'net')).toEqual({
      available: true,
      pnl: '9',
      pnlPercent: '0',
      estimated: false,
    });
  });

  it('yields zero percent when the amount does not parse to a finite number', () => {
    expect(rowPnl(row({ netProfit: '1e400' }), 'net')).toEqual({
      available: true,
      pnl: '1e400',
      pnlPercent: '0',
      estimated: false,
    });
  });
});

// The identity every rendered pair must satisfy: the percent is the amount's
// own share of the cost basis, so reading the percent back out has to return
// the amount. Rows with no cost basis and un-costed rows are excluded — they
// have no derivable percentage, which the cases above pin separately.
const PROPERTY_ROWS: readonly ArchiveRowPnlFields[] = [
  row(),
  row({ totalBuyQuote: '200', profit: '20', netProfit: '17' }),
  row({ totalBuyQuote: '200', profit: '-10', netProfit: '-13' }),
  row({ totalBuyQuote: '0.00000123', profit: '0.00000041', netProfit: '0.00000039' }),
  row({ totalBuyQuote: '1234567.89', profit: '3.21', netProfit: '0.07' }),
  row({ totalBuyQuote: '3', profit: '1', netProfit: '1' }),
  // A near-flat gross beside a fee-only net loss. Gross is deliberately non-zero: a zero amount yields a zero percent, and `0 ≈ 0` would hold for any implementation, including a hard-coded '0'.
  row({ totalBuyQuote: '100', profit: '0.2', netProfit: '-0.4' }),
];

describe.each(['net', 'gross'] as const)(
  'rowPnl derives the percent from the SAME amount it returns (%s basis)',
  (basis) => {
    it.each(PROPERTY_ROWS.map((r, i) => [i, r] as const))(
      'row %i reads back to its own amount',
      (_i, r) => {
        const resolved = rowPnl(r, basis);
        if (!resolved.available) throw new Error('fixture must be costed');
        const readBack = (Number(resolved.pnlPercent) / 100) * Number(r.totalBuyQuote);
        expect(readBack).toBeCloseTo(Number(resolved.pnl), 10);
      },
    );
  },
);

describe('bucketPnl', () => {
  it('selects the net sum under net and the gross sum under gross', () => {
    const b = bucket('USDT', '394', '380');
    expect(bucketPnl(b, 'net')).toBe('380');
    expect(bucketPnl(b, 'gross')).toBe('394');
  });

  it('withholds an incomplete net subtotal but keeps the recorded sum', () => {
    const b = bucket('USDT', '394', '380', 'unknown');
    expect(bucketPnl(b, 'net')).toBeNull();
    expect(bucketPnl(b, 'gross')).toBe('394');
  });
});

describe('sharesOfPnl', () => {
  // Gross splits 39.4 / 24.4 / 36.2; three independent roundings give 99.
  const buckets = [
    bucket('USDT', '394', '380'),
    bucket('USDT', '-244', '-288'),
    bucket('USDT', '362', '350'),
  ];

  it('apportions the leftover point so a group totals exactly 100', () => {
    const shares = sharesOfPnl(buckets, 'gross').map((b) => b.share);
    expect(shares.reduce((a, b) => a + (b ?? 0), 0)).toBe(100);
    // The point goes to the largest remainder (both 0.4 here, so the earlier bucket), never to whichever bucket happens to be last.
    expect(shares).toEqual([40, 24, 36]);
  });

  it('changes the split when the basis changes', () => {
    const net = sharesOfPnl(buckets, 'net').map((b) => b.share);
    const gross = sharesOfPnl(buckets, 'gross').map((b) => b.share);
    expect(net.reduce((a, b) => a + (b ?? 0), 0)).toBe(100);
    expect(net).not.toEqual(gross);
  });

  it('withholds every Net share in a quote group when one bucket is incomplete', () => {
    const mixed = [bucket('USDT', '75', '70'), bucket('USDT', '25', '20', 'unknown')];
    expect(sharesOfPnl(mixed, 'net').map((b) => b.share)).toEqual([null, null]);
    expect(sharesOfPnl(mixed, 'gross').map((b) => b.share)).toEqual([75, 25]);
  });

  it('counts losers toward the total, so a share is a portion of all the action', () => {
    // Signed sums would let a win and a loss cancel into a near-zero denominator and blow every share up.
    const shares = sharesOfPnl([bucket('USDT', '50', '50'), bucket('USDT', '-50', '-50')], 'gross');
    expect(shares.map((b) => b.share)).toEqual([50, 50]);
  });

  it('apportions each quote coin against its own total', () => {
    const mixed = [
      bucket('USDT', '75', '75'),
      bucket('BTC', '1', '1'),
      bucket('USDT', '25', '25'),
      bucket('BTC', '3', '3'),
    ];
    expect(sharesOfPnl(mixed, 'gross').map((b) => b.share)).toEqual([75, 25, 25, 75]);
  });

  it('gives every bucket zero when the quote coin nets out to nothing', () => {
    const flat = [bucket('USDT', '0', '0'), bucket('USDT', '0', '0')];
    expect(sharesOfPnl(flat, 'gross').map((b) => b.share)).toEqual([0, 0]);
    expect(sharesOfPnl(flat, 'net').map((b) => b.share)).toEqual([0, 0]);
  });

  it('keeps each share attached to its own bucket', () => {
    // The reason this returns decorated buckets rather than a parallel array: a caller that re-sorts or filters cannot silently pair a share with the wrong exit reason.
    const decorated = sharesOfPnl(buckets, 'gross');
    expect(decorated[0]).toMatchObject({ profitSum: '394', share: 40 });
    expect(decorated[1]).toMatchObject({ profitSum: '-244', share: 24 });
  });

  it('drops a bucket that does not parse to a finite number instead of NaN-ing every share in its group', () => {
    // Without the guard the group total becomes NaN and every share in the coin renders as NaN, losing the buckets that were perfectly readable.
    const shares = sharesOfPnl(
      [bucket('USDT', '1e400', '1e400'), bucket('USDT', '50', '50'), bucket('USDT', '50', '50')],
      'gross',
    );
    expect(shares.map((b) => b.share)).toEqual([0, 50, 50]);
  });

  it('marks every bucket multi-quote when the buckets span more than one quote coin', () => {
    // The flag rides the bucket rather than being recomputed at each render site, so the two bands cannot disagree about whether a share's denominator needs naming. It is on EVERY bucket, including the coins that are not themselves ambiguous: the reader's problem is the list holding two pools that each total 100, and a single-coin bucket sitting in that list is one of the two.
    const mixed = [bucket('USDT', '75', '75'), bucket('BTC', '1', '1'), bucket('USDT', '25', '25')];
    expect(sharesOfPnl(mixed, 'gross').map((b) => b.multiQuote)).toEqual([true, true, true]);
  });

  it('leaves every bucket single-quote when one coin covers them all', () => {
    expect(sharesOfPnl(buckets, 'gross').map((b) => b.multiQuote)).toEqual([false, false, false]);
  });

  it('marks buckets multi-quote independently of whether their shares survived', () => {
    // The withholding is per quote coin and the flag is over the whole list, so a coin whose Net shares are all null must still say the list is ambiguous — otherwise the one coin that DID resolve renders a bare "100% of P/L" beside a pool it is not a share of.
    const mixed = [bucket('USDT', '75', '70', 'unknown'), bucket('BTC', '1', '1')];
    const decorated = sharesOfPnl(mixed, 'net');
    expect(decorated.map((b) => b.share)).toEqual([null, 100]);
    expect(decorated.map((b) => b.multiQuote)).toEqual([true, true]);
  });

  it('returns an empty list for no buckets', () => {
    expect(sharesOfPnl([], 'net')).toEqual([]);
  });
});
