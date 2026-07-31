import { describe, it, expect } from 'vitest';
import { messageParts } from '../src/format.js';

describe('messageParts', () => {
  it('joins profile and symbol into one context line', () => {
    const parts = messageParts({
      severity: 'info',
      topic: 't',
      title: 'T',
      profile: 'RealNet-Momentum',
      symbol: 'BTCUSDT',
    });
    expect(parts.context).toBe('RealNet-Momentum · BTCUSDT');
  });

  it('uses whichever single side is present', () => {
    expect(messageParts({ severity: 'info', topic: 't', title: 'T', profile: 'P' }).context).toBe(
      'P',
    );
    expect(
      messageParts({ severity: 'info', topic: 't', title: 'T', symbol: 'BTCUSDT' }).context,
    ).toBe('BTCUSDT');
  });

  it('omits context when neither profile nor symbol is present', () => {
    expect(messageParts({ severity: 'info', topic: 't', title: 'T' }).context).toBeUndefined();
  });

  it('defaults fields to an empty array so providers can iterate safely', () => {
    expect(messageParts({ severity: 'info', topic: 't', title: 'T' }).fields).toEqual([]);
  });
});
