import { asProfileId, asUserId } from '@app/contracts';
import { GLOBAL_KEYS, profileKey, type ProfileRepo } from '@app/db';
import type { AnyStrategy } from '@app/strategy-core';
import { TTConfigSchema, trailingTrade } from '@app/strategy-trailing-trade';
import { describe, expect, it } from 'vitest';

import type { DI } from '../../src/di.js';
import {
  assertOrderFeasible,
  assertOrderFeasibleForProfile,
  orderFeasibilityDiagnostics,
  withDiagnostics,
} from '../../src/lib/order-feasibility.js';

const U = asUserId('00000000-0000-0000-0000-000000000001');
const P = asProfileId('00000000-0000-0000-0000-000000000002');

const SYM_KEY = GLOBAL_KEYS.symbolInfo('BTCUSDT');
const TICKER_KEY = GLOBAL_KEYS.ticker('BTCUSDT');

const symbolInfo = JSON.stringify({
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minNotional: '10',
    tickSize: '0.01',
    stepSize: '0.0001',
    minQty: '0.001',
    maxQty: '9000',
    minPrice: '0.01',
    maxPrice: '1000000',
  },
});
const ticker = JSON.stringify({ price: '100', ts: 1 });

const makeDi = (store: Record<string, string>): DI =>
  ({
    redis: { raw: () => ({ get: async (key: string) => store[key] ?? null }) },
    strategies: {
      describeForProfile: (name: string) =>
        name === 'trailing-trade'
          ? { status: 'current', strategy: trailingTrade }
          : { status: 'unknown', name },
    },
  }) as unknown as DI;

interface Ledger {
  symbol: string;
  avgEntryPrice: string;
  quantity: string;
}

const fakeP = (symbols: string[], ledger: Ledger[] = []): ProfileRepo =>
  ({
    scope: { userId: U, profileId: P },
    profileSymbols: { listForProfile: async () => symbols.map((symbol) => ({ symbol })) },
    avgEntryPrices: {
      findBySymbols: async (syms: readonly string[]) =>
        ledger.filter((l) => syms.includes(l.symbol)),
    },
  }) as unknown as ProfileRepo;

const cfg = (over: Record<string, unknown>): unknown =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '20' }, ...over },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
  });

// A 3-level grid of 20 quote each: total 60. Level 0 trigger must be 1, deeper <1.
const gridConfig = cfg({
  gridLevels: [
    { triggerPercentage: '1', maxPurchaseAmount: '20' },
    { triggerPercentage: '0.97', maxPurchaseAmount: '20' },
    { triggerPercentage: '0.95', maxPurchaseAmount: '20' },
  ],
});
// A single fixed entry sized below minNotional (5 < 10) — balance-independent block.
const subMinConfig = cfg({ entrySizing: { mode: 'fixed', amount: '5' } });

const LIVE = { [SYM_KEY]: symbolInfo, [TICKER_KEY]: ticker };

// A store where ONLY the testnet symbol-info keyspace is populated. A live-mode
// read misses it entirely (symbol reported as unchecked); a test-mode read must
// reach it.
const TEST_SYM_KEY = GLOBAL_KEYS.symbolInfo('BTCUSDT', 'test');
const TEST_ONLY = { [TEST_SYM_KEY]: symbolInfo, [TICKER_KEY]: ticker };

const ACCOUNT_KEY = profileKey({ userId: U, profileId: P }, 'accountInfo');
// Balances snapshot: `free`/`locked` per asset, as the worker writes it.
const account = (balances: Record<string, { free: string; locked: string }>): string =>
  JSON.stringify({ balances });

