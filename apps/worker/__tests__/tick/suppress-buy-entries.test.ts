import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Decision } from '@app/strategy-core';

import { EntryHaltKind } from '@app/contracts';

import { applyEntryHalts, suppressBuyEntries } from '../../src/tick/halt-filter.js';

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
// A replacement's successor is unconstrained by the order it retires, so a BUY replacement can commit strictly more than what was resting. The breaker keys on the variant, so leaving this shape out is a way around it.
const replaceBuy = (): Decision =>
  ({
    type: 'replace-order',
    cancelOrderId: 7,
    reason: 'tt-grid-trail-down',
    intent: { symbol: 'BTCUSDT', side: 'BUY', reason: 'tt-entry', clientOrderId: 'c-rebuy' },
    params: { type: 'LIMIT', quantity: '1', price: '90', timeInForce: 'GTC' },
  }) as Decision;
const replaceSell = (): Decision =>
  ({
    type: 'replace-order',
    cancelOrderId: 8,
    reason: 'tt-protective-stop-superseded',
    intent: { symbol: 'BTCUSDT', side: 'SELL', reason: 'tt-stop-loss', clientOrderId: 'c-exit' },
    params: { type: 'MARKET', quantity: '1' },
  }) as Decision;
const cancel = (): Decision => ({ type: 'cancel-order', orderId: 1, reason: 'x' }) as Decision;
const noop = (): Decision => ({ type: 'noop' }) as Decision;

describe('suppressBuyEntries (entry-breaker filter)', () => {
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

  it('drops a BUY replacement and keeps a SELL one', () => {
    expect(suppressBuyEntries([replaceBuy(), replaceSell()])).toEqual({
      kept: [replaceSell()],
      dropped: [replaceBuy()],
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

describe('applyEntryHalts', () => {
  const logger = { warn: vi.fn() };
  const ctx = { profileId: 'p1', symbol: 'BTCUSDT' };
  // Written in the REVERSE of `EntryHaltKind` order on purpose: the reporting order is the enum's, not this object's, and that is only an assertion while the two disagree here.
  const keys: Readonly<Record<EntryHaltKind, string>> = {
    drawdown: 'k:drawdown',
    'loss-streak': 'k:streak',
    'daily-loss': 'k:daily',
  };
  // `exists` is called both multi-key (the "is anything set" probe) and single-key (naming the active breakers), so the stub answers per key name.
  const redisWith = (present: ReadonlySet<string>) =>
    ({
      exists: vi.fn(async (...ks: string[]) => ks.filter((k) => present.has(k)).length),
    }) as unknown as Parameters<typeof applyEntryHalts>[0];
  // The multi-key probe says something is set, then every flag is gone by the time the per-key pass runs — the TTL expired in between.
  const redisExpiringMidRead = () => {
    let probed = false;
    return {
      exists: vi.fn(async () => {
        if (!probed) {
          probed = true;
          return 1;
        }
        return 0;
      }),
    } as unknown as Parameters<typeof applyEntryHalts>[0];
  };
  const redisThrowing = () =>
    ({
      exists: vi.fn(() => Promise.reject(new Error('redis down'))),
    }) as unknown as Parameters<typeof applyEntryHalts>[0];

  beforeEach(() => logger.warn.mockClear());

  it('passes decisions through untouched when no breaker is set', async () => {
    const decisions = [buy(), sell()];
    const out = await applyEntryHalts(redisWith(new Set()), keys, decisions, logger, ctx);
    // Referential identity, not just deep equality: the no-halt path is every tick, and a copy here would be a per-tick allocation with no purpose.
    expect(out.kept).toBe(decisions);
    expect(out.dropped).toEqual([]);
    expect(out.kinds).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('drops BUYs and keeps exits when a guard key alone is present', async () => {
    const out = await applyEntryHalts(
      redisWith(new Set(['k:streak'])),
      keys,
      [buy(), sell(), cancel(), noop()],
      logger,
      ctx,
    );
    // Both halves asserted: "dropped something" alone passes for a filter that drops everything, which would block the exit the breaker must never touch.
    expect(out.dropped).toEqual([buy()]);
    expect(out.kept).toEqual([sell(), cancel(), noop()]);
    expect(out.kinds).toEqual(['loss-streak']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // The PAYLOAD, not just the call. The operator log is the only place a suppressed tick names which breaker did it, so dropping `kinds` from the log object has to fail here rather than pass on a warn-was-called check.
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      profileId: 'p1',
      symbol: 'BTCUSDT',
      kinds: ['loss-streak'],
      dropped: 1,
    });
  });

  it('reports every active breaker, in EntryHaltKind order', async () => {
    // The fixture disagrees with the enum, so an implementation that enumerated `keys` would report ['drawdown', 'daily-loss'] here. Asserted rather than assumed: re-sorting the fixture into enum order would otherwise turn this whole test vacuous without failing anything.
    expect(Object.keys(keys)).not.toEqual([...EntryHaltKind.options]);
    const out = await applyEntryHalts(
      redisWith(new Set(['k:drawdown', 'k:daily'])),
      keys,
      [buy()],
      logger,
      ctx,
    );
    expect(out.kinds).toEqual(['daily-loss', 'drawdown']);
    // Both kinds reach the log, in the same order, so a two-breaker pause is not reported to the operator as a one-breaker pause.
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ kinds: ['daily-loss', 'drawdown'] });
  });

  it('does not warn when halted but there were no BUYs to drop', async () => {
    await applyEntryHalts(redisWith(new Set(['k:daily'])), keys, [sell()], logger, ctx);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('treats a flag that expired between the two passes as no halt at all', async () => {
    const decisions = [buy(), sell()];
    const out = await applyEntryHalts(redisExpiringMidRead(), keys, decisions, logger, ctx);
    // Suppressing here would drop BUYs while naming no breaker, and the tick handler would then have to invent a kind for the operator's rejection reason — telling them the daily limit killed their override when nothing did. Every key has expired, so buying genuinely should resume.
    expect(out.kept).toBe(decisions);
    expect(out.dropped).toEqual([]);
    expect(out.kinds).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('fails OPEN on a Redis read error — returns the decisions and warns', async () => {
    const decisions = [buy(), sell()];
    const out = await applyEntryHalts(redisThrowing(), keys, decisions, logger, ctx);
    expect(out.kept).toBe(decisions);
    // Nothing was suppressed, so nothing may be REPORTED as suppressed: a phantom entry here would settle an operator's override as breaker-rejected when the breaker never even ran, and a phantom kind would name a breaker that was never read.
    expect(out.dropped).toEqual([]);
    expect(out.kinds).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
