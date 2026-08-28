import { describe, expect, it } from 'vitest';
import {
  type BacktestParams,
  BacktestCreatedSchema,
  BacktestListItemSchema,
  BacktestParamsSchema,
  BacktestResultSchema,
  BacktestRunDetailSchema,
  BacktestRunStatusSchema,
  coerceImproveConfigModelShape,
  type ConfigSuggestion,
  marketOf,
  mergeImproveResponses,
  parseImproveConfigModelOutput,
  recommendTradeOrHold,
  sameMarket,
  tokenizePath,
} from '../src/backtest.js';
import { asDecimalString } from '../src/decimal.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';

const validParams = {
  symbols: ['BTCUSDT'],
  fromMs: 1_000,
  toMs: 2_000,
  strategyInterval: '1h',
  detailInterval: '5m',
  initialQuoteBalance: '1000',
  fees: { makerBps: 10, takerBps: 10 },
  slippageBps: 5,
};

describe('BacktestParamsSchema', () => {
  it('accepts a well-formed request', () => {
    expect(BacktestParamsSchema.safeParse(validParams).success).toBe(true);
  });

  it('accepts an optional strategyConfigOverride', () => {
    const r = BacktestParamsSchema.safeParse({
      ...validParams,
      strategyConfigOverride: { buy: { enabled: false } },
    });
    expect(r.success).toBe(true);
  });

  it('accepts a null strategyConfigOverride (external clients send null for "none")', () => {
    expect(
      BacktestParamsSchema.safeParse({ ...validParams, strategyConfigOverride: null }).success,
    ).toBe(true);
  });

  it('accepts an optional parentRunId (the run a Re-run forked from)', () => {
    expect(BacktestParamsSchema.safeParse({ ...validParams, parentRunId: UUID }).success).toBe(
      true,
    );
  });

  it('accepts a null parentRunId (no parent)', () => {
    expect(BacktestParamsSchema.safeParse({ ...validParams, parentRunId: null }).success).toBe(
      true,
    );
  });

  it('rejects a non-uuid parentRunId', () => {
    expect(
      BacktestParamsSchema.safeParse({ ...validParams, parentRunId: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('rejects fromMs >= toMs', () => {
    expect(
      BacktestParamsSchema.safeParse({ ...validParams, fromMs: 2_000, toMs: 2_000 }).success,
    ).toBe(false);
  });

  it('rejects an empty symbols list', () => {
    expect(BacktestParamsSchema.safeParse({ ...validParams, symbols: [] }).success).toBe(false);
  });

  it('rejects a detail interval coarser than the strategy interval', () => {
    const r = BacktestParamsSchema.safeParse({
      ...validParams,
      strategyInterval: '5m',
      detailInterval: '1h',
    });
    expect(r.success).toBe(false);
  });

  it('accepts detail interval equal to strategy interval', () => {
    const r = BacktestParamsSchema.safeParse({
      ...validParams,
      strategyInterval: '1h',
      detailInterval: '1h',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a non-positive initial balance', () => {
    expect(
      BacktestParamsSchema.safeParse({ ...validParams, initialQuoteBalance: '0' }).success,
    ).toBe(false);
  });

  it('rejects an unknown interval', () => {
    expect(BacktestParamsSchema.safeParse({ ...validParams, strategyInterval: '1M' }).success).toBe(
      false,
    );
  });
});

describe('BacktestRunStatusSchema', () => {
  it('parses a queued run', () => {
    const r = BacktestRunStatusSchema.safeParse({
      runId: UUID,
      profileId: UUID,
      status: 'queued',
      progress: 0,
      createdAt: '2026-05-29T00:00:00.000Z',
    });
    expect(r.success).toBe(true);
  });

  it('parses a running run carrying replay progress detail', () => {
    const r = BacktestRunStatusSchema.safeParse({
      runId: UUID,
      profileId: UUID,
      status: 'running',
      progress: 30,
      progressDetail: { phase: 'replay', processed: 300, total: 1000 },
      createdAt: '2026-05-29T00:00:00.000Z',
    });
    expect(r.success).toBe(true);
  });

  it('rejects progress out of [0,100]', () => {
    const r = BacktestRunStatusSchema.safeParse({
      runId: UUID,
      profileId: UUID,
      status: 'running',
      progress: 101,
      createdAt: '2026-05-29T00:00:00.000Z',
    });
    expect(r.success).toBe(false);
  });
});

describe('BacktestResultSchema', () => {
  it('round-trips a minimal done result', () => {
    const result = {
      params: validParams,
      metrics: {
        startingBalance: '1000',
        finalBalance: '1100',
        absoluteProfit: '100',
        totalReturnPct: 10,
        cagrPct: 12.3,
        marketChangePct: 5,
        dcaChangePct: 4,
        alphaVsHoldPct: 5,
        alphaVsDcaPct: 6,
        sharpe: 1.2,
        sortino: 1.5,
        calmar: 0.9,
        sqn: 2.1,
        maxDrawdownPct: -8.4,
        absoluteDrawdown: '84',
        drawdownStartMs: 1_500,
        drawdownEndMs: 1_800,
        totalTrades: 3,
        winRate: 66.6,
        wins: 2,
        losses: 1,
        profitFactor: 2.0,
        expectancy: '33.3',
        bestTradePct: 4.2,
        worstTradePct: -1.1,
        avgTradePnl: '33.3',
        avgTradeDurationMs: 3_600_000,
      },
      equityCurve: [{ tsMs: 1_000, equity: '1000' }],
      drawdownSeries: [{ tsMs: 1_000, ddPct: 0 }],
      trades: [
        {
          symbol: 'BTCUSDT',
          side: 'BUY',
          reason: 'grid-buy',
          price: '100',
          qty: '1',
          feeQuote: '0.1',
          tsMs: 1_000,
        },
      ],
      perSymbol: [{ symbol: 'BTCUSDT', tradeCount: 3, pnlQuote: '100' }],
    };
    expect(BacktestResultSchema.safeParse(result).success).toBe(true);
  });

  it('allows nullable profitFactor / drawdown bounds for a zero-trade run', () => {
    const r = BacktestResultSchema.safeParse({
      params: validParams,
      metrics: {
        startingBalance: '1000',
        finalBalance: '1000',
        absoluteProfit: '0',
        totalReturnPct: 0,
        cagrPct: 0,
        marketChangePct: 0,
        dcaChangePct: 0,
        alphaVsHoldPct: 0,
        alphaVsDcaPct: 0,
        sharpe: 0,
        sortino: 0,
        calmar: 0,
        sqn: 0,
        maxDrawdownPct: 0,
        absoluteDrawdown: '0',
        drawdownStartMs: null,
        drawdownEndMs: null,
        totalTrades: 0,
        winRate: 0,
        wins: 0,
        losses: 0,
        profitFactor: null,
        expectancy: '0',
        bestTradePct: null,
        worstTradePct: null,
        avgTradePnl: '0',
        avgTradeDurationMs: null,
      },
      equityCurve: [],
      drawdownSeries: [],
      trades: [],
      perSymbol: [],
    });
    expect(r.success).toBe(true);
  });
});

describe('recommendTradeOrHold', () => {
  it('recommends holding when the strategy lost to buy-and-hold', () => {
    const r = recommendTradeOrHold({ alphaVsHoldPct: -2.5, totalTrades: 10 });
    expect(r.recommend).toBe('hold');
    expect(r.reason).toContain('2.50%');
  });

  it('recommends trading at exactly zero alpha (a tie clears the gate floor)', () => {
    expect(recommendTradeOrHold({ alphaVsHoldPct: 0, totalTrades: 10 }).recommend).toBe('trade');
  });

  it('recommends trading when alpha over hold is positive', () => {
    const r = recommendTradeOrHold({ alphaVsHoldPct: 3.2, totalTrades: 10 });
    expect(r.recommend).toBe('trade');
    expect(r.reason).toContain('3.20%');
  });

  it('recommends holding a zero-trade run even when its alpha is positive', () => {
    // Cash beating a falling market produces positive alpha with no trades; it
    // is not a repeatable edge, so the verdict must be hold, not trade (#534).
    const r = recommendTradeOrHold({ alphaVsHoldPct: 10.75, totalTrades: 0 });
    expect(r.recommend).toBe('hold');
    expect(r.reason).toContain('no trades');
  });
});

describe('tokenizePath', () => {
  it('splits a plain dotted path', () => {
    expect(tokenizePath('buy.accountCap.percent')).toEqual(['buy', 'accountCap', 'percent']);
  });

  it('turns a bracketed array index into its own numeric segment', () => {
    expect(tokenizePath('technicals.intervals[2].whenNeutral')).toEqual([
      'technicals',
      'intervals',
      '2',
      'whenNeutral',
    ]);
  });

  it('handles consecutive indices and a leading index', () => {
    expect(tokenizePath('grid[0][1].price')).toEqual(['grid', '0', '1', 'price']);
    expect(tokenizePath('[0].interval')).toEqual(['0', 'interval']);
  });

  it('keeps a trailing index as the last segment', () => {
    expect(tokenizePath('technicals.intervals[2]')).toEqual(['technicals', 'intervals', '2']);
  });

  it('leaves a non-numeric bracket as one literal segment (only numeric brackets are indices)', () => {
    expect(tokenizePath('a[foo].b')).toEqual(['a[foo]', 'b']);
  });

  it('leaves a single key untouched', () => {
    expect(tokenizePath('candleInterval')).toEqual(['candleInterval']);
  });
});

describe('BacktestCreatedSchema', () => {
  it('carries a deduped flag, defaulting to false when omitted (a fresh enqueue)', () => {
    // A normal create response predates the dedup flag, so the schema must
    // default `deduped` to false rather than leave it undefined — the route
    // reads it to decide between "queued a fresh run" and "showing an existing".
    const parsed = BacktestCreatedSchema.parse({ runId: UUID });
    expect(parsed.deduped).toBe(false);
  });

  it('accepts deduped: true (the create matched an existing completed run)', () => {
    const parsed = BacktestCreatedSchema.parse({ runId: UUID, deduped: true });
    expect(parsed.deduped).toBe(true);
  });

  // Only a launch that could not be fully checked sets the advisories, so the
  // field has to stay optional or every clean launch response throws.
  it('omits the save diagnostics when the response carries none', () => {
    expect(BacktestCreatedSchema.parse({ runId: UUID })).not.toHaveProperty('diagnostics');
  });

  it('round-trips the findings a launch attaches', () => {
    const diagnostics = [
      { level: 'warn' as const, code: 'config-unverified', message: 'Settings unreadable.' },
    ];
    expect(BacktestCreatedSchema.parse({ runId: UUID, diagnostics }).diagnostics).toEqual(
      diagnostics,
    );
  });
});

describe('BacktestListItemSchema', () => {
  it('parses a list row with a null return for an unfinished run', () => {
    const r = BacktestListItemSchema.safeParse({
      runId: UUID,
      status: 'running',
      progress: 40,
      symbols: ['BTCUSDT'],
      createdAt: '2026-05-29T00:00:00.000Z',
      fromMs: 1_000,
      toMs: 2_000,
      totalReturnPct: null,
    });
    expect(r.success).toBe(true);
  });

  it('carries no resolved config, so the list stays a list', () => {
    // The config comparison fetches both runs by id on demand. Widening this projection to carry a full merged strategy config per row would put one blob per past run into every page of history, on the one screen an operator scrolls, to answer a question they ask about two rows at a time. The key set is pinned whole rather than by absence alone, so a differently-named config field cannot slip past.
    expect(Object.keys(BacktestListItemSchema.shape).sort()).toEqual([
      'configFingerprint',
      'createdAt',
      'finishedAt',
      'fromMs',
      'progress',
      'runId',
      'status',
      'symbols',
      'toMs',
      'totalReturnPct',
    ]);
  });
});

describe('BacktestRunDetailSchema', () => {
  const baseDetail = {
    runId: UUID,
    profileId: UUID,
    status: 'done',
    progress: 100,
    createdAt: '2026-05-29T00:00:00.000Z',
    params: validParams,
    result: null,
  };

  it('exposes parentRunId, defaulting to null when absent (rows predating the column)', () => {
    const parsed = BacktestRunDetailSchema.parse(baseDetail);
    expect(parsed.parentRunId).toBeNull();
  });

  it('carries a set parentRunId (the run a Re-run forked from)', () => {
    const parsed = BacktestRunDetailSchema.parse({ ...baseDetail, parentRunId: PARENT });
    expect(parsed.parentRunId).toBe(PARENT);
  });
});

describe('sameMarket', () => {
  // Every market dim set so each can be mutated independently below.
  const baseMarket: BacktestParams = {
    symbols: ['BTCUSDT', 'ETHUSDT'],
    fromMs: 1_000,
    toMs: 5_000,
    strategyInterval: '1h',
    detailInterval: '5m',
    initialQuoteBalance: asDecimalString('1000'),
    fees: { makerBps: 10, takerBps: 12 },
    slippageBps: 5,
    spreadBps: 4,
    volumeCapPct: 25,
    discoveryMode: false,
  };

  it('is true for two params equal on every market dim', () => {
    expect(sameMarket(baseMarket, { ...baseMarket })).toBe(true);
  });

  it('is true when symbols differ only in order (order-insensitive)', () => {
    expect(sameMarket(baseMarket, { ...baseMarket, symbols: ['ETHUSDT', 'BTCUSDT'] })).toBe(true);
  });

  it('is independent of strategyConfigOverride (a differing override is still the same market)', () => {
    expect(
      sameMarket(
        { ...baseMarket, strategyConfigOverride: { buy: { enabled: true } } },
        { ...baseMarket, strategyConfigOverride: { buy: { enabled: false } } },
      ),
    ).toBe(true);
  });

  // Drift guard: each entry mutates exactly one market dim, after which sameMarket
  // must be false. The enumerated set IS the contract — adding or removing a
  // market dim without also updating this list (and sameMarket) deliberately
  // breaks one of the assertions below.
  const MARKET_DIM_MUTATIONS: {
    dim: string;
    mutate: (p: BacktestParams) => BacktestParams;
  }[] = [
    { dim: 'symbols', mutate: (p) => ({ ...p, symbols: ['XRPUSDT'] }) },
    { dim: 'fromMs', mutate: (p) => ({ ...p, fromMs: p.fromMs + 1 }) },
    { dim: 'toMs', mutate: (p) => ({ ...p, toMs: p.toMs + 1 }) },
    { dim: 'strategyInterval', mutate: (p) => ({ ...p, strategyInterval: '4h' }) },
    { dim: 'detailInterval', mutate: (p) => ({ ...p, detailInterval: '15m' }) },
    {
      dim: 'fees.makerBps',
      mutate: (p) => ({ ...p, fees: { ...p.fees, makerBps: p.fees.makerBps + 1 } }),
    },
    {
      dim: 'fees.takerBps',
      mutate: (p) => ({ ...p, fees: { ...p.fees, takerBps: p.fees.takerBps + 1 } }),
    },
    { dim: 'slippageBps', mutate: (p) => ({ ...p, slippageBps: p.slippageBps + 1 }) },
    { dim: 'spreadBps', mutate: (p) => ({ ...p, spreadBps: (p.spreadBps ?? 0) + 1 }) },
    { dim: 'volumeCapPct', mutate: (p) => ({ ...p, volumeCapPct: (p.volumeCapPct ?? 0) + 1 }) },
    { dim: 'discoveryMode', mutate: (p) => ({ ...p, discoveryMode: !p.discoveryMode }) },
    {
      dim: 'initialQuoteBalance',
      mutate: (p) => ({ ...p, initialQuoteBalance: asDecimalString('2000') }),
    },
  ];

  it('enumerates exactly the 12 market dims (drift guard)', () => {
    expect(MARKET_DIM_MUTATIONS.map((d) => d.dim)).toEqual([
      'symbols',
      'fromMs',
      'toMs',
      'strategyInterval',
      'detailInterval',
      'fees.makerBps',
      'fees.takerBps',
      'slippageBps',
      'spreadBps',
      'volumeCapPct',
      'discoveryMode',
      'initialQuoteBalance',
    ]);
  });

  it.each(MARKET_DIM_MUTATIONS)('is false when $dim differs', ({ mutate }) => {
    expect(sameMarket(baseMarket, mutate(baseMarket))).toBe(false);
  });
});

describe('marketOf', () => {
  const params: BacktestParams = {
    symbols: ['ETHUSDT', 'BTCUSDT'],
    fromMs: 1_000,
    toMs: 5_000,
    strategyInterval: '1h',
    detailInterval: '5m',
    initialQuoteBalance: asDecimalString('1000'),
    fees: { makerBps: 10, takerBps: 12 },
    slippageBps: 5,
    spreadBps: 4,
    volumeCapPct: 25,
    discoveryMode: false,
  };

  // Drift guard: marketOf IS the single enumeration of the market dims. Adding or
  // removing a dim without updating this list breaks the assertion.
  it('enumerates exactly the 12 flat market dims (drift guard)', () => {
    expect(Object.keys(marketOf(params))).toEqual([
      'symbols',
      'fromMs',
      'toMs',
      'strategyInterval',
      'detailInterval',
      'makerBps',
      'takerBps',
      'slippageBps',
      'spreadBps',
      'volumeCapPct',
      'discoveryMode',
      'initialQuoteBalance',
    ]);
  });

  it('unwraps fees to top-level makerBps/takerBps', () => {
    const m = marketOf(params);
    expect(m.makerBps).toBe(10);
    expect(m.takerBps).toBe(12);
  });

  it('sorts symbols so order does not matter', () => {
    expect(marketOf(params).symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(marketOf({ ...params, symbols: ['BTCUSDT', 'ETHUSDT'] })).toEqual(
      marketOf({ ...params, symbols: ['ETHUSDT', 'BTCUSDT'] }),
    );
  });

  it('collapses absent and explicit-null spreadBps/volumeCapPct to null', () => {
    const absent = marketOf({ ...params, spreadBps: undefined, volumeCapPct: undefined });
    const explicitNull = marketOf({ ...params, spreadBps: null, volumeCapPct: null });
    expect(absent.spreadBps).toBeNull();
    expect(absent.volumeCapPct).toBeNull();
    expect(absent).toEqual(explicitNull);
  });

  it('keeps initialQuoteBalance a decimal-string (never coerced to number)', () => {
    expect(typeof marketOf(params).initialQuoteBalance).toBe('string');
    expect(marketOf(params).initialQuoteBalance).toBe('1000');
  });
});

// A well-formed suggestion the model is meant to emit.
const goodSuggestion = {
  id: 'shorten-cooldown',
  title: 'Shorten the force-sell cooldown',
  rationale: 'It blocked most ticks.',
  changes: [{ path: 'sell.cooldownBars', value: 5 }],
  expectedEffect: 'More exits.',
  overfitRisk: 'low' as const,
};

describe('coerceImproveConfigModelShape', () => {
  it('leaves a well-formed object untouched', () => {
    const input = { summary: 'ok', suggestions: [goodSuggestion] };
    expect(coerceImproveConfigModelShape(input)).toEqual(input);
  });

  it('parses a suggestions field serialized as a JSON-array string', () => {
    const out = coerceImproveConfigModelShape({
      summary: 'ok',
      suggestions: JSON.stringify([goodSuggestion]),
    }) as { suggestions: unknown };
    expect(out.suggestions).toEqual([goodSuggestion]);
  });

  it('lifts a whole {summary,suggestions} object stuffed into the suggestions string', () => {
    const out = coerceImproveConfigModelShape({
      // summary absent at top level; it lives inside the stuffed string.
      suggestions: JSON.stringify({ summary: 'inner', suggestions: [goodSuggestion] }),
    }) as { summary: unknown; suggestions: unknown };
    expect(out.summary).toBe('inner');
    expect(out.suggestions).toEqual([goodSuggestion]);
  });

  it('defaults a missing summary to an empty string', () => {
    const out = coerceImproveConfigModelShape({ suggestions: [] }) as { summary: unknown };
    expect(out.summary).toBe('');
  });

  it('passes a non-object through unchanged', () => {
    expect(coerceImproveConfigModelShape(null)).toBe(null);
    expect(coerceImproveConfigModelShape('nope')).toBe('nope');
  });
});

describe('parseImproveConfigModelOutput', () => {
  it('keeps well-formed suggestions and defaults a missing summary', () => {
    const out = parseImproveConfigModelOutput({ suggestions: [goodSuggestion] });
    expect(out.summary).toBe('');
    expect(out.suggestions).toEqual([goodSuggestion]);
  });

  it('drops a malformed suggestion (empty changes) but keeps the valid ones', () => {
    const out = parseImproveConfigModelOutput({
      summary: 'mixed',
      suggestions: [goodSuggestion, { ...goodSuggestion, id: 'bad', changes: [] }],
    });
    expect(out.suggestions).toHaveLength(1);
    expect(out.suggestions[0]?.id).toBe('shorten-cooldown');
  });

  it('recovers suggestions from a string-serialized array', () => {
    const out = parseImproveConfigModelOutput({
      summary: 'ok',
      suggestions: JSON.stringify([goodSuggestion]),
    });
    expect(out.suggestions).toEqual([goodSuggestion]);
  });

  it('yields an empty result (no throw) for unrecoverable garbage', () => {
    const out = parseImproveConfigModelOutput({ suggestions: 'not json at all' });
    expect(out).toEqual({ summary: '', suggestions: [] });
  });
});

describe('mergeImproveResponses', () => {
  const sug = (id: string, path: string, value: string): ConfigSuggestion => ({
    id,
    title: id,
    rationale: 'r',
    changes: [{ path, value }],
    expectedEffect: 'e',
    overfitRisk: 'medium',
  });

  it('drops exact-duplicate edits across samples and keeps the first non-empty summary', () => {
    const a = { summary: 'A', suggestions: [sug('x', 'p', '1')] };
    const b = { summary: 'B', suggestions: [sug('y', 'p', '1')] }; // same edit, different id
    const out = mergeImproveResponses([a, b]);
    expect(out.suggestions).toHaveLength(1);
    expect(out.summary).toBe('A');
  });

  it('keeps distinct edits and suffixes a colliding id as `${id}-2`', () => {
    const a = { summary: '', suggestions: [sug('dup', 'p', '1')] };
    const b = { summary: 'B', suggestions: [sug('dup', 'q', '2')] }; // same id, different edit
    const out = mergeImproveResponses([a, b]);
    expect(out.suggestions).toHaveLength(2);
    expect(out.suggestions.map((s) => s.id)).toEqual(['dup', 'dup-2']);
    expect(out.summary).toBe('B'); // skips the empty summary
  });

  it('prefers a summary from a sample that contributed suggestions', () => {
    const held = { summary: 'No change beats holding.', suggestions: [] };
    const idea = { summary: 'Try loosening the stop.', suggestions: [sug('x', 'p', '1')] };
    // The held-only sample comes first, but its summary would misdescribe the card.
    expect(mergeImproveResponses([held, idea]).summary).toBe('Try loosening the stop.');
  });

  it('returns an empty result for empty input', () => {
    expect(mergeImproveResponses([])).toEqual({ summary: '', suggestions: [] });
  });
});
