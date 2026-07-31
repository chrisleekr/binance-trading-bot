// Cross-tick cache for the resolved profile context. `buildProfileTickContext`
// does ~3 Postgres reads (the scopeProfile ownership SELECT, profile.findById,
// profileSymbols.findForSymbol) on EVERY tick (~1/sec/symbol), re-reading data
// that only changes on an operator edit. The worker is single-replica
// (CLAUDE.md), so an in-process cache is correct.
//
// Invalidation: every operator path that changes a profile's config or symbol
// set already enqueues a `reconfigure-profile` job; that handler evicts the
// profile's entries here, so a config edit is visible on the next tick. The TTL
// backstop bounds any path that forgets to evict to at-most-TTL staleness, never
// permanence. The per-(profile, symbol) `symbol_states` read + UPSERT (the
// crash-only reconcile spine) is a SEPARATE tick path and stays uncached.

import type { AccountId, ProfileId } from '@app/contracts';

import type { ProfileTickContext } from 'tick/build-tick-input.js';

/** Staleness ceiling on a cached context if a `reconfigure-profile` eviction is
 *  ever missed. Short by design: the eviction is the real freshness mechanism. */
export const PROFILE_CONTEXT_CACHE_TTL_MS = 30_000;

export interface ProfileContextCache {
  /** Return the cached context for (accountId, profileId, symbol) when fresh,
   *  else build it, cache a non-null result, and return it. */
  resolve(
    accountId: AccountId,
    profileId: ProfileId,
    symbol: string,
    build: () => Promise<ProfileTickContext | null>,
  ): Promise<ProfileTickContext | null>;
  /** Drop every cached symbol entry for a profile (on a reconfigure). */
  evictProfile(profileId: ProfileId): void;
}

interface Entry {
  readonly ctx: ProfileTickContext;
  readonly cachedAtMs: number;
}

export const createProfileContextCache = (opts: {
  readonly nowMs: () => number;
  readonly ttlMs?: number;
}): ProfileContextCache => {
  const ttlMs = opts.ttlMs ?? PROFILE_CONTEXT_CACHE_TTL_MS;
  const cache = new Map<string, Entry>();
  const keyOf = (accountId: AccountId, profileId: ProfileId, symbol: string): string =>
    `${accountId}:${profileId}:${symbol}`;

  return {
    async resolve(accountId, profileId, symbol, build) {
      const key = keyOf(accountId, profileId, symbol);
      const hit = cache.get(key);
      if (hit !== undefined && opts.nowMs() - hit.cachedAtMs < ttlMs) return hit.ctx;
      const ctx = await build();
      // Only cache a real context; a null (profile gone / not owned) stays a
      // miss so a re-created profile resolves fresh without waiting out the TTL.
      if (ctx !== null) cache.set(key, { ctx, cachedAtMs: opts.nowMs() });
      return ctx;
    },
    evictProfile(profileId) {
      const needle = `:${profileId}:`;
      for (const key of cache.keys()) {
        if (key.includes(needle)) cache.delete(key);
      }
    },
  };
};
