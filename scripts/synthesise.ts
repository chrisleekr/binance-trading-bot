// scripts/synthesise.ts: deterministic synthesised-fixture generator.
//
// Produces a self-derived baseline for the replay regression gate: every
// scenario assembles a deterministic TickInput, runs it through
// `trailingTrade.tick`, and writes the (input, expected) pair as a
// FixtureLine. The fixtures are by construction in agreement with the
// strategy at the moment of generation, so any later regression in
// `trailingTrade.tick` is a real diff against the frozen synthesised set.
//
// FREEZING RULE
//   Synthesised fixtures are immutable once committed. A regression that
//   changes a captured value is only acceptable if EITHER:
//     (a) the strategy diverged on purpose: prepend a `# rationale: <ref>`
//         comment line to the fixture (replay tolerates `^#` lines), OR
//     (b) the regression is reverted.
//   Re-running this script overwrites the file unconditionally; CI re-runs
//   the replay test against the committed payload, not against a freshly
//   synthesised one, so a forgotten checkin is what makes a regression
//   visible.
//
// SCOPE NOTE
//   Most scenarios reduce to one or two ticks of `tick-snapshot` / `noop`;
//   the harness is wired so adding ticks per scenario is mechanical. The
//   point is the gate: replay-with-diff=0 is enforced, and the fixture
//   format is locked.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';

import {
  trailingTrade,
  TTBundleSchema,
  TTConfigSchema,
  type TTBundle,
  type TTConfig,
  type TTState,
} from '@app/strategy-trailing-trade';
import {
  type AccountSnapshot,
  type Balance,
  type Candle,
  type TickInput,
  type TickOutput,
  type TriggerEvent,
} from '@app/strategy-core';
import { FIXTURE_SCHEMA_VERSION, type FixtureLine } from '@app/strategy-core/replay';
import { Decimal } from '@app/money';

const reviveAccount = (s: {
  balances: Readonly<Record<string, { asset: string; free: string; locked: string }>>;
}): AccountSnapshot => {
  const balances: Record<string, Balance> = {};
  for (const [asset, b] of Object.entries(s.balances)) {
    let free: Decimal;
    let locked: Decimal;
    try {
      free = new Decimal(b.free);
    } catch {
      free = new Decimal(0);
    }
    try {
      locked = new Decimal(b.locked);
    } catch {
      locked = new Decimal(0);
    }
    balances[asset] = { asset: b.asset, free, locked };
  }
  // A recorded/synthesised frame is a real wallet read, so it is readable; an
  // empty balance map is a genuine zero here, not an unreadable snapshot.
  return { balances, readable: true };
};

const DEFAULT_OUT_DIR = 'packages/strategy/trailing-trade/fixtures/replay/synthesised';

// One-stop list. The scenario name is the file stem; replay.test.ts iterates
// the directory and matches every entry against this set so nothing slips in
// unannounced.
export const SYNTHESISED_SCENARIOS = [
  'idle',
  'first-buy',
  'grid-progression',
  'stop-loss',
  'technicals-force-sell',
  'technicals-force-sell-multi-interval',
  'technicals-force-sell-profit-floor',
  'technicals-force-sell-disabled',
  'technicals-stale',
  'technicals-sell',
  'manual-trade',
  'partial-fill',
  'api-limit-exceeded',
  'disable-action',
  'protective-stop-arm',
  'protective-stop-cancel-on-sell',
  'loss-cooldown-churn',
  'entry-confirm-reads',
  'discovery-chase-guard',
  'discovery-knife-guard',
  'atr-trail-from-entry',
] as const;

type Scenario = (typeof SYNTHESISED_SCENARIOS)[number];

interface SynthesiseOptions {
  readonly outDir: string;
  readonly scenarios: readonly Scenario[];
}

