import { describe, expect, it } from 'vitest';
import { computeSiblingConflict, siblingQuoteAssets } from '../../src/crons/sibling-conflict.js';

describe('computeSiblingConflict (#661)', () => {
  it('C6: sharing the candidate’s quote asset is NOT a conflict; a base that equals a sibling quote IS', () => {
    // Two siblings settle in USDT, same as the candidate AAAUSDT's own quote. That
    // is the normal multi-profile case — sharing a quote asset is not a collision,
    // so a candidate whose base (AAA) no sibling owns or quotes is free to admit.
    expect(computeSiblingConflict('AAA', false, ['USDT', 'USDT'])).toBeNull();

    // Base-vs-quote: a sibling that SETTLES in AAA (e.g. trades XXXAAA) shares the
    // AAA wallet line the candidate would buy, so AAAUSDT is a quote conflict.
    expect(computeSiblingConflict('AAA', false, ['AAA'])).toBe('sibling-quotes-base');
  });

  it('owns-base outranks a simultaneous quote collision', () => {
    // A sibling both trades AAA and quotes in it: the stronger owns-base verdict wins.
    expect(computeSiblingConflict('AAA', true, ['AAA'])).toBe('sibling-owns-base');
    expect(computeSiblingConflict('AAA', true, [])).toBe('sibling-owns-base');
  });

  it('no owner and no quote match is free to admit', () => {
    expect(computeSiblingConflict('AAA', false, ['BTC', 'ETH'])).toBeNull();
  });
});

describe('siblingQuoteAssets (#661)', () => {
  it('C7: excludes self; rows come from the account-scoped read so cross-account/cross-mode profiles never appear', () => {
    // `listForAccount` returns only THIS account's profiles, and one account owns
    // exactly one binance_mode, so a different-mode profile is under a different
    // account and is never in `rows` — only self needs dropping here.
    const rows = [
      { id: 'self', quoteAsset: 'BTC' },
      { id: 'sib-a', quoteAsset: 'USDT' },
      { id: 'sib-b', quoteAsset: 'ETH' },
    ];
    expect(siblingQuoteAssets(rows, 'self')).toEqual(['USDT', 'ETH']);
  });

  it('a single-profile account yields no sibling quotes', () => {
    expect(siblingQuoteAssets([{ id: 'self', quoteAsset: 'USDT' }], 'self')).toEqual([]);
  });
});
