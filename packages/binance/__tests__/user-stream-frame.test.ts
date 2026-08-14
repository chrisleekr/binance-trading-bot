import { describe, expect, it } from 'vitest';
import { parseUserStreamFrame } from '../src/index.js';

describe('parseUserStreamFrame', () => {
  it('decodes an executionReport under the event wrapper, mapping every field', () => {
    const event = parseUserStreamFrame({
      event: {
        e: 'executionReport',
        s: 'BTCUSDT',
        i: 42,
        c: 'co-1',
        X: 'FILLED',
        S: 'BUY',
        x: 'TRADE',
        L: '50000',
        l: '0.001',
        z: '0.0015',
        Z: '75',
        n: '0.0000015',
        N: 'BTC',
        t: 9,
        E: 1,
      },
    });
    expect(event).toEqual({
      kind: 'execution-report',
      symbol: 'BTCUSDT',
      orderId: 42,
      clientOrderId: 'co-1',
      orderStatus: 'FILLED',
      side: 'BUY',
      executionType: 'TRADE',
      priceLastFilled: '50000',
      qtyLastFilled: '0.001',
      cumQty: '0.0015',
      cumQuoteQty: '75',
      commission: '0.0000015',
      commissionAsset: 'BTC',
      tradeId: 9,
      eventTimeMs: 1,
    });
  });

  it('accepts a top-level (unwrapped) event shape for legacy-stream tolerance', () => {
    const event = parseUserStreamFrame({
      e: 'executionReport',
      s: 'ETHUSDT',
      i: 7,
      S: 'SELL',
      X: 'NEW',
    });
    expect(event).toMatchObject({ kind: 'execution-report', symbol: 'ETHUSDT', side: 'SELL' });
  });

  it('treats any non-BUY side as SELL', () => {
    const event = parseUserStreamFrame({ e: 'executionReport', S: 'SELL' });
    expect(event).toMatchObject({ side: 'SELL' });
    const missing = parseUserStreamFrame({ e: 'executionReport' });
    expect(missing).toMatchObject({ side: 'SELL' });
  });

  it('defaults missing string/number fields rather than emitting undefined', () => {
    const event = parseUserStreamFrame({ event: { e: 'executionReport' } });
    expect(event).toMatchObject({
      symbol: '',
      orderId: 0,
      priceLastFilled: '0',
      qtyLastFilled: '0',
      cumQty: '0',
      cumQuoteQty: '0',
      commission: '0',
      commissionAsset: '',
      tradeId: 0,
      eventTimeMs: 0,
    });
  });

  it('reads a null commissionAsset as absent, not as the literal "null"', () => {
    // Binance sends `N: null` (an explicit key) on a report with no trade, so
    // a bare String() would produce "null" and match no asset symbol.
    const event = parseUserStreamFrame({
      event: { e: 'executionReport', X: 'CANCELED', x: 'CANCELED', n: null, N: null },
    });
    expect(event).toMatchObject({ commission: '0', commissionAsset: '' });
  });

  it('decodes a balanceUpdate', () => {
    const event = parseUserStreamFrame({
      event: { e: 'balanceUpdate', a: 'USDT', d: '-12.5', E: 3 },
    });
    expect(event).toEqual({
      kind: 'balance-update',
      asset: 'USDT',
      delta: '-12.5',
      eventTimeMs: 3,
    });
  });

  it('decodes an outboundAccountPosition balance array', () => {
    const event = parseUserStreamFrame({
      event: {
        e: 'outboundAccountPosition',
        E: 5,
        B: [
          { a: 'BTC', f: '0.4', l: '0.1' },
          { a: 'USDT', f: '100', l: '0' },
        ],
      },
    });
    expect(event).toEqual({
      kind: 'account-position',
      eventTimeMs: 5,
      balances: [
        { asset: 'BTC', free: '0.4', locked: '0.1' },
        { asset: 'USDT', free: '100', locked: '0' },
      ],
    });
  });

  it('defaults missing balanceUpdate fields (asset/delta/eventTime)', () => {
    // No `a`, `d`, or `E` — exercises the `?? ''` / `?? '0'` / `?? 0` arms.
    const event = parseUserStreamFrame({ event: { e: 'balanceUpdate' } });
    expect(event).toEqual({ kind: 'balance-update', asset: '', delta: '0', eventTimeMs: 0 });
  });

  it('defaults missing per-balance fields in an outboundAccountPosition entry', () => {
    // A balance object missing `a`/`f`/`l` exercises the map() default arms,
    // and a missing top-level `E` exercises the eventTime default.
    const event = parseUserStreamFrame({
      event: { e: 'outboundAccountPosition', B: [{}] },
    });
    expect(event).toEqual({
      kind: 'account-position',
      eventTimeMs: 0,
      balances: [{ asset: '', free: '0', locked: '0' }],
    });
  });

  it('returns an empty balances array when B is absent', () => {
    const event = parseUserStreamFrame({ event: { e: 'outboundAccountPosition', E: 5 } });
    expect(event).toEqual({ kind: 'account-position', eventTimeMs: 5, balances: [] });
  });

  it('returns null for acks, heartbeats, unknown event types, and non-objects', () => {
    expect(parseUserStreamFrame({ id: 'hb-1', result: {} })).toBeNull();
    expect(parseUserStreamFrame({ event: { e: 'someOtherEvent' } })).toBeNull();
    expect(parseUserStreamFrame({})).toBeNull();
    expect(parseUserStreamFrame(null)).toBeNull();
    expect(parseUserStreamFrame('not-an-object')).toBeNull();
  });
});
