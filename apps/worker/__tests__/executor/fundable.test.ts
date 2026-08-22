import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { AccountSnapshot } from '@app/strategy-core';

import { fundable } from '../../src/executor/fundable.js';

const snapshot = (rows: Record<string, [string, string]>): AccountSnapshot => ({
  readable: true,
  balances: Object.fromEntries(
    Object.entries(rows).map(([asset, [free, locked]]) => [
      asset,
      { asset, free: new Decimal(free), locked: new Decimal(locked) },
    ]),
  ),
});

// The live incident: an adopted orphan SELL holds the whole ENA position, so the
// wallet total says 189.87 while the free balance says 0.
const ENA_LOCKED = snapshot({
  ENA: ['0.00000000', '189.87000000'],
  USDT: ['120.00000000', '0.00000000'],
});

describe('fundable', () => {
  it('a SELL of more base than is FREE is a shortfall, even when the total covers it', () => {
    const out = fundable({
      side: 'SELL',
      symbol: 'ENAUSDT',
      quoteAsset: 'USDT',
      params: { type: 'STOP_LOSS_LIMIT', quantity: '189.87', stopPrice: '0.28', price: '0.277' },
      account: ENA_LOCKED,
    });
    expect(out).toEqual({ kind: 'shortfall', asset: 'ENA', required: '189.87', free: '0' });
  });

  it('a SELL within the free base is fundable', () => {
    const out = fundable({
      side: 'SELL',
      symbol: 'ENAUSDT',
      quoteAsset: 'USDT',
      params: { type: 'MARKET', quantity: '50' },
      account: snapshot({ ENA: ['50', '139.87'] }),
    });
    expect(out).toEqual({ kind: 'fundable' });
  });

  it('a LIMIT BUY is priced at quantity x price against the free quote', () => {
    const short = fundable({
      side: 'BUY',
      symbol: 'ENAUSDT',
      quoteAsset: 'USDT',
      params: { type: 'LIMIT', quantity: '1000', price: '0.30' },
      account: ENA_LOCKED,
    });
    expect(short).toEqual({ kind: 'shortfall', asset: 'USDT', required: '300', free: '120' });

    const ok = fundable({
      side: 'BUY',
      symbol: 'ENAUSDT',
      quoteAsset: 'USDT',
      params: { type: 'LIMIT', quantity: '100', price: '0.30' },
      account: ENA_LOCKED,
    });
    expect(ok).toEqual({ kind: 'fundable' });
  });

  // Every branch below FAILS OPEN. A pre-flight that cannot read the wallet must
  // never be the thing that halts trading — a wrong `unknown` costs one Binance
  // rejection, a wrong `shortfall` costs every order the profile would ever place.
  it('a MARKET BUY has no knowable cost pre-call: unknown, never a shortfall', () => {
    const out = fundable({
      side: 'BUY',
      symbol: 'ENAUSDT',
      quoteAsset: 'USDT',
      params: { type: 'MARKET', quantity: '10000' },
      account: ENA_LOCKED,
    });
    expect(out.kind).toBe('unknown');
  });

  it('a symbol that does not end with the quote asset is not decomposable: unknown', () => {
    const out = fundable({
      side: 'SELL',
      symbol: 'ENABTC',
      quoteAsset: 'USDT',
      params: { type: 'MARKET', quantity: '1' },
      account: ENA_LOCKED,
    });
    expect(out.kind).toBe('unknown');
  });

  it('an empty quote asset, or a symbol that IS the quote asset, is unknown', () => {
    const base = {
      side: 'SELL',
      params: { type: 'MARKET', quantity: '1' },
      account: ENA_LOCKED,
    } as const;
    expect(fundable({ ...base, symbol: 'ENAUSDT', quoteAsset: '' }).kind).toBe('unknown');
    expect(fundable({ ...base, symbol: 'USDT', quoteAsset: 'USDT' }).kind).toBe('unknown');
  });

  it('a cold snapshot (no balance line for the asset) is unknown, not a shortfall', () => {
    const out = fundable({
      side: 'SELL',
      symbol: 'ENAUSDT',
      quoteAsset: 'USDT',
      params: { type: 'MARKET', quantity: '1' },
      account: { balances: {}, readable: true },
    });
    expect(out.kind).toBe('unknown');
  });

  it('an unparseable quantity or price is unknown, not a shortfall', () => {
    expect(
      fundable({
        side: 'SELL',
        symbol: 'ENAUSDT',
        quoteAsset: 'USDT',
        params: { type: 'MARKET', quantity: 'NaN' },
        account: ENA_LOCKED,
      }).kind,
    ).toBe('unknown');
    expect(
      fundable({
        side: 'BUY',
        symbol: 'ENAUSDT',
        quoteAsset: 'USDT',
        params: { type: 'LIMIT', quantity: '10', price: 'Infinity' },
        account: ENA_LOCKED,
      }).kind,
    ).toBe('unknown');
  });

  it('a zero-quantity order requires nothing: unknown, so the exchange filters judge it', () => {
    const out = fundable({
      side: 'SELL',
      symbol: 'ENAUSDT',
      quoteAsset: 'USDT',
      params: { type: 'MARKET', quantity: '0' },
      account: ENA_LOCKED,
    });
    expect(out.kind).toBe('unknown');
  });
});
