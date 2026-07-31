import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Decision } from '@app/strategy-core';

import { applyDailyHalt, suppressBuyEntries } from '../../src/tick/halt-filter.js';

const buy = (symbol = 'BTCUSDT'): Decision =>
  ({
    type: 'place-order',
    intent: { symbol, side: 'BUY', reason: 'tt-entry', clientOrderId: 'c-buy' },
    params: { type: 'MARKET', quantity: '1' },
  }) as Decision;
const sell = (): Decision =>
  ({
    type: 'place-order',
    intent: { symbol: 'BTCUSDT', side: 'SELL', reason: 'tt-stop-loss', clientOrderId: 'c-sell' },
    params: { type: 'MARKET', quantity: '1' },
  }) as Decision;
const cancel = (): Decision => ({ type: 'cancel-order', orderId: 1, reason: 'x' }) as Decision;
const noop = (): Decision => ({ type: 'noop' }) as Decision;

describe('suppressBuyEntries (daily-loss breaker filter)', () => {
  it('drops BUY place-orders but keeps SELLs, cancels, and noops', () => {
    expect(suppressBuyEntries([buy(), sell(), cancel(), noop()])).toEqual({
      kept: [sell(), cancel(), noop()],
      dropped: [buy()],
    });
  });

  it('is a no-op when there are no BUY orders (exits flow untouched)', () => {
    const decisions = [sell(), cancel()];
    expect(suppressBuyEntries(decisions)).toEqual({ kept: decisions, dropped: [] });
  });

  it('drops grid-add BUYs on any symbol (the discriminant is side === BUY)', () => {
    expect(suppressBuyEntries([buy('ETHUSDT')])).toEqual({
      kept: [],
      dropped: [buy('ETHUSDT')],
    });
  });

  it('returns what it dropped, so an override order killed by the breaker is traceable', () => {
    // The dropped set is the ONLY evidence the breaker ate an operator's order:
    // it never reaches the executor, so the tick would otherwise see a strategy
    // that simply chose not to act.
    const { dropped } = suppressBuyEntries([buy(), sell()]);
    expect(dropped).toEqual([buy()]);
  });
});

describe('applyDailyHalt', () => {
  const logger = { warn: vi.fn() };
  const ctx = { profileId: 'p1', symbol: 'BTCUSDT' };
  const redisWith = (exists: () => Promise<number>) =>
    ({ exists: vi.fn(exists) }) as unknown as Parameters<typeof applyDailyHalt>[0];

  beforeEach(() => logger.warn.mockClear());

  it('drops BUYs and warns when the halt flag is present', async () => {
    const out = await applyDailyHalt(
      redisWith(async () => 1),
      'k',
      [buy(), sell()],
      logger,
      ctx,
    );
    expect(out).toEqual({ kept: [sell()], dropped: [buy()] });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('passes decisions through unchanged when the flag is absent', async () => {
    const decisions = [buy(), sell()];
    const out = await applyDailyHalt(
      redisWith(async () => 0),
      'k',
      decisions,
      logger,
      ctx,
    );
    expect(out.kept).toBe(decisions);
    expect(out.dropped).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not warn when halted but there were no BUYs to drop', async () => {
    await applyDailyHalt(
      redisWith(async () => 1),
      'k',
      [sell()],
      logger,
      ctx,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('fails OPEN on a Redis read error — returns the decisions and warns', async () => {
    const decisions = [buy(), sell()];
    const out = await applyDailyHalt(
      redisWith(() => Promise.reject(new Error('redis down'))),
      'k',
      decisions,
      logger,
      ctx,
    );
    expect(out.kept).toBe(decisions);
    // Nothing was suppressed, so nothing may be REPORTED as suppressed: a
    // phantom entry here would settle an operator's override as breaker-rejected
    // when the breaker never even ran.
    expect(out.dropped).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
