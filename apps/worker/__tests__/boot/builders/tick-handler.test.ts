import { describe, expect, it, vi } from 'vitest';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { explainProtectiveStopBandRefusal, percentPriceBySideRefusal } from '@app/strategy-core';

import type { BootEnv } from '../../../src/boot/boot-env.js';
import type { TickHandlerDeps } from '../../../src/tick/tick-types.js';
import { buildChain } from '../../../src/boot/builders/chain.js';
import { anyProxy, fakeDb, fakeQueueSet, fakeRedis, silentLogger } from './fakes.js';

/**
 * The builder hands its assembled deps to `createTickHandler` and returns only
 * the handler, so the production notifier closures are reachable nowhere else.
 * Mocked by the path the test file resolves (a tsconfig alias is not a module id
 * vitest can match).
 */
const captured: { deps?: TickHandlerDeps } = {};
vi.mock('../../../src/tick/tick-handler.js', () => ({
  createTickHandler: (deps: TickHandlerDeps) => {
    captured.deps = deps;
    return async () => undefined;
  },
}));

const { buildTickHandler } = await import('../../../src/boot/builders/tick-handler.js');

const ENV: BootEnv = { redisUrl: 'redis://localhost:1', pgUrl: 'postgres://localhost:1/x' };
const OPERATOR = asUserId('11111111-1111-4111-8111-111111111111');
const ACCOUNT = asAccountId('33333333-3333-4333-8333-333333333333');
const PROFILE = asProfileId('22222222-2222-4222-8222-222222222222');
const SYMBOL = 'LINKUSDT';

interface Built {
  readonly slice: ReturnType<typeof buildTickHandler>;
  readonly deps: TickHandlerDeps;
  readonly events: Record<string, unknown>[];
  readonly stopKeys: string[];
}

const build = (allowStop = true): Built => {
  const events: Record<string, unknown>[] = [];
  const stopKeys: string[] = [];
  const slice = buildTickHandler({
    env: ENV,
    db: fakeDb(),
    redis: fakeRedis(),
    logger: silentLogger(),
    chain: buildChain(),
    queueSet: fakeQueueSet(),
    liveExecutor: anyProxy(),
    coldLoad: anyProxy(),
    symbolInfoCache: { get: async () => ({}) } as never,
    statePort: anyProxy(),
    metrics: anyProxy(),
    klineFetcher: anyProxy(),
    notifyEvent: async (event) => {
      events.push(event as unknown as Record<string, unknown>);
    },
    orderFailedThrottle: { allow: async () => true } as never,
    protectiveStopBlockedThrottle: {
      allow: async (key: string) => {
        stopKeys.push(key);
        return allowStop;
      },
    } as never,
    auditShipper: anyProxy(),
  });
  const deps = captured.deps;
  if (!deps) throw new Error('buildTickHandler did not construct a tick handler');
  return { slice, deps, events, stopKeys };
};

const BAND = {
  bidMultiplierUp: '1.1',
  bidMultiplierDown: '0.5',
  askMultiplierUp: '2',
  askMultiplierDown: '0.9',
  avgPriceMins: 5,
};
const REFERENCE = '100';

/**
 * A refusal detail as the strategy package actually mints it, per breached bound.
 *
 * Built rather than typed out because the two branches differ in a number a
 * hand-written bag is free to invent: a ceiling breach prices the trigger ABOVE
 * the reference, so its `requiredStopDistancePct` is negative — the reason the
 * gloss withholds it — while a hand-written positive one would let this file
 * assert a message shape the code can never produce.
 */
const refusalDetail = (bound: 'floor' | 'ceiling'): Readonly<Record<string, unknown>> => {
  const blocker = percentPriceBySideRefusal({
    symbol: SYMBOL,
    reference: REFERENCE,
    band: BAND,
    // Floor: the limit leg sits under `ref × 0.9` at a 0.98 offset. Ceiling: the
    // trigger clears `ref × 2` while the limit stays inside it, which is the only
    // shape that reaches the ceiling branch at all.
    desired:
      bound === 'floor'
        ? { stopPrice: '91.24', price: '89.4152', quantity: '3.13' }
        : { stopPrice: '260', price: '250', quantity: '3.13' },
    guarded: false,
  });
  if (blocker === null) throw new Error(`the band did not refuse the ${bound} fixture`);
  if (blocker.detail['bound'] !== bound) {
    throw new Error(`the ${bound} fixture breached ${String(blocker.detail['bound'])} instead`);
  }
  return blocker.detail;
};

/**
 * `bound` and `sinceMs` are overridable because they select whole branches of
 * the message, not just wording: the ceiling body carries the OPPOSITE
 * instruction to the floor one, and a known span adds a field.
 */
const blocked = (
  terminal: boolean,
  overrides: { readonly bound?: 'floor' | 'ceiling'; readonly sinceMs?: number | null } = {},
) => ({
  operatorId: OPERATOR,
  accountId: ACCOUNT,
  profileId: PROFILE,
  symbol: SYMBOL,
  reason: 'price-outside-exchange-band',
  detail: refusalDetail(overrides.bound ?? 'floor'),
  terminal,
  sinceMs: overrides.sinceMs ?? null,
});