describe('orderFeasibilityDiagnostics', () => {
  it('does NOT run the full-grid funding check on the live path (no override)', async () => {
    // Grid totals 60; without a clean starting balance the funding check must not
    // fire, so a running/invested profile can still be checked without a false block.
    expect(
      await orderFeasibilityDiagnostics(
        makeDi(LIVE),
        fakeP(['BTCUSDT']),
        trailingTrade,
        gridConfig,
        { mode: 'live' },
      ),
    ).toEqual([]);
  });

  it('still enforces per-order minimums on the live path', async () => {
    const diags = await orderFeasibilityDiagnostics(
      makeDi(LIVE),
      fakeP(['BTCUSDT']),
      trailingTrade,
      subMinConfig,
      { mode: 'live' },
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ level: 'block', code: 'order-below-min-notional' });
    expect(diags[0]?.message).toMatch(/^BTCUSDT: /);
  });

  it('runs the funding check against availableQuoteOverride (backtest balance)', async () => {
    const diags = await orderFeasibilityDiagnostics(
      makeDi(LIVE),
      fakeP([]),
      trailingTrade,
      gridConfig,
      {
        symbols: ['BTCUSDT'],
        availableQuoteOverride: '50',
        mode: 'live',
      },
    );
    expect(diags.map((d) => d.code)).toEqual(['grid-underfunded']);
    expect(diags[0]?.message).toContain('2 of 3');
  });

  it('is clean when the override funds the full grid', async () => {
    const diags = await orderFeasibilityDiagnostics(
      makeDi(LIVE),
      fakeP(['BTCUSDT']),
      trailingTrade,
      gridConfig,
      {
        availableQuoteOverride: '100000',
      },
    );
    expect(diags).toEqual([]);
  });

  it('reports a symbol with no filters or price snapshot as unchecked, not clean', async () => {
    // An empty result is read downstream as "checked and fine" and admits the
    // save with zero validation behind it, so "could not check" must be visible.
    const diags = await orderFeasibilityDiagnostics(
      makeDi({}),
      fakeP(['BTCUSDT']),
      trailingTrade,
      gridConfig,
      { mode: 'live' },
    );
    // With BOTH halves missing the filters guard wins: one unreadable symbol
    // yields one finding, not two overlapping ones. Pins the guard ordering.
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ level: 'warn', code: 'filters-unavailable' });
  });

  it('names the symbol, the mode, and the unverified sizing when filters are missing', async () => {
    const diags = await orderFeasibilityDiagnostics(
      makeDi({ [TICKER_KEY]: ticker }),
      fakeP(['BTCUSDT']),
      trailingTrade,
      gridConfig,
      { mode: 'live' },
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ level: 'warn', code: 'filters-unavailable' });
    // The operator has to be able to tell WHICH symbol on WHICH exchange went
    // unchecked; a bare code cannot be acted on.
    expect(diags[0]?.message).toMatch(/^BTCUSDT: /);
    expect(diags[0]?.message).toMatch(/\bLive\b/);
    expect(diags[0]?.message).toMatch(/not verified/i);
  });

  it('reports filters-unavailable when the symbol-info snapshot is not JSON', async () => {
    const diags = await orderFeasibilityDiagnostics(
      makeDi({ [SYM_KEY]: 'not json', [TICKER_KEY]: ticker }),
      fakeP(['BTCUSDT']),
      trailingTrade,
      gridConfig,
      { mode: 'live' },
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ level: 'warn', code: 'filters-unavailable' });
  });

  it('reports filters-unavailable when the symbol-info snapshot has drifted', async () => {
    // Valid JSON, but the filters block the sizing check reads is gone — the
    // config is just as unchecked as if the key were absent.
    const diags = await orderFeasibilityDiagnostics(
      makeDi({ [SYM_KEY]: JSON.stringify({ quoteAsset: 'USDT' }), [TICKER_KEY]: ticker }),
      fakeP(['BTCUSDT']),
      trailingTrade,
      gridConfig,
      { mode: 'live' },
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ level: 'warn', code: 'filters-unavailable' });
  });

  it('reports price-unavailable when filters are readable but no price snapshot is', async () => {
    // Read through the testnet keyspace so the message must name the testnet
    // environment — a message hardcoded to "Live" would mislead here.
    const diags = await orderFeasibilityDiagnostics(
      makeDi({ [TEST_SYM_KEY]: symbolInfo }),
      fakeP(['BTCUSDT']),
      trailingTrade,
      gridConfig,
      { mode: 'test' },
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ level: 'warn', code: 'price-unavailable' });
    expect(diags[0]?.message).toMatch(/^BTCUSDT: /);
    expect(diags[0]?.message).toMatch(/\bTestnet\b/);
    expect(diags[0]?.message).not.toMatch(/\bLive\b/);
    expect(diags[0]?.message).toMatch(/not verified/i);
  });

  it('reports price-unavailable when the price snapshot is not JSON', async () => {
    const diags = await orderFeasibilityDiagnostics(
      makeDi({ [SYM_KEY]: symbolInfo, [TICKER_KEY]: 'not json' }),
      fakeP(['BTCUSDT']),
      trailingTrade,
      gridConfig,
      { mode: 'live' },
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ level: 'warn', code: 'price-unavailable' });
  });

  it('still checks the symbols it can read in a partly populated basket', async () => {
    // Only BTCUSDT has snapshots. ETHUSDT must be reported as unchecked without
    // costing the block that the readable symbol earns.
    const diags = await orderFeasibilityDiagnostics(
      makeDi(LIVE),
      fakeP(['BTCUSDT', 'ETHUSDT']),
      trailingTrade,
      subMinConfig,
      { mode: 'live' },
    );
    expect(diags).toContainEqual(
      expect.objectContaining({ level: 'block', code: 'order-below-min-notional' }),
    );
    const unavailable = diags.filter((d) => d.code === 'filters-unavailable');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]?.message).toMatch(/^ETHUSDT: /);
  });

  it('reports nothing unavailable when both snapshots are readable', async () => {
    const codes = (
      await orderFeasibilityDiagnostics(
        makeDi(LIVE),
        fakeP(['BTCUSDT']),
        trailingTrade,
        gridConfig,
        { mode: 'live' },
      )
    ).map((d) => d.code);
    expect(codes).not.toContain('filters-unavailable');
    expect(codes).not.toContain('price-unavailable');
  });

  it('reports nothing for a strategy without an order-feasibility check', async () => {
    // Nothing was skipped — there was nothing to check — so an empty keyspace
    // must not manufacture an unavailable warning.
    const noCheck = {
      ...trailingTrade,
      checkOrderFeasibility: undefined,
    } as unknown as AnyStrategy;
    expect(
      await orderFeasibilityDiagnostics(makeDi({}), fakeP(['BTCUSDT']), noCheck, gridConfig, {
        mode: 'live',
      }),
    ).toEqual([]);
  });

  it('reports nothing when the profile has no bound symbols', async () => {
    expect(
      await orderFeasibilityDiagnostics(makeDi({}), fakeP([]), trailingTrade, gridConfig, {
        mode: 'live',
      }),
    ).toEqual([]);
  });

  it('reads the test-mode symbol-info keyspace when mode is test', async () => {
    // Only the testnet keyspace holds filters. A live-default read would miss it
    // and report the symbol as unchecked; passing mode:'test' must reach the test
    // key and enforce the per-order minimum — proving the filters come from
    // testnet, not production.
    const diags = await orderFeasibilityDiagnostics(
      makeDi(TEST_ONLY),
      fakeP(['BTCUSDT']),
      trailingTrade,
      subMinConfig,
      { mode: 'test' },
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ level: 'block', code: 'order-below-min-notional' });
  });

  it('does not read the test keyspace on the default (live) path', async () => {
    // Same testnet-only store, but a live-mode check must not find the test key →
    // the symbol goes unchecked and is reported as such. Pins the keyspace
    // isolation: reaching the test key would have produced the sub-minimum
    // block, so its ABSENCE is what proves the live path never read it.
    const diags = await orderFeasibilityDiagnostics(
      makeDi(TEST_ONLY),
      fakeP(['BTCUSDT']),
      trailingTrade,
      subMinConfig,
      { mode: 'live' },
    );
    expect(diags.map((d) => d.code)).not.toContain('order-below-min-notional');
    expect(diags.map((d) => d.code)).toEqual(['filters-unavailable']);
  });

  it('funds the grid from account value: deployed cost basis covers a low free quote', async () => {
    // Grid needs 60. Free USDT is only 10 (a free-quote-only check would block),
    // but the ledger shows 0.5 base bought at 100 = 50 of committed capital.
    // Valued at COST BASIS (not the live mark), 10 + 50 = 60 → OK — and it stays
    // OK through a drawdown because cost basis does not move with price.
    const store = { ...LIVE, [ACCOUNT_KEY]: account({ USDT: { free: '10', locked: '0' } }) };
    expect(
      await orderFeasibilityDiagnostics(
        makeDi(store),
        fakeP(['BTCUSDT'], [{ symbol: 'BTCUSDT', avgEntryPrice: '100', quantity: '0.5' }]),
        trailingTrade,
        gridConfig,
        { fundFromAccountValue: true, mode: 'live' },
      ),
    ).toEqual([]);
  });

  it('counts locked quote toward account value', async () => {
    // Free USDT 10 + locked USDT 50 = 60, no position → funds the 60 grid. Pins
    // the `+ locked` term so a regression dropping it would fail here.
    const store = { ...LIVE, [ACCOUNT_KEY]: account({ USDT: { free: '10', locked: '50' } }) };
    expect(
      await orderFeasibilityDiagnostics(
        makeDi(store),
        fakeP(['BTCUSDT']),
        trailingTrade,
        gridConfig,
        {
          fundFromAccountValue: true,
          mode: 'live',
        },
      ),
    ).toEqual([]);
  });

  it('blocks when account value cannot fund the full grid', async () => {
    // Free USDT 10, no deployed position → value 10, funds 0 of 3 levels of 20.
    const store = { ...LIVE, [ACCOUNT_KEY]: account({ USDT: { free: '10', locked: '0' } }) };
    const diags = await orderFeasibilityDiagnostics(
      makeDi(store),
      fakeP(['BTCUSDT']),
      trailingTrade,
      gridConfig,
      { fundFromAccountValue: true, mode: 'live' },
    );
    expect(diags.map((d) => d.code)).toEqual(['grid-underfunded']);
    expect(diags[0]?.message).toContain('0 of 3');
  });

  it('lets availableQuoteOverride win over fundFromAccountValue when both are set', async () => {
    // Backtest override (clean balance) must take precedence over live account
    // value — an underfunded live snapshot is ignored when an override is given.
    const store = { ...LIVE, [ACCOUNT_KEY]: account({ USDT: { free: '1', locked: '0' } }) };
    expect(
      await orderFeasibilityDiagnostics(
        makeDi(store),
        fakeP(['BTCUSDT']),
        trailingTrade,
        gridConfig,
        {
          fundFromAccountValue: true,
          availableQuoteOverride: '100000',
          mode: 'live',
        },
      ),
    ).toEqual([]);
  });

  it('skips the funding check when fundFromAccountValue is set but no snapshot exists', async () => {
    // A profile never enabled has no account-info key: fund check is skipped for
    // lack of data (per-order minimums still run), so no false block.
    expect(
      await orderFeasibilityDiagnostics(
        makeDi(LIVE),
        fakeP(['BTCUSDT']),
        trailingTrade,
        gridConfig,
        {
          fundFromAccountValue: true,
          mode: 'live',
        },
      ),
    ).toEqual([]);
  });

  it('skips the funding check when a balance amount is malformed', async () => {
    // A present-but-drifted snapshot (schema-valid string, non-numeric amount)
    // must skip funding rather than throw or false-block.
    const store = {
      ...LIVE,
      [ACCOUNT_KEY]: account({ USDT: { free: 'not-a-number', locked: '0' } }),
    };
    expect(
      await orderFeasibilityDiagnostics(
        makeDi(store),
        fakeP(['BTCUSDT']),
        trailingTrade,
        gridConfig,
        {
          fundFromAccountValue: true,
          mode: 'live',
        },
      ),
    ).toEqual([]);
  });

  it('funds from cost basis alone when the quote asset is absent (free quote spent to zero)', async () => {
    // The motivating case: Binance omits a zero-balance asset, so the snapshot
    // has no USDT entry. The deployed cost basis (0.5 @ 120 = 60) alone funds the
    // 60 grid → no block. Pins the quote-asset-absent fallback to 0.
    const store = { ...LIVE, [ACCOUNT_KEY]: account({}) };
    expect(
      await orderFeasibilityDiagnostics(
        makeDi(store),
        fakeP(['BTCUSDT'], [{ symbol: 'BTCUSDT', avgEntryPrice: '120', quantity: '0.5' }]),
        trailingTrade,
        gridConfig,
        { fundFromAccountValue: true, mode: 'live' },
      ),
    ).toEqual([]);
  });

  it('skips the funding check when a ledger amount is malformed', async () => {
    // A drifted ledger row (non-numeric amount) throws inside the cost-basis
    // multiply; it must be caught and skip funding, not throw or false-block.
    const store = { ...LIVE, [ACCOUNT_KEY]: account({ USDT: { free: '10', locked: '0' } }) };
    expect(
      await orderFeasibilityDiagnostics(
        makeDi(store),
        fakeP(['BTCUSDT'], [{ symbol: 'BTCUSDT', avgEntryPrice: 'oops', quantity: '0.5' }]),
        trailingTrade,
        gridConfig,
        { fundFromAccountValue: true, mode: 'live' },
      ),
    ).toEqual([]);
  });
});

