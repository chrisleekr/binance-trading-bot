import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { primeBeforeTicks } from '../../src/boot/prime-before-ticks.js';

const silentLogger = pino({ level: 'silent' });

describe('primeBeforeTicks', () => {
  it('awaits the exchangeInfoRefresh function before returning', async () => {
    const exchangeInfoRefresh = vi.fn(async () => ({ fetched: 100 }));
    await primeBeforeTicks({ logger: silentLogger, exchangeInfoRefresh });
    expect(exchangeInfoRefresh).toHaveBeenCalledTimes(1);
  });

  it('tolerates a thrown error so a transient blip does not crash boot', async () => {
    const exchangeInfoRefresh = vi.fn(async () => {
      throw new Error('upstream 503');
    });
    await expect(
      primeBeforeTicks({ logger: silentLogger, exchangeInfoRefresh }),
    ).resolves.toBeUndefined();
    expect(exchangeInfoRefresh).toHaveBeenCalledTimes(1);
  });
});
