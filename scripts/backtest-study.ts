#!/usr/bin/env bun
// Compares break-even arm levels on the replay the worker runs, so a study measures what the operator will see. Input is JSONL: one meta line, then candle rows. See docs/contributing/backtesting-internals.md.

import { createHash } from 'node:crypto';
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { argv, exit, stderr } from 'node:process';
import { Decimal } from '@app/money';
import { buildStrategyRegistry } from '@app/strategy-registry';
import type { BacktestParams } from '@app/contracts';
import {
  configFingerprint,
  type AnyStrategy,
  type Candle,
  type SymbolInfo,
  type TickInput,
} from '@app/strategy-core';
import { replayIntervals, replayPrepared } from '../apps/worker/src/backtest/replay.js';

const ARM_LEVELS = ['1.01', '1.02', '1.03'] as const;
const DECISION_INTERVALS = ['1m', '5m'] as const;
const DETAIL_INTERVAL = '1m';
const VOLUME_CAP_PCT = 1;
// One percent stays unspent so a commission on the opening buy cannot reject the whole order.
const PASSIVE_ALLOCATION = new Decimal('0.99');
const BTC_SYMBOL = 'BTCUSDT';
// The only quote `BTC_SYMBOL` can convert: dividing any other quote by it gives a number in no real unit.
const BTC_RATE_QUOTE = 'USDT';
const COSTS = {
  base: { commissionBps: 10, slippageBps: 2, spreadBps: 2 },
  stress: { commissionBps: 10, slippageBps: 10, spreadBps: 10 },
} as const;
type CostScenario = keyof typeof COSTS;
const COST_SCENARIOS = Object.keys(COSTS) as CostScenario[];

const DISCLOSURES = [
  'Fixed universe: the study replays one fixed basket chosen today, so symbols that were delisted or never picked are missing.',
  'Flat start: every run starts in cash with no open position.',
  'Terminal mark: positions still open at the end are marked at the end of the window without forced liquidation, so remaining positions and unspent cash are listed.',
  'Worker loss pauses and other worker-side halts are not modelled.',
  'Symbol discovery is not modelled; the basket never changes during a run.',
  'Candle-path uncertainty: only open, high, low and close are known, so the order of prices inside a candle is assumed.',
  'Exchange filters are the ones in the input, not the historical values.',
] as const;

interface StudyMeta {
  readonly fromMs: number;
  readonly toMs: number;
  readonly symbols: readonly string[];
  readonly symbolInfos: readonly SymbolInfo[];
  readonly initialQuoteBalance: string;
  readonly maxConversionStalenessMs: number;
  readonly configs: Readonly<Record<string, Record<string, unknown>>>;
}

interface CandleRow extends Omit<Candle, 'isClosed'> {
  readonly symbol: string;
  readonly interval: string;
}

interface Mark {
  readonly tsMs: number;
  readonly equity: string;
}

type BtcResult =
  | { readonly status: 'ok'; readonly returnPct: number; readonly maxDrawdownPct: number }
  | { readonly status: 'unavailable'; readonly reason: string };

interface PassiveState {
  readonly bought: boolean;
}

interface PassiveAllocation {
  readonly symbol: string;
  readonly budget: string;
  readonly spent: string;
  readonly unspent: string;
  readonly status: 'filled' | 'partial' | 'rejected';
}

interface ControlRow {
  readonly name: string;
  readonly costScenario?: CostScenario;
  readonly totalReturnPct?: number;
  readonly maxDrawdownPct?: number;
  readonly unspentQuote?: string;
  readonly allocations?: readonly PassiveAllocation[];
  readonly btc?: BtcResult;
  readonly status?: 'not-applicable';
  readonly reason?: string;
}

/**
 * Read the study input.
 *
 * @param path - The JSONL file.
 * @returns The meta line, candles keyed `symbol|interval` ascending, and the SHA-256 of the exact bytes.
 */
