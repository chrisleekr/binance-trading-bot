// CLAUDE.md: ownership is proven exactly once, by `scopeProfile`. The tick path
// proves it while building its context, so `applyAll` forwards that proof — and
// the config scalars the same tick already read — to the bindings resolver
// rather than letting it re-derive/re-read them. These tests pin the
// forwarding, the per-tick memoisation, and the guard that stops a scope proven
// for one profile (and its resolved config) from being reused for another.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { Decision, TickExecutorContext } from '@app/strategy-core';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import type { ProfileScope } from '@app/db';
import type { NotifyProviderRegistry } from '@app/notify';
import type { StrategyRegistry } from '@app/strategy-registry';

import {
  createLiveExecutor,
  type ProfileExecutorBindings,
} from '../../src/executor/live-executor.js';

const USER = asUserId('u-1');
const ACCOUNT = asAccountId('a-1');
const PROFILE = asProfileId('p-1');

const CTX: TickExecutorContext = {
  userId: USER,
  profileId: PROFILE,
  clock: { nowMs: () => 0 },
  strategyName: 'trailing-trade',
};

// A scope is nominal (module-private brand), so tests cast a structural stand-in.
// The executor only reads `accountId` / `profileId` off it and forwards the rest.
const scopeFor = (accountId: string, profileId: string): ProfileScope =>
  ({ accountId, profileId, db: {} }) as unknown as ProfileScope;

const bindings = (setKv = vi.fn(async () => undefined)): ProfileExecutorBindings =>
  ({ persistence: { setKv } }) as unknown as ProfileExecutorBindings;

const buildExecutor = (resolveProfile: ReturnType<typeof vi.fn>) =>
  createLiveExecutor({
    redis: {} as unknown as Redis,
    notifyRegistry: {} as unknown as NotifyProviderRegistry,
    strategies: {} as unknown as StrategyRegistry,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as Logger,
    resolveProfile: resolveProfile as never,
    notifierGapThrottle: { allow: async () => true, release: async () => undefined },
  });

const SET_KV: Decision = { type: 'set-kv', key: 'tt:regime', value: 1 };
const RESOLVED = { quoteAsset: 'USDT', weightLimit1m: 1200 };

describe('LiveExecutor.applyAll — ownership proof forwarding', () => {
  it('forwards the caller-proven scope and resolved config to the bindings resolver', async () => {
    const resolveProfile = vi.fn(async () => bindings());
    const scope = scopeFor(ACCOUNT, PROFILE);

    const applied = await buildExecutor(resolveProfile).applyAll(
      CTX,
      ACCOUNT,
      [SET_KV],
      scope,
      RESOLVED,
    );

    expect(applied[0]?.result).toEqual({ ok: true });
    expect(resolveProfile).toHaveBeenCalledOnce();
    expect(resolveProfile).toHaveBeenCalledWith(USER, ACCOUNT, PROFILE, scope, RESOLVED);
  });

  it('passes undefined for both when the caller has no proof, so the resolver proves + reads', async () => {
    const resolveProfile = vi.fn(async () => bindings());

    await buildExecutor(resolveProfile).applyAll(CTX, ACCOUNT, [SET_KV]);

    expect(resolveProfile).toHaveBeenCalledWith(USER, ACCOUNT, PROFILE, undefined, undefined);
  });

  it('resolves the profile once across several decisions in one tick', async () => {
    const resolveProfile = vi.fn(async () => bindings());
    const scope = scopeFor(ACCOUNT, PROFILE);

    await buildExecutor(resolveProfile).applyAll(
      CTX,
      ACCOUNT,
      [SET_KV, { type: 'set-kv', key: 'tt:other', value: 2 }],
      scope,
    );

    expect(resolveProfile).toHaveBeenCalledOnce();
  });

  it('refuses to reuse a scope proven for a different profile, dropping its resolved config too', async () => {
    const resolveProfile = vi.fn(async () => bindings());
    // Proof (and the config scalars) belong to another profile: the executor
    // must hand over neither, or the current profile would resolve with the
    // wrong quoteAsset/weightLimit.
    const foreign = scopeFor(ACCOUNT, 'p-other');

    await buildExecutor(resolveProfile).applyAll(CTX, ACCOUNT, [SET_KV], foreign, RESOLVED);

    expect(resolveProfile).toHaveBeenCalledWith(USER, ACCOUNT, PROFILE, undefined, undefined);
  });
});