// A symbol whose snapshot carries Binance's price band, plus a config whose
// backup stop is deeper than that band will hold: 15% against a maximum of
// 1 − 0.95 ÷ 0.995 ≈ 4.52%.
const BAND_SYM_KEY = GLOBAL_KEYS.symbolInfo('ETHUSDT');
const bandSymbolInfo = JSON.stringify({
  ...JSON.parse(symbolInfo),
  symbol: 'ETHUSDT',
  filters: {
    ...JSON.parse(symbolInfo).filters,
    percentPriceBySide: {
      bidMultiplierUp: '1.1',
      bidMultiplierDown: '0.5',
      askMultiplierUp: '2',
      askMultiplierDown: '0.95',
      avgPriceMins: 5,
    },
  },
});
// Parsed here rather than through `cfg`, which spreads its overrides into `buy`.
const sellCfg = (sell: Record<string, unknown>): unknown =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '20' } },
    sell: { enabled: true, triggerPercentage: '1.05', ...sell },
  });
const deepStopConfig = sellCfg({
  stopLossPercentage: '0.85',
  protectiveStop: { enabled: true, limitOffsetPercentage: '0.995' },
});

describe('protective-stop price band, checked at bind time', () => {
  it('warns without blocking when the stop is deeper than the band holds', async () => {
    // The whole point of the check: the operator hears it while binding the
    // symbol, not from the first tick that could not arm a stop over an open
    // position. Host-minted, so it rides back on the mutation body.
    const diags = await assertOrderFeasible(
      makeDi({ [BAND_SYM_KEY]: bandSymbolInfo }),
      fakeP(['ETHUSDT']),
      trailingTrade,
      deepStopConfig,
      { mode: 'live' },
    );
    const band = diags.find((d) => d.code === 'stop-outside-exchange-band');
    expect(band?.level).toBe('warn');
    expect(band?.message).toContain('ETHUSDT: ');
    expect(band?.message).toContain('15%');
    expect(band?.message).toContain('4.52%');
    // Names the fallback so the operator can change the outcome, not just the stop.
    expect(band?.message).toContain('notify');
    expect(band?.path).toEqual(['sell', 'stopLossPercentage']);
  });

  it('runs on a symbol with no cached price, which is the state a fresh bind is in', async () => {
    // The band check reads filters and config only. Gating it behind the price
    // would silence it on exactly the route it exists for.
    const diags = await assertOrderFeasible(
      makeDi({ [BAND_SYM_KEY]: bandSymbolInfo }),
      fakeP(['ETHUSDT']),
      trailingTrade,
      deepStopConfig,
      { mode: 'live' },
    );
    expect(diags.map((d) => d.code)).toContain('stop-outside-exchange-band');
  });

  it('runs for a strategy that has no order-feasibility check at all', async () => {
    // The strategy that owns the deepest stops implements no sizing check, so
    // hanging the band check off that member would leave it uncovered.
    const noCheck = {
      ...trailingTrade,
      checkOrderFeasibility: undefined,
    } as unknown as AnyStrategy;
    const diags = await assertOrderFeasible(
      makeDi({ [BAND_SYM_KEY]: bandSymbolInfo }),
      fakeP(['ETHUSDT']),
      noCheck,
      deepStopConfig,
      { mode: 'live' },
    );
    expect(diags.map((d) => d.code)).toEqual(['stop-outside-exchange-band']);
  });

  it('reports the band check as unrun when the filters never loaded', async () => {
    // The band check reads the same filters the sizing check does, so an
    // unreadable snapshot skips it too. For a strategy with no sizing check the
    // sizing sentence does not apply, and saying nothing at all left an empty
    // result that reads as "checked and fine" on the one check that ran.
    const noCheck = {
      ...trailingTrade,
      checkOrderFeasibility: undefined,
    } as unknown as AnyStrategy;
    const diags = await assertOrderFeasible(
      makeDi({}),
      fakeP(['ETHUSDT']),
      noCheck,
      deepStopConfig,
      { mode: 'live' },
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ level: 'warn', code: 'filters-unavailable' });
    expect(diags[0]?.message).toMatch(/^ETHUSDT: /);
    expect(diags[0]?.message).toMatch(/price band/);
    // The sizing wording would name a check this strategy never had.
    expect(diags[0]?.message).not.toMatch(/order sizing/);
  });

  it('carries the symbol trailing bounds through, so the trail escape is not promised blind', async () => {
    // `native-trail` escapes the band only when the symbol's own TRAILING_DELTA
    // bounds accept the distance. 15% is 1500 bips against a 1000 cap here, so
    // nothing would rest — and the ordinary sentence promises a trailing stop is
    // covering the position. Exercised through the api's own filter projection,
    // which is where a whitelisted field is easiest to drop.
    const capped = JSON.stringify({
      ...JSON.parse(bandSymbolInfo),
      filters: {
        ...JSON.parse(bandSymbolInfo).filters,
        trailingDelta: {
          minTrailingAboveDelta: 10,
          maxTrailingAboveDelta: 1000,
          minTrailingBelowDelta: 10,
          maxTrailingBelowDelta: 1000,
        },
      },
    });
    const trailCfg = sellCfg({
      stopLossPercentage: '0.85',
      protectiveStop: {
        enabled: true,
        limitOffsetPercentage: '0.995',
        onBandBlock: 'native-trail',
      },
    });
    const message = (
      await assertOrderFeasible(
        makeDi({ [BAND_SYM_KEY]: capped }),
        fakeP(['ETHUSDT']),
        trailingTrade,
        trailCfg,
        { mode: 'live' },
      )
    ).find((d) => d.code === 'stop-outside-exchange-band')?.message;
    expect(message).toContain('will not accept a trailing stop at this distance');
    expect(message).toContain('no resting stop behind it');
  });

  it('stays silent about a missing price for a strategy that sizes no orders', async () => {
    // The mirror of the filters case above, and it must NOT be symmetrical. A
    // missing price only skips the SIZING check, and this strategy has none, so
    // there is nothing unrun to report — while the band check, which never
    // wanted a price, already ran. Read through `orderFeasibilityDiagnostics`
    // with `reportMissingPrice`: without both, `price-unavailable` is dropped
    // before the caller sees it and the assertion cannot fail.
    const noCheck = {
      ...trailingTrade,
      checkOrderFeasibility: undefined,
    } as unknown as AnyStrategy;
    const store = { [BAND_SYM_KEY]: bandSymbolInfo };
    const codes = (
      await orderFeasibilityDiagnostics(
        makeDi(store),
        fakeP(['ETHUSDT']),
        noCheck,
        deepStopConfig,
        {
          mode: 'live',
          reportMissingPrice: true,
        },
      )
    ).map((d) => d.code);
    expect(codes).toContain('stop-outside-exchange-band');
    expect(codes).not.toContain('price-unavailable');

    // Control on the same store: the strategy that DOES size orders had one
    // skipped here, so the warning is owed. Without this the assertion above
    // would pass on a path that reports nothing to anybody.
    const withCheck = (
      await orderFeasibilityDiagnostics(
        makeDi(store),
        fakeP(['ETHUSDT']),
        trailingTrade,
        deepStopConfig,
        { mode: 'live', reportMissingPrice: true },
      )
    ).map((d) => d.code);
    expect(withCheck).toContain('price-unavailable');
  });

  it('fails open on a symbol Binance publishes no band for', async () => {
    // A missing band must never impede a bind: the constraint is unknown, not zero.
    await expect(
      assertOrderFeasible(makeDi(LIVE), fakeP(['BTCUSDT']), trailingTrade, deepStopConfig, {
        mode: 'live',
      }),
    ).resolves.toEqual([]);
  });

  it('fails open on a band that has drifted, without losing the rest of the filters', async () => {
    // A malformed band must fail open on the band ALONE. Taking the whole filter
    // set down would report a readable symbol as unchecked and hide a real block.
    const drifted = JSON.stringify({
      ...JSON.parse(bandSymbolInfo),
      filters: {
        ...JSON.parse(bandSymbolInfo).filters,
        percentPriceBySide: { askMultiplierDown: 7 },
      },
    });
    const store = { [BAND_SYM_KEY]: drifted, [GLOBAL_KEYS.ticker('ETHUSDT')]: ticker };
    const diags = await orderFeasibilityDiagnostics(
      makeDi(store),
      fakeP(['ETHUSDT']),
      trailingTrade,
      deepStopConfig,
      { mode: 'live' },
    );
    expect(diags.map((d) => d.code)).not.toContain('stop-outside-exchange-band');
    expect(diags.map((d) => d.code)).not.toContain('filters-unavailable');
  });

  it('says nothing when the profile rests no stop at the exchange', async () => {
    await expect(
      assertOrderFeasible(
        makeDi({ [BAND_SYM_KEY]: bandSymbolInfo }),
        fakeP(['ETHUSDT']),
        trailingTrade,
        sellCfg({ stopLossPercentage: '0.85' }),
        { mode: 'live' },
      ),
    ).resolves.toEqual([]);
  });
});