async function readInput(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const candlesByKey = new Map<string, Candle[]>();
  let meta: StudyMeta | undefined;
  for await (const line of createInterface({ input: createReadStream(path) })) {
    if (line.trim() === '') continue;
    if (meta === undefined) {
      meta = JSON.parse(line) as StudyMeta;
      continue;
    }
    const { symbol, interval, ...candle } = JSON.parse(line) as CandleRow;
    const key = `${symbol}|${interval}`;
    const series = candlesByKey.get(key) ?? [];
    series.push({ ...candle, isClosed: true });
    candlesByKey.set(key, series);
  }
  if (meta === undefined) throw new Error(`study input is empty: ${path}`);
  // A missing or non-numeric bound makes `age > bound` always false, so every stale rate would pass.
  if (!Number.isFinite(meta.maxConversionStalenessMs) || meta.maxConversionStalenessMs < 0) {
    throw new Error('study input needs a non-negative maxConversionStalenessMs');
  }
  for (const series of candlesByKey.values()) series.sort((a, b) => a.openTimeMs - b.openTimeMs);
  return { meta, candlesByKey, sha256: hash.digest('hex') };
}

/**
 * Value each equity mark in BTC. A rate must already have closed at the mark and be recent, so no mark is ever priced from the future.
 *
 * @param marks - Every valuation of the run, oldest first.
 * @param quoteAsset - The asset the equity is in.
 * @param conversion - The closed BTC candles, ascending.
 * @param maxStalenessMs - The oldest rate a mark may use.
 * @returns The BTC return and drawdown, or why they cannot be stated.
 */
function btcResult(
  marks: readonly Mark[],
  quoteAsset: string,
  conversion: readonly Candle[],
  maxStalenessMs: number,
): BtcResult {
  if (marks.length === 0) return { status: 'unavailable', reason: 'the run produced no marks' };
  if (quoteAsset !== 'BTC' && quoteAsset !== BTC_RATE_QUOTE) {
    return { status: 'unavailable', reason: `${BTC_SYMBOL} cannot convert ${quoteAsset}` };
  }
  let cursor = -1;
  let first: Decimal | undefined;
  let peak = new Decimal(0);
  let worst = new Decimal(0);
  let last = new Decimal(0);
  for (const mark of marks) {
    let value = new Decimal(mark.equity);
    if (quoteAsset !== 'BTC') {
      while ((conversion[cursor + 1]?.closeTimeMs ?? Infinity) <= mark.tsMs) cursor += 1;
      const rate = conversion[cursor];
      if (rate === undefined) {
        return { status: 'unavailable', reason: `no BTC rate at or before ${mark.tsMs}` };
      }
      if (mark.tsMs - rate.closeTimeMs > maxStalenessMs) {
        return { status: 'unavailable', reason: `BTC rate is stale at ${mark.tsMs}` };
      }
      value = value.div(rate.close);
    }
    first ??= value;
    last = value;
    if (value.gt(peak)) peak = value;
    const drawdown = peak.minus(value).div(peak).times(100);
    if (drawdown.gt(worst)) worst = drawdown;
  }
  return {
    status: 'ok',
    returnPct: last
      .div(first as Decimal)
      .minus(1)
      .times(100)
      .toNumber(),
    maxDrawdownPct: worst.toNumber(),
  };
}

/**
 * Buys an equal budget of each symbol at its first decision and holds. It goes through the replay so the passive line pays the same costs and filters as the candidates.
 *
 * @param budgetPerSymbol - The quote to spend on each symbol.
 * @returns A strategy for the replay.
 */
