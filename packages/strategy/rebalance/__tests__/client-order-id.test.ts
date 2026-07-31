import { describe, expect, it } from 'vitest';
import { rebalanceClientOrderId } from '../src/client-order-id.js';

describe('rebalanceClientOrderId', () => {
  it('is deterministic per (profile, symbol, candle, side) and distinguishes sides', () => {
    const buy = rebalanceClientOrderId('p1', 'BTCUSDT', 1000, 'BUY');
    const sell = rebalanceClientOrderId('p1', 'BTCUSDT', 1000, 'SELL');
    expect(buy).toMatch(/^rb-.*-b$/);
    expect(sell).toMatch(/^rb-.*-s$/);
    expect(buy).not.toBe(sell);
    expect(rebalanceClientOrderId('p1', 'BTCUSDT', 1000, 'BUY')).toBe(buy);
    expect(rebalanceClientOrderId('p1', 'BTCUSDT', 2000, 'BUY')).not.toBe(buy);
  });
});