describe('assertOrderFeasible', () => {
  it('throws VALIDATION_FAILED when a block is found', async () => {
    await expect(
      assertOrderFeasible(makeDi(LIVE), fakeP(['BTCUSDT']), trailingTrade, subMinConfig, {
        mode: 'live',
      }),
    ).rejects.toThrow(/minimum order value/i);
  });

  it('reports nothing when the config is feasible', async () => {
    await expect(
      assertOrderFeasible(makeDi(LIVE), fakeP(['BTCUSDT']), trailingTrade, gridConfig, {
        mode: 'live',
      }),
    ).resolves.toEqual([]);
  });

  it('does not reject a live-mode save when the symbol could not be checked', async () => {
    // An unreadable snapshot is an advisory warn, not a block: a stale cache
    // must never 422 an otherwise valid config edit. It is still handed back so
    // the caller can tell the operator the save went in unverified.
    await expect(
      assertOrderFeasible(makeDi({}), fakeP(['BTCUSDT']), trailingTrade, subMinConfig, {
        mode: 'live',
      }),
    ).resolves.toEqual([expect.objectContaining({ level: 'warn', code: 'filters-unavailable' })]);
  });

  it('does not reject a test-mode save when the symbol could not be checked', async () => {
    // The live keyspace holds a snapshot that WOULD block this sub-minimum
    // config. A test-mode read must miss it and still resolve, so this pins the
    // mode routing and the non-blocking behaviour in one call.
    await expect(
      assertOrderFeasible(makeDi(LIVE), fakeP(['BTCUSDT']), trailingTrade, subMinConfig, {
        mode: 'test',
      }),
    ).resolves.toEqual([expect.objectContaining({ level: 'warn', code: 'filters-unavailable' })]);
  });

  it('keeps the routine no-price state off the save surface by default', async () => {
    // A config save checks every bound symbol, and an operator configuring a
    // profile that is not enabled yet can do nothing about any of them.
    const priceless = { [SYM_KEY]: symbolInfo };
    const diags = await orderFeasibilityDiagnostics(
      makeDi(priceless),
      fakeP(['BTCUSDT']),
      trailingTrade,
      gridConfig,
      { mode: 'live' },
    );
    // The settings-lint surface still receives it; only the save surface drops it.
    expect(diags.map((d) => d.code)).toEqual(['price-unavailable']);
    await expect(
      assertOrderFeasible(makeDi(priceless), fakeP(['BTCUSDT']), trailingTrade, gridConfig, {
        mode: 'live',
      }),
    ).resolves.toEqual([]);
  });

  it('reports the missing price when the caller opts in', async () => {
    // The add-symbol bind checks exactly one symbol, and that symbol is not
    // subscribed yet, so its sizing check is skipped every time. Silence there
    // would be a claim of verification the route can never honour.
    await expect(
      assertOrderFeasible(
        makeDi({ [SYM_KEY]: symbolInfo }),
        fakeP(['BTCUSDT']),
        trailingTrade,
        gridConfig,
        { mode: 'live', reportMissingPrice: true },
      ),
    ).resolves.toEqual([expect.objectContaining({ level: 'warn', code: 'price-unavailable' })]);
  });

  it('drops a plugin finding that spells a host code', async () => {
    // Plugin `code` and `message` reach the wire verbatim, and the host hands
    // plugins a wallet figure to size against, which the shipped strategy already
    // interpolates into its copy. Selecting by code would let any plugin put
    // arbitrary text on a body that is anonymously readable under the public
    // demo, so the selection is by provenance instead.
    const impostor = {
      ...trailingTrade,
      checkOrderFeasibility: () => [
        { level: 'warn' as const, code: 'filters-unavailable', message: 'balance is 1234' },
      ],
    } as unknown as AnyStrategy;
    const lint = await orderFeasibilityDiagnostics(
      makeDi(LIVE),
      fakeP(['BTCUSDT']),
      impostor,
      gridConfig,
      { mode: 'live' },
    );
    // It still reaches the authenticated settings-lint surface, so this is a
    // boundary rule and not a swallowed finding.
    expect(lint).toEqual([expect.objectContaining({ message: 'BTCUSDT: balance is 1234' })]);
    await expect(
      assertOrderFeasible(makeDi(LIVE), fakeP(['BTCUSDT']), impostor, gridConfig, {
        mode: 'live',
      }),
    ).resolves.toEqual([]);
  });

  it('carries no value beyond the four wire fields', async () => {
    // The findings ride back in a mutation response, and the public demo makes
    // every unguarded response anonymously readable. A fixed four-field
    // projection is what makes a credential-equivalent value impossible to
    // attach by construction, so pin the key set rather than trusting review.
    const diags = await assertOrderFeasible(
      makeDi({}),
      fakeP(['BTCUSDT']),
      trailingTrade,
      subMinConfig,
      { mode: 'live' },
    );
    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags) {
      expect(Object.keys(d).every((k) => ['level', 'code', 'message', 'path'].includes(k))).toBe(
        true,
      );
    }
  });
});

