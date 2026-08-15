import { describe, expect, it, vi } from 'vitest';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';

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

/**
 * `bound` and `sinceMs` are overridable because they select whole branches of
 * the message, not just wording: the ceiling body carries the OPPOSITE
 * instruction to the floor one, and a known span adds a field.
 */
const blocked = (
  terminal: boolean,
  overrides: { readonly bound?: string; readonly sinceMs?: number | null } = {},
) => ({
  operatorId: OPERATOR,
  accountId: ACCOUNT,
  profileId: PROFILE,
  symbol: SYMBOL,
  reason: 'price-outside-exchange-band',
  detail: {
    stopPrice: '11.5',
    floor: '11.43',
    ceiling: '25.4',
    bound: overrides.bound ?? 'floor',
  },
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

  it('tells the operator NOT to widen the offset on a ceiling breach, and quotes the ceiling', async () => {
    // The floor copy says "widen the stop offset". Applied to a stop priced
    // ABOVE the band that pushes it further out of range, so the ceiling case
    // carries the opposite instruction and quotes the opposite bound.
    const { deps, events } = build();
    const notify = deps.notifyProtectiveStopBlocked;
    if (!notify) throw new Error('the builder did not wire notifyProtectiveStopBlocked');

    await notify(blocked(false, { bound: 'ceiling' }));

    const event = events[0] as { body: string; fields: { label: string; value: string }[] };
    expect(event.body).toContain('priced too HIGH for the range Binance accepts right now');
    expect(event.body).toContain(
      'do NOT widen the stop offset, that moves it further out of range',
    );
    expect(event.fields).toContainEqual({ label: 'Highest Binance allows', value: '25.4' });
    expect(event.fields).not.toContainEqual({ label: 'Lowest Binance allows', value: '11.43' });
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
