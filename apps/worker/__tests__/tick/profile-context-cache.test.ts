// Pin the cross-tick profile-context cache: a hit within the TTL skips the
// builder (the ~3-PG-read cost the cache exists to remove), a reconfigure
// eviction forces a rebuild, the TTL backstop expires a stale entry, and a
// null build result is never cached so a re-created profile resolves fresh.

import { describe, expect, it, vi } from 'vitest';
import type { AccountId, ProfileId } from '@app/contracts';

import {
  createProfileContextCache,
  PROFILE_CONTEXT_CACHE_TTL_MS,
} from '../../src/tick/profile-context-cache.js';
import type { ProfileTickContext } from '../../src/tick/build-tick-input.js';

const ACCOUNT = 'a-1' as AccountId;
const PROFILE = 'p-1' as ProfileId;

// The cache stores the context opaquely; a tagged stub is enough to assert
// identity without constructing a real ProfileTickContext.
const ctxStub = (tag: string) => ({ tag }) as unknown as ProfileTickContext;

const makeClock = (start = 1_000) => {
  let now = start;
  return { nowMs: () => now, advance: (ms: number) => (now += ms) };
};

describe('createProfileContextCache', () => {
  it('builds once then serves the cached context within the TTL', async () => {
    const clock = makeClock();
    const cache = createProfileContextCache({ nowMs: clock.nowMs });
    const ctx = ctxStub('a');
    const build = vi.fn().mockResolvedValue(ctx);

    const first = await cache.resolve(ACCOUNT, PROFILE, 'BTCUSDT', build);
    clock.advance(PROFILE_CONTEXT_CACHE_TTL_MS - 1);
    const second = await cache.resolve(ACCOUNT, PROFILE, 'BTCUSDT', build);

    expect(first).toBe(ctx);
    expect(second).toBe(ctx);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('rebuilds after the TTL elapses', async () => {
    const clock = makeClock();
    const cache = createProfileContextCache({ nowMs: clock.nowMs });
    const build = vi.fn().mockResolvedValueOnce(ctxStub('a')).mockResolvedValueOnce(ctxStub('b'));

    await cache.resolve(ACCOUNT, PROFILE, 'BTCUSDT', build);
    clock.advance(PROFILE_CONTEXT_CACHE_TTL_MS);
    await cache.resolve(ACCOUNT, PROFILE, 'BTCUSDT', build);

    expect(build).toHaveBeenCalledTimes(2);
  });

  it('evictProfile drops every symbol entry for that profile, forcing a rebuild', async () => {
    const clock = makeClock();
    const cache = createProfileContextCache({ nowMs: clock.nowMs });
    const build = vi.fn().mockResolvedValue(ctxStub('a'));

    await cache.resolve(ACCOUNT, PROFILE, 'BTCUSDT', build);
    await cache.resolve(ACCOUNT, PROFILE, 'ETHUSDT', build);
    expect(build).toHaveBeenCalledTimes(2); // distinct symbols → distinct keys

    cache.evictProfile(PROFILE);

    await cache.resolve(ACCOUNT, PROFILE, 'BTCUSDT', build);
    await cache.resolve(ACCOUNT, PROFILE, 'ETHUSDT', build);
    expect(build).toHaveBeenCalledTimes(4); // both rebuilt after eviction
  });

  it('does not cache a null build result', async () => {
    const clock = makeClock();
    const cache = createProfileContextCache({ nowMs: clock.nowMs });
    const build = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(ctxStub('a'));

    const first = await cache.resolve(ACCOUNT, PROFILE, 'BTCUSDT', build);
    const second = await cache.resolve(ACCOUNT, PROFILE, 'BTCUSDT', build);

    expect(first).toBeNull();
    expect(second).not.toBeNull();
    expect(build).toHaveBeenCalledTimes(2); // null was a miss, so it rebuilt
  });

  it('honours a caller-supplied ttlMs override', async () => {
    const clock = makeClock();
    const cache = createProfileContextCache({ nowMs: clock.nowMs, ttlMs: 5_000 });
    const build = vi.fn().mockResolvedValue(ctxStub('a'));

    await cache.resolve(ACCOUNT, PROFILE, 'BTCUSDT', build);
    clock.advance(5_000);
    await cache.resolve(ACCOUNT, PROFILE, 'BTCUSDT', build);

    expect(build).toHaveBeenCalledTimes(2);
  });
});