function passiveStrategy(budgetPerSymbol: Decimal): AnyStrategy {
  const schema = { parse: (value: unknown) => value };
  return {
    name: 'study-passive',
    version: '1.0.0',
    displayName: 'Passive',
    description: 'Buys once and holds',
    capabilities: {
      candleIntervals: ['1m'],
      needsUserDataStream: false,
      needsMiniTicker: false,
      bundleProviders: [],
      operatorActions: [],
    },
    configSchema: schema,
    overrideConfigSchema: schema,
    stateSchema: schema,
    bundleSchema: schema,
    events: {},
    defaultConfig: {},
    initialState: () => ({ bought: false }),
    tick: (input: TickInput<unknown, PassiveState, Readonly<Record<string, never>>>) => {
      if (input.state.bought) {
        return { nextState: input.state, decisions: [], logs: [], metrics: [] };
      }
      const { symbol, currentPrice, symbolInfo } = input.market;
      const quantity = budgetPerSymbol
        .div(currentPrice)
        .toNearest(symbolInfo.filters.stepSize, Decimal.ROUND_DOWN);
      return {
        nextState: { bought: true },
        decisions: [
          {
            type: 'place-order',
            intent: { symbol, side: 'BUY', reason: 'manual', clientOrderId: `study-${symbol}` },
            params: { type: 'MARKET', quantity: quantity.toFixed() },
          },
        ],
        logs: [],
        metrics: [],
      };
    },
  } as unknown as AnyStrategy;
}

/**
 * Run the study.
 *
 * @param inputPath - The JSONL input.
 * @param command - The exact command line, recorded so the report can be reproduced.
 * @returns The report and its Markdown form.
 */
