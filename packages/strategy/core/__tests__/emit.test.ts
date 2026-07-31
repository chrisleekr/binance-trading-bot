import { describe, it, expect } from 'vitest';
import { log, metric } from '../src/emit.js';

describe('log', () => {
  it('builds a LogEntry with context', () => {
    expect(log('info', 'tt-x', { reason: 'r', symbol: 'BTCUSDT' })).toEqual({
      level: 'info',
      message: 'tt-x',
      context: { reason: 'r', symbol: 'BTCUSDT' },
    });
  });

  it('omits the context key entirely when not supplied (byte-identical to a bare log)', () => {
    const entry = log('warn', 'tt-y');
    expect(entry).toEqual({ level: 'warn', message: 'tt-y' });
    expect('context' in entry).toBe(false);
  });
});

describe('metric', () => {
  it('defaults value to 1 and carries the tags', () => {
    expect(metric('tt_emit', { symbol: 'BTCUSDT' })).toEqual({
      name: 'tt_emit',
      value: 1,
      tags: { symbol: 'BTCUSDT' },
    });
  });

  it('accepts a non-default value', () => {
    expect(metric('tt_count', { symbol: 'ETHUSDT' }, 3)).toEqual({
      name: 'tt_count',
      value: 3,
      tags: { symbol: 'ETHUSDT' },
    });
  });

  it('omits the tags key entirely when not supplied', () => {
    const m = metric('tt_bare');
    expect(m).toEqual({ name: 'tt_bare', value: 1 });
    expect('tags' in m).toBe(false);
  });

  it('honors an explicit value with tags omitted', () => {
    expect(metric('tt_bare', undefined, 4)).toEqual({ name: 'tt_bare', value: 4 });
  });
});