const parseArgs = (args: readonly string[]): SynthesiseOptions => {
  let outDir = DEFAULT_OUT_DIR;
  const scenarios: Scenario[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    // Reject `undefined` AND flag-like next-tokens (`--out-dir --scenario`
    // would otherwise silently set outDir to "--scenario").
    const valueIsMissing = value === undefined || value.startsWith('--');
    if (flag === '--out-dir') {
      if (valueIsMissing) throw new Error('--out-dir requires a value');
      outDir = value;
      i++;
    } else if (flag === '--scenario') {
      if (valueIsMissing) throw new Error('--scenario requires a value');
      if (!(SYNTHESISED_SCENARIOS as readonly string[]).includes(value)) {
        throw new Error(`unknown scenario: ${value}`);
      }
      scenarios.push(value as Scenario);
      i++;
    } else {
      // Unknown flag — fail fast so a typo doesn't silently regenerate
      // the full fixture set.
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  return {
    outDir,
    scenarios: scenarios.length > 0 ? scenarios : SYNTHESISED_SCENARIOS,
  };
};

const cfg = (): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '10' },
      avgEntryPriceRemoveThreshold: '0',
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    // Pin the operator-config interval to match `tvBundle()`'s default
    // signal interval. Without this the TT schema default fills
    // `config.technicals.intervals` with `1h` while the bundle still
    // advertises a `1m` signal — the fixture would pair an "operator-
    // wants-1h" config with a "bundle-says-1m" signal, an incoherent
    // pairing that confuses future fixture readers.
    technicals: {
      useOnlyWithinMin: 2,
      ifExpires: 'do-not-buy',
      intervals: [
        {
          interval: '1m',
          whenStrongBuy: true,
          whenBuy: true,
          whenSell: false,
          whenStrongSell: false,
          whenNeutral: false,
        },
      ],
    },
  });

// Config with the exchange-side protective stop enabled. Same base as cfg()
// plus sell.protectiveStop.enabled so the arm / cancel scenarios exercise the
// STOP_LOSS_LIMIT path. Parsed through TTConfigSchema so the field defaults
// (limitOffsetPercentage) are realised exactly as the worker sees them.
const protectiveCfg = (): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '10' },
      avgEntryPriceRemoveThreshold: '0',
    },
    sell: {
      enabled: true,
      stopLossPercentage: '0.97',
      triggerPercentage: '1.05',
      protectiveStop: { enabled: true },
    },
    technicals: {
      useOnlyWithinMin: 2,
      ifExpires: 'do-not-buy',
      intervals: [
        {
          interval: '1m',
          whenStrongBuy: true,
          whenBuy: true,
          whenSell: false,
          whenStrongSell: false,
          whenNeutral: false,
        },
      ],
    },
  });

// Config with entryConfirmReads=3: the non-grid first-entry technicals gate must
// read ALLOW three ticks in a row before the first buy fires. Exercises the
// entry-confirm hysteresis so a regression that drops the streak gate (or
// off-by-ones it) loses the replay diff=0 contract.
const confirmReadsCfg = (): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '10' },
      avgEntryPriceRemoveThreshold: '0',
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    technicals: {
      useOnlyWithinMin: 2,
      ifExpires: 'do-not-buy',
      entryConfirmReads: 3,
      intervals: [
        {
          interval: '1m',
          whenStrongBuy: true,
          whenBuy: true,
          whenSell: false,
          whenStrongSell: false,
          whenNeutral: false,
        },
      ],
    },
  });

// Discovery single-entry config for the anti-chase guard fixtures: immediate
// first-buy basis + an explicit level-0 grid + a valid hard stop, so an armed
// enterOnAdd hint passes the fail-closed discovery guardrail and would place a
// first buy were the guard not vetoing it.
const discoveryCfg = (): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '15' },
      avgEntryPriceRemoveThreshold: '0',
      firstBuyTriggerBasis: 'immediate',
      gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '15' }],
    },
    sell: { enabled: true, stopLossPercentage: '0.9', triggerPercentage: '1.05' },
    technicals: {
      useOnlyWithinMin: 2,
      ifExpires: 'do-not-buy',
      intervals: [
        {
          interval: '1m',
          whenStrongBuy: true,
          whenBuy: true,
          whenSell: false,
          whenStrongSell: false,
          whenNeutral: false,
        },
      ],
    },
  });

// Trend-follow config for the ATR-trail-from-entry fixture: ATR trailing on with
// fromEntry, a wide stop-loss floor (so the trail, not the hard stop, owns the
// exit), and no fixed-% trail. triggerPercentage is high enough that the dip
// never reaches it — the position exits via the from-entry ATR trail alone.
const fromEntryCfg = (): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
    },
    sell: {
      enabled: true,
      stopLossPercentage: '0.9',
      triggerPercentage: '1.05',
      trailingStopPercentage: '0',
      atrTrailing: { enabled: true, fromEntry: true, period: 14, multiplier: '3' },
    },
    technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [] },
  });

// `n` closed 1h candles with a constant true range of 2 ⇒ ATR(period) = 2, for
// the from-entry ATR trail window.
const atrTrailCandles = (n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    openTimeMs: i * 3_600_000,
    closeTimeMs: i * 3_600_000 + 3_599_999,
    open: '100',
    high: '101',
    low: '99',
    close: '100',
    volume: '1',
    isClosed: true,
  }));