describe('buildTickHandler', () => {
  it('exposes the profile-context cache (for eviction) and the tick handler', () => {
    const { slice } = build();

    expect(Object.keys(slice).sort()).toEqual(['profileContextCache', 'tickHandler']);
    expect(typeof slice.profileContextCache.evictProfile).toBe('function');
    expect(slice.tickHandler).toBeDefined();
  });
});

describe('buildTickHandler — the protective-stop-blocked notifier', () => {
  it('keys the throttle on the escalation level so the two never mute each other', async () => {
    // "Wait for the price to come back" and "no price ever arms this stop" are
    // different instructions and the recoverable one always fires first: on a
    // shared key it would swallow the terminal escalation for the whole window.
    const { deps, stopKeys } = build();
    const notify = deps.notifyProtectiveStopBlocked;
    if (!notify) throw new Error('the builder did not wire notifyProtectiveStopBlocked');

    await notify(blocked(false));
    await notify(blocked(true));

    expect(stopKeys).toEqual([`${PROFILE}:${SYMBOL}:persistent`, `${PROFILE}:${SYMBOL}:terminal`]);
  });

  it('sends nothing when the throttle window is already open', async () => {
    const { deps, events } = build(false);
    const notify = deps.notifyProtectiveStopBlocked;
    if (!notify) throw new Error('the builder did not wire notifyProtectiveStopBlocked');

    await notify(blocked(true));

    expect(events).toEqual([]);
  });

  it('files under order-failed, the category an operator already watches', async () => {
    // A stop the exchange never accepted is the same class of event as one it
    // rejected; a category of its own would need its own opt-in to be seen.
    const { deps, events } = build();
    const notify = deps.notifyProtectiveStopBlocked;
    if (!notify) throw new Error('the builder did not wire notifyProtectiveStopBlocked');

    await notify(blocked(true));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ category: 'order-failed', symbol: SYMBOL });
  });

  it('tells the operator NOT to tighten the stop on a ceiling breach, and quotes the ceiling', async () => {
    // Every remedy on the floor side makes a ceiling breach worse: a smaller stop
    // distance sits higher still. So the ceiling case carries the opposite
    // instruction, quotes the opposite bound, and names no setting at all.
    const { deps, events } = build();
    const notify = deps.notifyProtectiveStopBlocked;
    if (!notify) throw new Error('the builder did not wire notifyProtectiveStopBlocked');

    await notify(blocked(false, { bound: 'ceiling' }));

    const event = events[0] as { body: string; fields: { label: string; value: string }[] };
    expect(event.body).toContain('priced too HIGH for the range Binance accepts on this pair');
    expect(event.body).toContain('Do not tighten the stop to fix this');
    expect(event.body).not.toContain('trailingStopPct');
    expect(event.body).not.toContain('onBandBlock');
    expect(event.fields).toContainEqual({ label: 'Highest Binance allows', value: '200' });
    expect(event.fields).not.toContainEqual({ label: 'Lowest Binance allows', value: '90' });
    expect(event.fields.map((f) => f.label)).not.toContain('Widest Binance allows');
    // `1 - trigger / reference` is negative once the trigger clears the ceiling.
    // The field is dropped rather than rendered, so the operator is never asked
    // to act on "asking for -160%".
    expect(event.fields.map((f) => f.label)).not.toContain('Stop distance asked for');
  });

  it('quotes the same two stop distances the symbol screen shows, and names the same knobs', async () => {
    // The operator reads this on a phone and then opens the app. Two different
    // explanations of one refusal is worse than either alone, so both surfaces
    // render the strategy package's sentences rather than their own.
    const { deps, events } = build();
    const notify = deps.notifyProtectiveStopBlocked;
    if (!notify) throw new Error('the builder did not wire notifyProtectiveStopBlocked');

    await notify(blocked(false));

    const event = events[0] as { body: string; fields: { label: string; value: string }[] };
    const shared = explainProtectiveStopBandRefusal(blocked(false).detail);
    expect(event.body).toContain(shared.situation);
    expect(event.body).toContain(shared.remedy);
    expect(event.body).toContain('trailingStopPct');
    expect(event.body).toContain('sell.stopLossPercentage');
    expect(event.body).toContain('onBandBlock');
    expect(event.fields).toContainEqual({ label: 'Widest Binance allows', value: '8.16%' });
    expect(event.fields).toContainEqual({ label: 'Stop distance asked for', value: '8.76%' });
  });

  it('reports how long the refusal has held when the span is known', async () => {
    const { deps, events } = build();
    const notify = deps.notifyProtectiveStopBlocked;
    if (!notify) throw new Error('the builder did not wire notifyProtectiveStopBlocked');

    await notify(blocked(true, { sinceMs: Date.now() - 2 * 3_600_000 }));

    const event = events[0] as { fields: { label: string; value: string }[] };
    expect(event.fields).toContainEqual({ label: 'Blocked for', value: '2 hours' });
  });

  it('omits the duration field when no row could date the span', async () => {
    const { deps, events } = build();
    const notify = deps.notifyProtectiveStopBlocked;
    if (!notify) throw new Error('the builder did not wire notifyProtectiveStopBlocked');

    await notify(blocked(true));

    const event = events[0] as { fields: { label: string }[] };
    expect(event.fields.map((f) => f.label)).not.toContain('Blocked for');
  });
});
