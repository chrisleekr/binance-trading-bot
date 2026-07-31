// Locks the per-symbol override merge in buildProfileTickContext: the
// no-override path must hand the strategy the profile config byte-for-byte
// (reference-equal), and a stored override must be deep-merged onto it.

import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import type { AccountId, ProfileId, UserId } from '@app/contracts';

// Binance mode is per-account now: the context reads it via
// `repo.accounts.binanceModeById`, so the full mock must expose that member
// (a null mode folds into the "no context" branch the ownership check uses).
vi.mock('@app/db', () => ({
  ProfileNotOwnedError: class ProfileNotOwnedError extends Error {},
  profileRepo: vi.fn(),
  repo: { accounts: { binanceModeById: vi.fn().mockResolvedValue('test') } },
}));

import { profileRepo } from '@app/db';
import { buildProfileTickContext } from '../../src/profile-bindings/tick-context.js';

const userId = 'u-1' as UserId;
const accountId = 'a-1' as AccountId;
const profileId = 'p-1' as ProfileId;
const profileConfig = {
  symbol: 'BTCUSDT',
  candleInterval: '1h',
  buy: { enabled: true, maxPurchaseAmount: '10' },
  sell: { enabled: true },
};

const stubRepo = (overrideConfig: unknown): unknown => ({
  // The proven scope `profileRepo` carries; buildProfileTickContext exposes
  // it so the tick threads one ownership proof into the StatePort (#397).
  scope: { operatorId: userId, accountId, profileId },
  profile: {
    findById: vi.fn().mockResolvedValue({
      config: profileConfig,
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      binanceMode: 'test',
      quoteAsset: 'USDT',
    }),
  },
  profileSymbols: {
    findForSymbol: vi
      .fn()
      .mockResolvedValue(
        overrideConfig === undefined ? null : { symbol: 'BTCUSDT', overrideConfig },
      ),
  },
});

const deps = { db: {}, bundleProvider: {} } as unknown as Parameters<
  typeof buildProfileTickContext
>[0];

beforeEach(() => {
  (profileRepo as Mock).mockReset();
});