// A flat synthetic closed candle at a single price, for the knife-guard window.
const synthCandle = (price: string): Candle => ({
  openTimeMs: 0,
  closeTimeMs: 0,
  open: price,
  high: price,
  low: price,
  close: price,
  volume: '1',
  isClosed: true,
});

// Attach an enterOnAdd entry hint (with optional guard fields) to a tvBundle by
// re-parsing through TTBundleSchema, so the discovery fixtures express the guard
// shape without duplicating the technicals scaffolding.
const withEntryHint = (base: TTBundle, entryHint: Record<string, unknown>): TTBundle =>
  TTBundleSchema.parse({ ...base, entryHint });

// Per-interval signal cell used by the multi-interval bundle. The synth
// helpers accept a free-form union here so a scenario can either pass a
// fully-typed `TechnicalsSignal` or `null` (no signal yet).
type SyntheticSignal = {
  readonly symbol: string;
  readonly recommendation: 'BUY' | 'SELL' | 'NEUTRAL' | 'STRONG_BUY' | 'STRONG_SELL';
  readonly receivedAtMs: number;
} | null;

interface TvBundleOverrides {
  /**
   * Convenience: when only one interval is in play, pass `signal` and the
   * helper pairs it with the schema's default `1m` interval row.
   */
  readonly signal?: SyntheticSignal;
  /**
   * Multi-interval override: each entry produces one `intervals[]` row
   * AND its paired `signals[]` row. The contract's `superRefine` requires
   * 1:1 ordering, which this helper guarantees by construction.
   */
  readonly intervals?: readonly {
    readonly interval: string;
    readonly whenStrongBuy?: boolean;
    readonly whenBuy?: boolean;
    readonly whenSell?: boolean;
    readonly whenStrongSell?: boolean;
    readonly whenNeutral?: boolean;
    readonly signal?: SyntheticSignal;
  }[];
  readonly useOnlyWithinMin?: number;
  readonly ifExpires?: 'do-not-buy' | 'allow-anyway';
}

const tvBundle = (o: TvBundleOverrides = {}): TTBundle => {
  // Single-signal short-form maps to the schema's default `1m` interval
  // so the most common scenario (one signal, default config) reads
  // cleanly at the call site.
  const rows = o.intervals ?? [
    { interval: '1m', ...(o.signal !== undefined ? { signal: o.signal } : {}) },
  ];
  return TTBundleSchema.parse({
    technicals: {
      config: {
        useOnlyWithinMin: o.useOnlyWithinMin ?? 2,
        ifExpires: o.ifExpires ?? 'do-not-buy',
        intervals: rows.map((r) => ({
          interval: r.interval,
          whenStrongBuy: r.whenStrongBuy ?? true,
          whenBuy: r.whenBuy ?? true,
          whenSell: r.whenSell ?? false,
          whenStrongSell: r.whenStrongSell ?? false,
          whenNeutral: r.whenNeutral ?? false,
        })),
      },
      signals: rows.map((r) => ({
        interval: r.interval,
        signal: r.signal ?? null,
      })),
    },
    override: null,
  });
};

interface InputOverrides {
  readonly config?: TTConfig;
  readonly state?: TTState;
  readonly bundle?: TTBundle;
  readonly currentPrice?: string;
  readonly trigger?: TriggerEvent;
  readonly openOrders?: TickInput<TTConfig, TTState, TTBundle>['openOrders'];
  readonly limits?: TickInput<TTConfig, TTState, TTBundle>['limits'];
  readonly account?: TickInput<TTConfig, TTState, TTBundle>['account'];
  readonly candlesByInterval?: TickInput<
    TTConfig,
    TTState,
    TTBundle
  >['market']['candlesByInterval'];
  readonly nowMs?: number;
}