async function runStudy(inputPath: string, command: string) {
  const { meta, candlesByKey, sha256 } = await readInput(inputPath);
  const strategies = buildStrategyRegistry();
  const conversion = candlesByKey.get(`${BTC_SYMBOL}|${DETAIL_INTERVAL}`) ?? [];
  const infoOf = (symbol: string): SymbolInfo => {
    const info = meta.symbolInfos.find((i) => i.symbol === symbol);
    if (!info) throw new Error(`study input has no exchange filters for ${symbol}`);
    return info;
  };
  // Taken from the symbols a run trades, because `symbolInfos` may also list the conversion pair, whose quote is not what the run is funded in.
  const quoteOf = (symbols: readonly string[]): string => {
    const quotes = [...new Set(symbols.map((symbol) => infoOf(symbol).quoteAsset))];
    if (quotes.length !== 1) {
      throw new Error(`study symbols must share one quote asset, got: ${quotes.join(', ')}`);
    }
    return quotes[0] as string;
  };
  const fundingQuote = quoteOf(meta.symbols);
  const inputFor = (symbols: readonly string[]) =>
    new Map([...candlesByKey].filter(([key]) => symbols.includes(key.split('|')[0] as string)));

  const replay = async (
    strategy: AnyStrategy,
    config: unknown,
    symbols: readonly string[],
    decisionInterval: string,
    costScenario: CostScenario,
  ) => {
    const cost = COSTS[costScenario];
    const marks: Mark[] = [];
    const params: BacktestParams = {
      symbols: [...symbols],
      fromMs: meta.fromMs,
      toMs: meta.toMs,
      strategyInterval: ((config as { candleInterval?: string }).candleInterval ??
        DETAIL_INTERVAL) as never,
      decisionInterval: decisionInterval as never,
      detailInterval: DETAIL_INTERVAL,
      initialQuoteBalance: meta.initialQuoteBalance as never,
      fees: { makerBps: cost.commissionBps, takerBps: cost.commissionBps },
      slippageBps: cost.slippageBps,
      spreadBps: cost.spreadBps,
      volumeCapPct: VOLUME_CAP_PCT,
      discoveryMode: false,
    };
    const { result } = await replayPrepared({
      strategy,
      config,
      params,
      symbolInfos: [...symbols].sort().map(infoOf),
      candlesByKey: inputFor(symbols),
      buildId: 'study',
      onEquityMark: (point) => marks.push({ tsMs: point.tsMs, equity: String(point.equity) }),
    });
    // A series the replay needed but the input lacks makes the run's BTC value unstated, not merely a missing conversion rate.
    const { nativeIntervals, detailInterval } = replayIntervals(config, params);
    const required = [...new Set([detailInterval, ...nativeIntervals])];
    const missing = symbols.flatMap((symbol) =>
      required
        .filter((i) => (candlesByKey.get(`${symbol}|${i}`)?.length ?? 0) === 0)
        .map((i) => `${symbol}|${i}`),
    );
    const btc: BtcResult =
      missing.length > 0
        ? { status: 'unavailable', reason: `missing input series: ${missing.join(', ')}` }
        : btcResult(marks, quoteOf(symbols), conversion, meta.maxConversionStalenessMs);
    return { result, btc };
  };

  const summary = (result: Awaited<ReturnType<typeof replay>>['result']) => {
    const held = new Map<string, Decimal>();
    let turnover = new Decimal(0);
    let fees = new Decimal(0);
    for (const trade of result.trades) {
      const signed = new Decimal(trade.qty).times(trade.side === 'BUY' ? 1 : -1);
      held.set(trade.symbol, (held.get(trade.symbol) ?? new Decimal(0)).plus(signed));
      turnover = turnover.plus(new Decimal(trade.price).times(trade.qty));
      fees = fees.plus(trade.feeQuote);
    }
    return {
      finalBalance: result.metrics.finalBalance,
      totalReturnPct: result.metrics.totalReturnPct,
      maxDrawdownPct: result.metrics.maxDrawdownPct,
      profitFactor: result.metrics.profitFactor,
      trades: result.metrics.totalTrades,
      turnoverQuote: turnover.toFixed(),
      feesQuote: fees.toFixed(),
      remainingPositions: Object.fromEntries(
        [...held]
          .filter(([, qty]) => !qty.isZero())
          .map(([symbol, qty]) => [symbol, qty.toFixed()]),
      ),
      dataWarnings: result.dataWarnings ?? [],
    };
  };

  const configFor = (
    name: string,
    patch: (config: Record<string, unknown>) => object = (c) => c,
  ) => {
    const plugin = strategies.get(name);
    if (!plugin) throw new Error(`strategy is not registered: ${name}`);
    const base = plugin.configSchema.parse(meta.configs[name] ?? {}) as Record<string, unknown>;
    return { plugin, config: plugin.configSchema.parse(patch(base)) };
  };

  const candidates = [];
  for (const decisionInterval of DECISION_INTERVALS) {
    for (const costScenario of COST_SCENARIOS) {
      for (const armAtPercentage of ARM_LEVELS) {
        const { plugin, config } = configFor('trailing-trade', (base) => {
          const sell = base['sell'] as { breakEven: object };
          return {
            ...base,
            sell: { ...sell, breakEven: { ...sell.breakEven, enabled: true, armAtPercentage } },
          };
        });
        const { result, btc } = await replay(
          plugin,
          config,
          meta.symbols,
          decisionInterval,
          costScenario,
        );
        candidates.push({
          strategy: 'trailing-trade',
          armAtPercentage,
          decisionInterval,
          costScenario,
          configHash: configFingerprint(config),
          breakEvenExits: result.trades.filter((t) => t.reason === 'break-even-stop').length,
          ...summary(result),
          btc,
        });
      }
      const { plugin, config } = configFor('momentum');
      const { result, btc } = await replay(
        plugin,
        config,
        meta.symbols,
        decisionInterval,
        costScenario,
      );
      candidates.push({
        strategy: 'momentum',
        decisionInterval,
        costScenario,
        configHash: configFingerprint(config),
        breakEvenExits: 0,
        ...summary(result),
        btc,
      });
    }
  }

  const initial = new Decimal(meta.initialQuoteBalance);
  const cashMarks = (candlesByKey.get(`${meta.symbols[0]}|${DETAIL_INTERVAL}`) ?? [])
    .filter((c) => c.openTimeMs >= meta.fromMs && c.closeTimeMs < meta.toMs)
    .map((c) => ({ tsMs: c.closeTimeMs, equity: initial.toFixed() }));
  const controls: ControlRow[] = [
    {
      name: 'cash',
      totalReturnPct: 0,
      btc: btcResult(cashMarks, fundingQuote, conversion, meta.maxConversionStalenessMs),
    },
    { name: 'zero-pct-btc', btc: { status: 'ok', returnPct: 0, maxDrawdownPct: 0 } },
  ];
  // Budgets are planned against the same opening 99 percent, and a refused or part-filled budget stays visible rather than being respent.
  const buyAndHold = async (
    name: string,
    symbols: readonly string[],
    costScenario: CostScenario,
  ): Promise<ControlRow> => {
    const budget = initial.times(PASSIVE_ALLOCATION).div(symbols.length);
    try {
      const { result, btc } = await replay(
        passiveStrategy(budget),
        {},
        symbols,
        '5m',
        costScenario,
      );
      const allocations = symbols.map((symbol): PassiveAllocation => {
        const buys = result.trades.filter((t) => t.symbol === symbol && t.side === 'BUY');
        const spent = buys.reduce(
          (sum, t) => sum.plus(new Decimal(t.price).times(t.qty)),
          new Decimal(0),
        );
        return {
          symbol,
          budget: budget.toFixed(),
          spent: spent.toFixed(),
          // Slippage and spread can push a fill slightly past its budget, which is not a negative balance left over.
          unspent: Decimal.max(budget.minus(spent), 0).toFixed(),
          status:
            buys.length === 0 ? 'rejected' : spent.lt(budget.times('0.98')) ? 'partial' : 'filled',
        };
      });
      // Buys pay their fee out of quote too, so spent notional alone overstates what is left.
      const buyFees = result.trades
        .filter((t) => t.side === 'BUY')
        .reduce((sum, t) => sum.plus(t.feeQuote), new Decimal(0));
      const unspentQuote = allocations
        .reduce((left, a) => left.minus(a.spent), initial)
        .minus(buyFees)
        .toFixed();
      return { name, costScenario, ...summary(result), unspentQuote, allocations, btc };
    } catch (err) {
      // BTC hold is the one control whose series may legitimately be absent.
      if (name !== 'btc-hold') throw err;
      const reason = err instanceof Error ? err.message : String(err);
      return { name, costScenario, btc: { status: 'unavailable', reason } };
    }
  };
  for (const costScenario of COST_SCENARIOS) {
    controls.push(await buyAndHold('passive-basket', meta.symbols, costScenario));
    // Buying BTCUSDT needs USDT, so another funding asset must not be spent as if it were.
    controls.push(
      fundingQuote === BTC_RATE_QUOTE
        ? await buyAndHold('btc-hold', [BTC_SYMBOL], costScenario)
        : {
            name: 'btc-hold',
            costScenario,
            status: 'not-applicable',
            reason: `${BTC_SYMBOL} is bought with ${BTC_RATE_QUOTE}, and this run is funded in ${fundingQuote}`,
          },
    );
  }

  // The same hash a real run stores as `config_fingerprint`, so a study row can be matched to one.
  const configHashes = Object.fromEntries(
    Object.keys(meta.configs).map((name) => [name, configFingerprint(configFor(name).config)]),
  );
  const report = {
    input: { path: inputPath, sha256 },
    command,
    window: { fromMs: meta.fromMs, toMs: meta.toMs },
    symbols: meta.symbols,
    fundingQuote,
    initialQuoteBalance: meta.initialQuoteBalance,
    configs: meta.configs,
    configHashes,
    costs: COSTS,
    volumeCapPct: VOLUME_CAP_PCT,
    controls,
    candidates,
    disclosures: DISCLOSURES,
  };
  const btcCell = (btc: BtcResult | undefined): string => {
    if (btc === undefined) return '-';
    return btc.status === 'ok'
      ? `${btc.returnPct.toFixed(2)}% / ${btc.maxDrawdownPct.toFixed(2)}%`
      : `unavailable: ${btc.reason}`;
  };
  const pctCell = (value: number | undefined): string =>
    value === undefined ? '-' : value.toFixed(2);
  const utc = (ms: number): string => new Date(ms).toISOString();
  const markdown = [
    '# Break-even arm study',
    '',
    `Input SHA-256: \`${sha256}\``,
    '',
    `Command: \`${command}\``,
    '',
    '## Window',
    '',
    `${utc(meta.fromMs)} to ${utc(meta.toMs)}, end excluded (\`${meta.fromMs}\` to \`${meta.toMs}\` ms).`,
    '',
    `Symbols: ${meta.symbols.join(', ')}. Funding: ${meta.initialQuoteBalance} ${fundingQuote}.`,
    '',
    '## Cost assumptions',
    '',
    '| Scenario | Commission bps | Slippage bps | Spread bps |',
    '| --- | --- | --- | --- |',
    ...COST_SCENARIOS.map(
      (name) =>
        `| ${name} | ${COSTS[name].commissionBps} | ${COSTS[name].slippageBps} | ${COSTS[name].spreadBps} |`,
    ),
    '',
    `Volume cap: ${VOLUME_CAP_PCT}% of each detail candle's volume.`,
    '',
    '## Configs',
    '',
    '| Strategy | Location in the JSON report | Hash |',
    '| --- | --- | --- |',
    ...Object.entries(configHashes).map(
      ([name, hash]) => `| ${name} | \`configs["${name}"]\` | \`${hash}\` |`,
    ),
    '',
    'Each trailing-trade candidate sets `sell.breakEven.enabled` and `armAtPercentage` on that config. Every candidate in the JSON report carries the `configHash` of the config it ran.',
    '',
    '## Controls',
    '',
    '| Control | Cost | Return % | Max drawdown % | BTC return / drawdown | Note |',
    '| --- | --- | --- | --- | --- | --- |',
    ...controls.map(
      (c) =>
        `| ${c.name} | ${c.costScenario ?? '-'} | ${pctCell(c.totalReturnPct)} | ${pctCell(c.maxDrawdownPct)} | ${btcCell(c.btc)} | ${c.status === 'not-applicable' ? `not applicable: ${c.reason}` : c.unspentQuote === undefined ? '-' : `unspent ${c.unspentQuote}`} |`,
    ),
    '',
    '### Passive allocations',
    '',
    '| Control | Cost | Symbol | Budget | Spent | Unspent | Status |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...controls.flatMap((c) =>
      (c.allocations ?? []).map(
        (a) =>
          `| ${c.name} | ${c.costScenario} | ${a.symbol} | ${a.budget} | ${a.spent} | ${a.unspent} | ${a.status} |`,
      ),
    ),
    '',
    '## Candidates',
    '',
    '| Strategy | Arm | Decision | Cost | Return % | Max drawdown % | Trades | Break-even exits | BTC return / drawdown |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...candidates.map(
      (c) =>
        `| ${c.strategy} | ${'armAtPercentage' in c ? c.armAtPercentage : '-'} | ${c.decisionInterval} | ${c.costScenario} | ${c.totalReturnPct.toFixed(2)} | ${c.maxDrawdownPct.toFixed(2)} | ${c.trades} | ${c.breakEvenExits} | ${btcCell(c.btc)} |`,
    ),
    '',
    '## Limits of this study',
    '',
    ...DISCLOSURES.map((line) => `- ${line}`),
    '',
  ].join('\n');
  return { report, markdown };
}

const option = (name: string): string => {
  const at = argv.indexOf(name);
  const value = at === -1 ? undefined : argv[at + 1];
  if (value === undefined) throw new Error(`missing required option ${name}`);
  return value;
};

if (import.meta.main) {
  try {
    const { report, markdown } = await runStudy(
      option('--input'),
      `bun scripts/backtest-study.ts ${argv
        .slice(2)
        .map((a) => (/^[\w./=:@-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`))
        .join(' ')}`,
    );
    writeFileSync(option('--out-json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(option('--out-md'), markdown);
  } catch (err) {
    stderr.write(`backtest-study: ${err instanceof Error ? err.message : String(err)}\n`);
    exit(1);
  }
}