describe('buildProfileTickContext — per-symbol override merge', () => {
  it('hands the profile config through unchanged when no override row exists', async () => {
    (profileRepo as Mock).mockResolvedValue(stubRepo(undefined));
    const ctx = await buildProfileTickContext(deps, userId, accountId, profileId, 'BTCUSDT');
    expect(ctx?.config).toBe(profileConfig);
  });

  it('exposes the resolved scope so the tick reuses one ownership proof (#397)', async () => {
    const repo = stubRepo(undefined) as { scope: unknown };
    (profileRepo as Mock).mockResolvedValue(repo);
    const ctx = await buildProfileTickContext(deps, userId, accountId, profileId, 'BTCUSDT');
    // The exact scope object the single `profileRepo` call produced — no
    // second resolution downstream.
    expect(ctx?.scope).toBe(repo.scope);
  });

  it('hands the profile config through unchanged when the override is null', async () => {
    (profileRepo as Mock).mockResolvedValue(stubRepo(null));
    const ctx = await buildProfileTickContext(deps, userId, accountId, profileId, 'BTCUSDT');
    expect(ctx?.config).toBe(profileConfig);
  });

  it('deep-merges a stored override onto the profile config', async () => {
    (profileRepo as Mock).mockResolvedValue(stubRepo({ buy: { maxPurchaseAmount: '99' } }));
    const ctx = await buildProfileTickContext(deps, userId, accountId, profileId, 'BTCUSDT');
    expect(ctx?.config).toEqual({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      buy: { enabled: true, maxPurchaseAmount: '99' },
      sell: { enabled: true },
    });
    // The merge is non-mutating: the profile config object is untouched.
    expect(profileConfig.buy.maxPurchaseAmount).toBe('10');
  });

  it('falls back to the built-in TV defaults when the profile config omits technicals', async () => {
    (profileRepo as Mock).mockResolvedValue(stubRepo(undefined));
    const ctx = await buildProfileTickContext(deps, userId, accountId, profileId, 'BTCUSDT');
    // Built-in defaults: 5m freshness, do-not-buy on expiry, one 1m interval
    // matching the pre-multi-interval gate behaviour.
    expect(ctx?.technicalsConfig).toEqual({
      useOnlyWithinMin: 5,
      ifExpires: 'do-not-buy',
      entryConfirmReads: 1,
      intervals: [
        {
          interval: '1m',
          whenStrongBuy: true,
          whenBuy: true,
          whenSell: false,
          whenStrongSell: false,
          whenNeutral: false,
          mode: 'block',
        },
      ],
    });
  });

  it('issues the profile and symbol reads concurrently, not serially', async () => {
    // findById resolves only once findForSymbol has begun. Under the parallel
    // pair both are dispatched, so this converges; if the reads regress to
    // serial (findById awaited before findForSymbol starts) it deadlocks and
    // the 1s timeout fails the test.
    // Assigned synchronously by the Promise executor before construction returns.
    let markSymbolStarted!: () => void;
    const symbolStarted = new Promise<void>((resolve) => {
      markSymbolStarted = resolve;
    });
    (profileRepo as Mock).mockResolvedValue({
      profile: {
        findById: vi.fn().mockImplementation(async () => {
          await symbolStarted;
          return {
            config: profileConfig,
            strategyName: 'trailing-trade',
            strategyVersion: '2.0.0',
            binanceMode: 'test',
          };
        }),
      },
      profileSymbols: {
        findForSymbol: vi.fn().mockImplementation(async () => {
          markSymbolStarted();
          return null;
        }),
      },
    });
    const ctx = await buildProfileTickContext(deps, userId, accountId, profileId, 'BTCUSDT');
    expect(ctx?.config).toBe(profileConfig);
  }, 1000);

  it('flags needsAccountDeployedQuote false when the account cap is unset, 0, empty, or non-string', async () => {
    // Includes non-string inputs (a number, null) to cover the helper's
    // `typeof raw === 'string'` guard against a corrupted/hand-edited stored
    // config; the schema normally keeps this field a string.
    for (const accountCap of [
      undefined,
      { mode: 'off' },
      { mode: 'amount', amount: '0' },
      { mode: 'amount', amount: '' },
      { mode: 'percent', percent: '0' },
    ]) {
      (profileRepo as Mock).mockResolvedValue({
        profile: {
          findById: vi.fn().mockResolvedValue({
            config: { ...profileConfig, buy: { ...profileConfig.buy, accountCap } },
            strategyName: 'trailing-trade',
            strategyVersion: '2.0.0',
            binanceMode: 'test',
          }),
        },
        profileSymbols: { findForSymbol: vi.fn().mockResolvedValue(null) },
      });
      const ctx = await buildProfileTickContext(deps, userId, accountId, profileId, 'BTCUSDT');
      expect(ctx?.needsAccountDeployedQuote).toBe(false);
    }
  });

  it('flags needsAccountDeployedQuote true when the account cap is armed', async () => {
    (profileRepo as Mock).mockResolvedValue({
      profile: {
        findById: vi.fn().mockResolvedValue({
          config: {
            ...profileConfig,
            buy: { ...profileConfig.buy, accountCap: { mode: 'amount', amount: '5000' } },
          },
          strategyName: 'trailing-trade',
          strategyVersion: '2.0.0',
          binanceMode: 'test',
        }),
      },
      profileSymbols: { findForSymbol: vi.fn().mockResolvedValue(null) },
    });
    const ctx = await buildProfileTickContext(deps, userId, accountId, profileId, 'BTCUSDT');
    expect(ctx?.needsAccountDeployedQuote).toBe(true);
  });

  it('flags needsAccountDeployedQuote true for percent-of-account entry sizing (cap off)', async () => {
    // Percent entry sizing needs equity (= cash + deployed) even with no cap.
    (profileRepo as Mock).mockResolvedValue({
      profile: {
        findById: vi.fn().mockResolvedValue({
          config: {
            ...profileConfig,
            buy: {
              ...profileConfig.buy,
              entrySizing: { mode: 'percentOfAccount', percent: '0.1' },
            },
          },
          strategyName: 'trailing-trade',
          strategyVersion: '2.0.0',
          binanceMode: 'test',
        }),
      },
      profileSymbols: { findForSymbol: vi.fn().mockResolvedValue(null) },
    });
    const ctx = await buildProfileTickContext(deps, userId, accountId, profileId, 'BTCUSDT');
    expect(ctx?.needsAccountDeployedQuote).toBe(true);
  });

  it('reads operator-configured technicals freshness from the profile config', async () => {
    (profileRepo as Mock).mockResolvedValue({
      profile: {
        findById: vi.fn().mockResolvedValue({
          config: {
            ...profileConfig,
            technicals: {
              useOnlyWithinMin: 5,
              ifExpires: 'allow-anyway',
              intervals: [
                {
                  interval: '15m',
                  whenStrongBuy: true,
                  whenBuy: false,
                  whenSell: false,
                  whenStrongSell: true,
                  whenNeutral: false,
                },
              ],
            },
          },
          strategyName: 'trailing-trade',
          strategyVersion: '2.0.0',
          binanceMode: 'test',
        }),
      },
      profileSymbols: { findForSymbol: vi.fn().mockResolvedValue(null) },
    });
    const ctx = await buildProfileTickContext(deps, userId, accountId, profileId, 'BTCUSDT');
    expect(ctx?.technicalsConfig).toEqual({
      useOnlyWithinMin: 5,
      ifExpires: 'allow-anyway',
      entryConfirmReads: 1,
      intervals: [
        {
          interval: '15m',
          whenStrongBuy: true,
          whenBuy: false,
          whenSell: false,
          whenStrongSell: true,
          whenNeutral: false,
          mode: 'block',
        },
      ],
    });
  });
});