const buildInput = (o: InputOverrides = {}): TickInput<TTConfig, TTState, TTBundle> => {
  const c = o.config ?? cfg();
  const nowMs = o.nowMs ?? 1_700_000_000_000;
  return {
    // The fixture schema serialises `clock.nowMs()` lazily through
    // `trailingTrade.tick`; we capture the value via a closure but the JSONL
    // line itself stores the *result* of `nowMs()` because functions don't
    // serialise. Replay rebuilds an equivalent Clock from the persisted ms.
    clock: { nowMs: () => nowMs },
    rng: { next: () => 0 },
    trigger: o.trigger ?? { kind: 'tick' },
    profile: {
      id: 'p-synth',
      userId: 'u-synth',
      binanceMode: 'test',
      status: 'running',
      strategyVersion: '2.0.0',
    },
    config: c,
    state: o.state ?? trailingTrade.initialState(c),
    market: {
      symbol: 'BTCUSDT',
      currentPrice: o.currentPrice ?? '50000.00',
      candlesByInterval: o.candlesByInterval ?? {},
      symbolInfo: {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        status: 'TRADING',
        filters: {
          minNotional: '10',
          tickSize: '0.01',
          stepSize: '0.0001',
          minQty: '0.0001',
          maxQty: '9000',
          minPrice: '0.01',
          maxPrice: '1000000',
        },
      },
    },
    // Scenarios hand-write balances as decimal-strings for readability; the
    // strategy contract expects Decimal-typed `free` / `locked`, so revive
    // each raw balance here once instead of repeating `new Decimal(...)` at
    // every scenario builder.
    account: o.account
      ? reviveAccount(o.account as unknown as Parameters<typeof reviveAccount>[0])
      : {
          balances: { USDT: { asset: 'USDT', free: new Decimal('1000'), locked: new Decimal(0) } },
        },
    openOrders: o.openOrders ?? [],
    bundle: o.bundle ?? tvBundle(),
    limits: o.limits ?? { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
  };
};

// Each scenario is a single tick today. The `inputs` array is the seed; the
// `tick` index, the fixture's `expected`, and the threaded state are all
// derived. Scaling to multi-tick scenarios = appending to the `inputs`
// array; the threading already runs through `trailingTrade.tick`.
const SCENARIO_BUILDERS: Record<Scenario, () => TickInput<TTConfig, TTState, TTBundle>[]> = {
  idle: () => [buildInput()],
  'first-buy': () => [
    buildInput({
      state: {
        ...trailingTrade.initialState(cfg()),
        avgEntryPrice: null,
      },
      currentPrice: '50000.00',
    }),
  ],
  'grid-progression': () => [
    buildInput({
      state: {
        ...trailingTrade.initialState(cfg()),
        avgEntryPrice: '49000.00',
      },
      currentPrice: '51500.00',
    }),
  ],
  'stop-loss': () => [
    buildInput({
      state: {
        ...trailingTrade.initialState(cfg()),
        avgEntryPrice: '50000.00',
      },
      currentPrice: '48000.00',
    }),
  ],
  'technicals-force-sell': () => [
    buildInput({
      bundle: tvBundle({}),
    }),
  ],
  // Multi-interval force-sell: two operator-configured intervals where only
  // the slow one fires STRONG_SELL. Position is held in profit and below
  // the sell-trigger so the force-sell branch fires off the 1h row even
  // though 1m is bullish. Pins the OR-across-intervals semantics so a
  // future refactor that ANDs the trigger set is caught by replay.
  'technicals-force-sell-multi-interval': () => [
    buildInput({
      state: {
        ...trailingTrade.initialState(cfg()),
        avgEntryPrice: '50000.00',
      },
      // 50000 * 1.05 = 52500 sell-trigger; 51000 is below trigger and
      // above the last-buy floor, satisfying the force-sell guards.
      currentPrice: '51000.00',
      // A non-zero base-asset balance is required for the sell emission;
      // without it the gate would log `tt-tv-force-sell-skipped` and the
      // fixture would not pin the place-order shape.
      account: {
        balances: {
          USDT: { asset: 'USDT', free: '1000', locked: '0' },
          BTC: { asset: 'BTC', free: '0.0005', locked: '0' },
        },
      },
      bundle: tvBundle({
        intervals: [
          {
            interval: '1m',
            whenStrongSell: true,
            signal: {
              symbol: 'BTCUSDT',
              recommendation: 'BUY',
              receivedAtMs: 1_700_000_000_000 - 30_000,
            },
          },
          {
            interval: '1h',
            whenStrongSell: true,
            signal: {
              symbol: 'BTCUSDT',
              recommendation: 'STRONG_SELL',
              receivedAtMs: 1_700_000_000_000 - 30_000,
            },
          },
        ],
      }),
    }),
  ],
  // Profit-floor guard: STRONG_SELL signal but `currentPrice <= avgEntryPrice`,
  // so the force-sell branch must not fire — the strategy never force-sells
  // at a loss. Pins this rule so a refactor that drops the profit guard is
  // caught.
  'technicals-force-sell-profit-floor': () => [
    buildInput({
      state: {
        ...trailingTrade.initialState(cfg()),
        avgEntryPrice: '50000.00',
      },
      // Below the last-buy price → at a loss; force-sell must skip.
      currentPrice: '49000.00',
      bundle: tvBundle({
        intervals: [
          {
            interval: '1m',
            whenStrongSell: true,
            signal: {
              symbol: 'BTCUSDT',
              recommendation: 'STRONG_SELL',
              receivedAtMs: 1_700_000_000_000 - 30_000,
            },
          },
        ],
      }),
    }),
  ],
  // Config-disabled: operator left every whenSell / whenStrongSell /
  // whenNeutral toggle off, so even a fresh STRONG_SELL on a held,
  // in-profit, below-trigger position must not force-sell. Pins the
  // opt-in shape of the force-sell branch.
  'technicals-force-sell-disabled': () => [
    buildInput({
      state: {
        ...trailingTrade.initialState(cfg()),
        avgEntryPrice: '50000.00',
      },
      currentPrice: '51000.00',
      bundle: tvBundle({
        intervals: [
          {
            interval: '1m',
            // All sell toggles default to false; spelled out for clarity.
            whenSell: false,
            whenStrongSell: false,
            whenNeutral: false,
            signal: {
              symbol: 'BTCUSDT',
              recommendation: 'STRONG_SELL',
              receivedAtMs: 1_700_000_000_000 - 30_000,
            },
          },
        ],
      }),
    }),
  ],
  // BUY signal one millisecond past the 2-minute freshness window with the
  // default `ifExpires=do-not-buy`. Exercises the technicals-stale veto so a future
  // refactor that flips the `>` boundary or drops the freshness rule loses
  // the replay diff=0 contract.
  'technicals-stale': () => [
    buildInput({
      bundle: tvBundle({
        signal: {
          symbol: 'BTCUSDT',
          recommendation: 'BUY',
          receivedAtMs: 1_700_000_000_000 - 120_000 - 1,
        },
      }),
    }),
  ],
  // Fresh SELL signal vetoes the buy. Pins the recommendation-veto path so
  // a regression that removes SELL from the veto set (or short-circuits the
  // freshness check before it) is caught by replay.
  'technicals-sell': () => [
    buildInput({
      bundle: tvBundle({
        signal: {
          symbol: 'BTCUSDT',
          recommendation: 'SELL',
          receivedAtMs: 1_700_000_000_000 - 30_000,
        },
      }),
    }),
  ],
  'manual-trade': () => [buildInput({ trigger: { kind: 'manual' } })],
  'partial-fill': () => [
    buildInput({
      openOrders: [
        {
          orderId: 1,
          clientOrderId: 'synth-1',
          symbol: 'BTCUSDT',
          side: 'BUY',
          type: 'LIMIT',
          status: 'PARTIALLY_FILLED',
          price: '49500.00',
          origQty: '0.0010',
          executedQty: '0.0004',
          cummulativeQuoteQty: '19.80',
          timeInForce: 'GTC',
          transactTimeMs: 1_700_000_000_000,
          updateTimeMs: 1_700_000_000_500,
        },
      ],
    }),
  ],
  'api-limit-exceeded': () => [
    buildInput({
      // 95% used; the strategy must defer place-orders. trailingTrade today
      // doesn't yet act on this, but the fixture pins the input so the gate
      // catches the change when it does.
      limits: { weightUsed1m: 1140, weightLimit1m: 1200, headroomBps: 500 },
    }),
  ],
  'disable-action': () => [
    buildInput({
      state: {
        ...trailingTrade.initialState(cfg()),
        // 1h in the future relative to nowMs.
        disabledUntilMs: 1_700_000_000_000 + 60 * 60 * 1000,
      },
    }),
  ],
  // Protective stop arms a resting STOP_LOSS_LIMIT SELL: position held in
  // profit and above the in-process stop, no resting protective order yet. Pins
  // the place-order stop/limit shape and the avgEntry × stopLoss trigger so a
  // refactor that drops the offline backstop loses the replay diff=0 contract.
  'protective-stop-arm': () => [
    buildInput({
      config: protectiveCfg(),
      state: {
        ...trailingTrade.initialState(protectiveCfg()),
        avgEntryPrice: '50000.00',
        heldQuantity: '0.0010',
      },
      // Above the 48500 stop (50000 × 0.97) and below the 52500 sell-trigger:
      // no terminal sell fires, only the protective stop can arm.
      currentPrice: '51000.00',
      account: {
        balances: {
          USDT: { asset: 'USDT', free: '1000', locked: '0' },
          BTC: { asset: 'BTC', free: '0.0010', locked: '0' },
        },
      },
    }),
  ],
  // Loss-cooldown churn: a held position is stopped out at a loss (tick 0),
  // arming the loss-exit re-entry cooldown; the next two ticks present a fresh
  // STRONG_BUY but the cooldown suppresses the re-buy (entryBlocker
  // 'loss-cooldown'). Pins the default-60-minute cooldown so a regression that
  // re-buys straight back into the drop (the −2.93 vs −2.18 churn this guards)
  // loses the replay diff=0 contract. nowMs advances a minute per tick, all well
  // inside the 60-minute window.
  'loss-cooldown-churn': () => {
    const c = cfg();
    const buyBundle = tvBundle({
      signal: {
        symbol: 'BTCUSDT',
        recommendation: 'STRONG_BUY',
        receivedAtMs: 1_700_000_000_000,
      },
    });
    return [
      // Tick 0: held at 50000, price drops to 48000 (<= 50000 × 0.97 = 48500) ⇒
      // grid-stop-loss SELL emits and stamps the loss-exit cooldown. A BTC
      // balance is required for the sell to emit (not skip on no-balance).
      buildInput({
        state: {
          ...trailingTrade.initialState(c),
          avgEntryPrice: '50000.00',
          heldQuantity: '0.0010',
        },
        currentPrice: '48000.00',
        account: {
          balances: {
            USDT: { asset: 'USDT', free: '1000', locked: '0' },
            BTC: { asset: 'BTC', free: '0.0010', locked: '0' },
          },
        },
        nowMs: 1_700_000_000_000,
      }),
      // Tick 1: flat, fresh STRONG_BUY, 1 minute later ⇒ still in cooldown,
      // re-buy suppressed.
      buildInput({ currentPrice: '48000.00', bundle: buyBundle, nowMs: 1_700_000_060_000 }),
      // Tick 2: 2 minutes after the stop-out ⇒ still suppressed.
      buildInput({ currentPrice: '48000.00', bundle: buyBundle, nowMs: 1_700_000_120_000 }),
    ];
  },
  // Entry-confirm hysteresis: entryConfirmReads=3 requires three consecutive
  // ALLOW reads before the first buy. Tick 0/1 block with 'technicals-confirming'
  // (reads 1/3, 2/3); tick 2 reaches the threshold and the buy fires. Pins the
  // streak so a refactor that off-by-ones the count or drops the gate diverges.
  'entry-confirm-reads': () => {
    const c = confirmReadsCfg();
    const buyBundle = (nowMs: number): TTBundle =>
      tvBundle({
        useOnlyWithinMin: c.technicals.useOnlyWithinMin,
        signal: { symbol: 'BTCUSDT', recommendation: 'STRONG_BUY', receivedAtMs: nowMs },
      });
    return [
      buildInput({ config: c, bundle: buyBundle(1_700_000_000_000), nowMs: 1_700_000_000_000 }),
      buildInput({ config: c, bundle: buyBundle(1_700_000_010_000), nowMs: 1_700_000_010_000 }),
      buildInput({ config: c, bundle: buyBundle(1_700_000_020_000), nowMs: 1_700_000_020_000 }),
    ];
  },
  // Gap-through: price drops below the in-process stop while an exchange-side
  // protective stop is already resting. The closing batch must cancel the
  // resting STOP_LOSS_LIMIT and then market-sell, in that order. Pins the
  // cancel-before-sell ordering of the backstop's primary path.
  'protective-stop-cancel-on-sell': () => [
    buildInput({
      config: protectiveCfg(),
      state: {
        ...trailingTrade.initialState(protectiveCfg()),
        avgEntryPrice: '50000.00',
        heldQuantity: '0.0010',
      },
      // Below the 48500 stop ⇒ in-process MARKET stop-loss fires.
      currentPrice: '48000.00',
      account: {
        balances: {
          USDT: { asset: 'USDT', free: '1000', locked: '0' },
          BTC: { asset: 'BTC', free: '0.0010', locked: '0' },
        },
      },
      openOrders: [
        {
          orderId: 7001,
          // protectiveStopClientOrderId('p-synth', 'BTCUSDT').
          clientOrderId: 'tt-c3d9d8ed-x',
          symbol: 'BTCUSDT',
          side: 'SELL',
          type: 'STOP_LOSS_LIMIT',
          status: 'NEW',
          price: '48257.50',
          origQty: '0.0010',
          executedQty: '0',
          cummulativeQuoteQty: '0',
          stopPrice: '48500.00',
          timeInForce: 'GTC',
          transactTimeMs: 1_700_000_000_000 - 60_000,
          updateTimeMs: 1_700_000_000_000 - 60_000,
        },
      ],
    }),
  ],
  // Anti-chase guard: an armed enterOnAdd discovery hint with a 24h high
  // of 100 and a 3% max-distance. Price 98 is within the band (>= 97), so the
  // entry is DEFERRED with entryBlocker=chase-guard and no place-order, even
  // though the technicals floor would otherwise allow it. Pins the guard's veto.
  'discovery-chase-guard': () => {
    const c = discoveryCfg();
    const bundle = withEntryHint(
      tvBundle({
        signal: {
          symbol: 'BTCUSDT',
          recommendation: 'BUY',
          receivedAtMs: 1_700_000_000_000 - 30_000,
        },
      }),
      { enterOnAdd: true, high24h: '100', maxDistanceFrom24hHighPercent: '3' },
    );
    return [buildInput({ config: c, bundle, currentPrice: '98' })];
  },
  // Falling-knife guard: an armed enterOnAdd hint with knifeCandles=3 and
  // knifeDropPercent=5. The 1h window closes 100 -> 97 -> 94 (top-to-last 6% >=
  // 5%), so the entry is DEFERRED with entryBlocker=knife-guard and no
  // place-order. Pins the knife veto and its top-to-last reference price.
  'discovery-knife-guard': () => {
    const c = discoveryCfg();
    const bundle = withEntryHint(
      tvBundle({
        signal: {
          symbol: 'BTCUSDT',
          recommendation: 'BUY',
          receivedAtMs: 1_700_000_000_000 - 30_000,
        },
      }),
      { enterOnAdd: true, knifeCandles: 3, knifeDropPercent: '5' },
    );
    return [
      buildInput({
        config: c,
        bundle,
        currentPrice: '94',
        candlesByInterval: { '1h': [synthCandle('100'), synthCandle('97'), synthCandle('94')] },
      }),
    ];
  },
  // ATR trail from entry (trend-follow): a held position whose price DIPS after
  // entry without ever reaching the 105 sell-trigger exits via the from-entry
  // ATR trail. Tick 0 (live price 101, below trigger) seeds highSinceBuy from
  // the closed-candle close (100, == entry here) — the high-water mark ratchets
  // on the closed close, not the live price. Without fromEntry this position
  // would have NO trailing protection pre-trigger and would only exit on the
  // wide 90 hard stop. Tick 1 (price 94 ≤ 100 − 3×ATR(2) = 94) trips the armed
  // ATR trail and sells. Pins both the from-entry seeding AND that the trail
  // then fires below the trigger.
  'atr-trail-from-entry': () => {
    const c = fromEntryCfg();
    const candles = { '1h': atrTrailCandles(16) };
    const balances = {
      USDT: { asset: 'USDT', free: '1000', locked: '0' },
      BTC: { asset: 'BTC', free: '0.2', locked: '0' },
    };
    return [
      // Tick 0: held at 100, live price 101 (above entry, below 105 trigger) ⇒
      // the from-entry arm seeds highSinceBuy at the closed-candle close 100
      // (the live 101 wick does not ratchet the high) (bump-high).
      buildInput({
        config: c,
        state: {
          ...trailingTrade.initialState(c),
          avgEntryPrice: '100',
          heldQuantity: '0.2',
        },
        currentPrice: '101',
        candlesByInterval: candles,
        account: { balances },
      }),
      // Tick 1: price 94 ≤ ATR stop (101 − 3×2 = 95 ⇒ 94 is below) ⇒ the armed
      // ATR trail fires grid-sell, all without ever crossing the sell-trigger.
      buildInput({
        config: c,
        currentPrice: '94',
        candlesByInterval: candles,
        account: { balances },
      }),
    ];
  },
};

// `clock` and `rng` are functions and can't survive JSON.stringify. Replay
// rebuilds equivalent stubs from the stamped `nowMs` and a zero-RNG.
const SERIALISABLE_CLOCK_KEY = '__clockNowMs';
const SERIALISABLE_RNG_KEY = '__rngFixed';

// Wire-shape balance: on-disk JSONL stores decimal-strings. The strategy
// contract holds Decimal-typed balances; the boundary revival in
// {@link fromSerialisableInput} mirrors what `parseAccountSnapshot` does in
// the worker so replay sees identical types to production.
interface SerialisableBalance {
  readonly asset: string;
  readonly free: string;
  readonly locked: string;
}

interface SerialisableAccount {
  readonly balances: Readonly<Record<string, SerialisableBalance>>;
}

interface SerialisableInput {
  readonly [SERIALISABLE_CLOCK_KEY]: number;
  readonly [SERIALISABLE_RNG_KEY]: number;
  readonly trigger: TickInput<TTConfig, TTState, TTBundle>['trigger'];
  readonly profile: TickInput<TTConfig, TTState, TTBundle>['profile'];
  readonly config: TTConfig;
  readonly state: TTState;
  readonly market: TickInput<TTConfig, TTState, TTBundle>['market'];
  readonly account: SerialisableAccount;
  readonly openOrders: TickInput<TTConfig, TTState, TTBundle>['openOrders'];
  readonly bundle: TTBundle;
  readonly limits: TickInput<TTConfig, TTState, TTBundle>['limits'];
}

export const toSerialisableInput = (
  input: TickInput<TTConfig, TTState, TTBundle>,
): SerialisableInput => {
  const balances: Record<string, SerialisableBalance> = {};
  for (const [asset, b] of Object.entries(input.account.balances)) {
    // Decimal → decimal-string on the wire so fixtures stay diff-friendly.
    // `Balance.free` / `.locked` are decimal-strings end-to-end (see the
    // strategy contract). `new Decimal(...).toFixed()` round-trips them
    // through normalisation so fixtures stay diff-friendly.
    balances[asset] = {
      asset: b.asset,
      free: new Decimal(b.free).toFixed(),
      locked: new Decimal(b.locked).toFixed(),
    };
  }
  return {
    [SERIALISABLE_CLOCK_KEY]: input.clock.nowMs(),
    [SERIALISABLE_RNG_KEY]: input.rng.next(),
    trigger: input.trigger,
    profile: input.profile,
    config: input.config,
    state: input.state,
    market: input.market,
    account: { balances },
    openOrders: input.openOrders,
    bundle: input.bundle,
    limits: input.limits,
  };
};

export const fromSerialisableInput = (
  s: SerialisableInput,
): TickInput<TTConfig, TTState, TTBundle> => {
  const nowMs = s[SERIALISABLE_CLOCK_KEY];
  const r = s[SERIALISABLE_RNG_KEY];
  return {
    clock: { nowMs: () => nowMs },
    rng: { next: () => r },
    trigger: s.trigger,
    profile: s.profile,
    // Parse config / state through the strategy's own schemas, mirroring
    // what the executor does before every tick. A fixture frozen before a
    // later additive-defaulted field (indicatorGate, autoTriggerBuy,
    // autoTriggerBuyAtMs) was added still loads: the schema default fills
    // the gap, so the replay feeds `tick()` a schema-valid object instead
    // of a stale one.
    config: trailingTrade.configSchema.parse(s.config),
    state: trailingTrade.stateSchema.parse(s.state),
    market: s.market,
    account: reviveAccount(s.account),
    openOrders: s.openOrders,
    bundle: s.bundle,
    limits: s.limits,
  };
};

const buildScenarioFixture = (scenario: Scenario): string => {
  const inputs = SCENARIO_BUILDERS[scenario]();
  const lines: string[] = [];
  let threadedState: TTState | undefined;
  inputs.forEach((rawInput, idx) => {
    const input: TickInput<TTConfig, TTState, TTBundle> =
      threadedState === undefined ? rawInput : { ...rawInput, state: threadedState };
    const full: TickOutput<TTState> = trailingTrade.tick(input);
    // `events` is a logs-derivation and is deliberately NOT frozen in the
    // fixtures (the replay test strips it from the actual output before the
    // diff). Omit it here so a regen stays faithful to that contract instead of
    // re-introducing the derived channel into the golden files.
    const { events: _omitEvents, ...expected } = full;
    const line: FixtureLine<TTConfig, TTState, TTBundle> = {
      tick: idx,
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      // `replayFixture` casts `parsed.input` back into a TickInput; the
      // serialisable shape is structurally identical apart from clock/rng,
      // which the test's loader rebuilds. The cast keeps the JSONL strict
      // about the runtime contract.
      input: toSerialisableInput(input) as unknown as TickInput<TTConfig, TTState, TTBundle>,
      expected: expected as TickOutput<TTState>,
    };
    lines.push(JSON.stringify(line));
    threadedState = full.nextState;
  });
  return lines.join('\n') + '\n';
};

const main = async (): Promise<number> => {
  const opts = parseArgs(argv.slice(2));
  for (const scenario of opts.scenarios) {
    const path = resolve(opts.outDir, `${scenario}.jsonl`);
    await mkdir(dirname(path), { recursive: true });
    const body = buildScenarioFixture(scenario);
    await writeFile(path, body);
    stdout.write(`synthesise: wrote ${path}\n`);
  }
  return 0;
};

if (import.meta.main) {
  main()
    .then((code) => exit(code))
    .catch((err: unknown) => {
      stderr.write(`synthesise: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      exit(1);
    });
}