describe('assertOrderFeasibleForProfile', () => {
  const profile = { strategyName: 'trailing-trade', strategyVersion: '2.0.0' };

  it('resolves + parses then blocks an infeasible config', async () => {
    await expect(
      assertOrderFeasibleForProfile(
        makeDi(LIVE),
        fakeP(['BTCUSDT']),
        profile,
        subMinConfig,
        'live',
      ),
    ).rejects.toThrow(/minimum order value/i);
  });

  // Both branches below leave nothing to size against, so the check cannot run.
  // They used to return nothing at all, which the caller could not tell apart
  // from a config that passed every check.
  it('reports config-unverified for an unknown strategy', async () => {
    await expect(
      assertOrderFeasibleForProfile(
        makeDi(LIVE),
        fakeP(['BTCUSDT']),
        { strategyName: 'nope', strategyVersion: '1' },
        subMinConfig,
        'live',
      ),
    ).resolves.toEqual([expect.objectContaining({ level: 'warn', code: 'config-unverified' })]);
  });

  it('reports config-unverified when the raw config no longer parses', async () => {
    await expect(
      assertOrderFeasibleForProfile(
        makeDi(LIVE),
        fakeP(['BTCUSDT']),
        profile,
        { buy: 'not-a-config' },
        'live',
      ),
    ).resolves.toEqual([expect.objectContaining({ level: 'warn', code: 'config-unverified' })]);
  });

  // The mode is a REQUIRED positional the caller reads from the account row. It
  // used to be inferred from a `binanceMode` field on the profile argument —
  // which these tests satisfied by hand-building `{ ...profile, binanceMode }`,
  // a shape no production caller can produce, because the column lives on
  // `accounts` and not `profiles`. Every real call therefore resolved `live`,
  // and a testnet profile was validated against production filters. Passing the
  // mode explicitly is what makes these tests exercise the real call shape.
  it('routes the filter read to the testnet keyspace when the account is test-mode', async () => {
    await expect(
      assertOrderFeasibleForProfile(
        makeDi(TEST_ONLY),
        fakeP(['BTCUSDT']),
        profile,
        subMinConfig,
        'test',
      ),
    ).rejects.toThrow(/minimum order value/i);
  });

  it('a live-mode account does not reach the test keyspace', async () => {
    // Live mode against a testnet-only store → the test key is not read, the
    // symbol goes unchecked (an advisory warn), and the save is not blocked.
    // Pins keyspace isolation.
    await expect(
      assertOrderFeasibleForProfile(
        makeDi(TEST_ONLY),
        fakeP(['BTCUSDT']),
        profile,
        subMinConfig,
        'live',
      ),
    ).resolves.toEqual([expect.objectContaining({ level: 'warn', code: 'filters-unavailable' })]);
  });
});

describe('withDiagnostics', () => {
  it('omits the field entirely when there is nothing to report', () => {
    const body = { runId: 'r1', deduped: false };
    // Not `diagnostics: []`. Absence is what keeps a clean response identical to
    // what every existing client already parses.
    expect(withDiagnostics(body, [])).not.toHaveProperty('diagnostics');
    expect(withDiagnostics(body, [])).toEqual(body);
  });

  it('attaches a copy without mutating the body it was given', () => {
    const body = { runId: 'r1', deduped: false };
    const diags = [{ level: 'warn' as const, code: 'filters-unavailable', message: 'x' }];
    expect(withDiagnostics(body, diags)).toEqual({ ...body, diagnostics: diags });
    expect(body).not.toHaveProperty('diagnostics');
  });
});
