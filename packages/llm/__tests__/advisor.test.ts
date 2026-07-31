import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BacktestResultSchema, type BacktestResult, type ConfigSuggestion } from '@app/contracts';
import type { ImproveConfigInput, LlmAssist } from '../src/llm.js';
import {
  AdvisorConfigStaleError,
  applyConfigPatches,
  buildImproveInput,
  CURVE_SAMPLE,
  describeSchemaFailure,
  downsample,
  exitReasonCounts,
  partitionSuggestions,
  runAdvisor,
} from '../src/advisor.js';

const suggestion = (changes: ConfigSuggestion['changes']): ConfigSuggestion => ({
  id: 's1',
  title: 't',
  rationale: 'r',
  changes,
  expectedEffect: 'e',
  overfitRisk: 'low',
});

describe('applyConfigPatches', () => {
  it('sets a dotted leaf on a clone, leaving the base untouched', () => {
    const base = { a: { b: 1 } };
    const next = applyConfigPatches(base, [{ path: 'a.b', value: 2 }]);
    expect(next).toEqual({ a: { b: 2 } });
    expect(base).toEqual({ a: { b: 1 } });
  });

  it('resolves a bracketed array-index path to the real element', () => {
    const base = { grid: [{ trigger: 0.1 }, { trigger: 0.2 }] };
    const next = applyConfigPatches(base, [{ path: 'grid[1].trigger', value: 0.5 }]);
    expect((next.grid as { trigger: number }[])[1]?.trigger).toBe(0.5);
    expect((next.grid as { trigger: number }[])[0]?.trigger).toBe(0.1);
  });

  it('refuses a prototype-polluting path (no global pollution)', () => {
    applyConfigPatches({}, [{ path: '__proto__.polluted', value: true }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('downsample', () => {
  it('returns the array unchanged when it is at or under the target size', () => {
    expect(downsample([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it('caps a long series to n points keeping first and last', () => {
    const arr = Array.from({ length: 1000 }, (_, i) => i);
    const out = downsample(arr, 80);
    expect(out).toHaveLength(80);
    expect(out[0]).toBe(0);
    expect(out.at(-1)).toBe(999);
  });
});

describe('exitReasonCounts', () => {
  it('counts SELL reasons only, ignoring BUYs', () => {
    const counts = exitReasonCounts([
      { side: 'BUY', reason: 'grid-buy' },
      { side: 'SELL', reason: 'trailing-stop' },
      { side: 'SELL', reason: 'trailing-stop' },
      { side: 'SELL', reason: 'technicals-force-sell' },
    ] as unknown as Parameters<typeof exitReasonCounts>[0]);
    expect(counts).toEqual({ 'trailing-stop': 2, 'technicals-force-sell': 1 });
  });
});

describe('describeSchemaFailure', () => {
  it('renders the first issue as `field.path: message`', () => {
    const err = z.object({ a: z.number() }).safeParse({ a: 'x' });
    expect(err.success).toBe(false);
    if (!err.success) expect(describeSchemaFailure(err.error)).toMatch(/^a: /);
  });
});

describe('partitionSuggestions', () => {
  const schema = z.object({ trigger: z.number().max(1) });

  it('offers schema-valid patches and drops out-of-bounds ones with a reason', () => {
    const res = partitionSuggestions(schema, { trigger: 0.1 }, [
      { ...suggestion([{ path: 'trigger', value: 0.5 }]), id: 'ok' },
      { ...suggestion([{ path: 'trigger', value: 9 }]), id: 'bad' },
    ]);
    expect(res.valid.map((s) => s.id)).toEqual(['ok']);
    expect(res.dropped.map((s) => s.id)).toEqual(['bad']);
    expect(res.dropped[0]?.reason).toMatch(/trigger/);
  });
});

// A fake assist that records the modes it was asked for and returns a scripted
// response (or throws) per call, so runAdvisor's sampling/merge is testable
// without a network.
const fakeLlm = (
  impl: (input: ImproveConfigInput, mode: string) => Promise<{ summary: string; suggestions: [] }>,
): LlmAssist => ({
  available: true,
  improveConfig: (input, mode) => impl(input, mode),
});

const input: ImproveConfigInput = {
  strategyName: 's',
  strategyVersion: '1',
  configSchema: {},
  context: {},
};

describe('runAdvisor', () => {
  it('calls the model once for the safe variant', async () => {
    const seen: string[] = [];
    const llm = fakeLlm(async (_i, mode) => {
      seen.push(mode);
      return { summary: 'safe-read', suggestions: [] };
    });
    const res = await runAdvisor(llm, input, 'safe');
    expect(seen).toEqual(['safe']);
    expect(res.summary).toBe('safe-read');
  });

  it('samples an EXPLORE variant twice and merges', async () => {
    const seen: string[] = [];
    const llm = fakeLlm(async (_i, mode) => {
      seen.push(mode);
      return { summary: 'bold', suggestions: [] };
    });
    await runAdvisor(llm, input, 'aggressive');
    expect(seen).toEqual(['aggressive', 'aggressive']);
  });

  it('returns the surviving sample when one of a variant’s samples fails', async () => {
    let calls = 0;
    const llm = fakeLlm(async () => {
      calls += 1;
      if (calls === 1) throw new Error('rate limited');
      return { summary: 'survived', suggestions: [] };
    });
    const res = await runAdvisor(llm, input, 'aggressive');
    expect(res.summary).toBe('survived');
  });

  it('throws the first reason when every sample fails', async () => {
    const llm = fakeLlm(async () => {
      throw new Error('boom');
    });
    await expect(runAdvisor(llm, input, 'aggressive')).rejects.toThrow('boom');
  });
});

// A schema-valid finished run. Money fields are decimal-strings; the params are a
// full BacktestParams so `BacktestParamsSchema.safeParse` succeeds and fillRealism
// is populated.
const validResult = (): BacktestResult =>
  BacktestResultSchema.parse({
    params: {
      symbols: ['BTCUSDT'],
      fromMs: 1_000,
      toMs: 2_000,
      strategyInterval: '1h',
      detailInterval: '5m',
      initialQuoteBalance: '1000',
      fees: { makerBps: 10, takerBps: 10 },
      slippageBps: 5,
      strategyConfigOverride: null,
    },
    metrics: {
      startingBalance: '1000',
      finalBalance: '1100',
      absoluteProfit: '100',
      totalReturnPct: 10,
      cagrPct: 12,
      marketChangePct: 5,
      dcaChangePct: 4,
      alphaVsHoldPct: 5,
      alphaVsDcaPct: 6,
      sharpe: 1.2,
      sortino: 1.4,
      calmar: 2,
      sqn: 1.1,
      maxDrawdownPct: -8,
      absoluteDrawdown: '80',
      drawdownStartMs: 1_100,
      drawdownEndMs: 1_400,
      totalTrades: 10,
      winRate: 0.6,
      wins: 6,
      losses: 4,
      profitFactor: 1.5,
      expectancy: '10',
      bestTradePct: 4,
      worstTradePct: -3,
      avgTradePnl: '10',
      avgTradeDurationMs: 3_600_000,
    },
    equityCurve: Array.from({ length: 500 }, (_, i) => ({ tsMs: i, equity: '1000' })),
    drawdownSeries: Array.from({ length: 500 }, (_, i) => ({ tsMs: i, ddPct: -1 })),
    trades: [
      {
        symbol: 'BTCUSDT',
        side: 'BUY',
        reason: 'grid-buy',
        price: '1',
        qty: '1',
        feeQuote: '0',
        tsMs: 1,
      },
      {
        symbol: 'BTCUSDT',
        side: 'SELL',
        reason: 'trailing-stop',
        price: '2',
        qty: '1',
        feeQuote: '0',
        tsMs: 2,
      },
      {
        symbol: 'BTCUSDT',
        side: 'SELL',
        reason: 'trailing-stop',
        price: '2',
        qty: '1',
        feeQuote: '0',
        tsMs: 3,
      },
    ],
    perSymbol: [{ symbol: 'BTCUSDT', tradeCount: 3, pnlQuote: '100' }],
  });

const configSchema = z.object({ candleInterval: z.string(), maxPurchaseAmount: z.number() });
const profileConfig = { candleInterval: '1h', maxPurchaseAmount: 100 };
const policy = {} as Parameters<typeof buildImproveInput>[0]['policy'];

describe('buildImproveInput', () => {
  it('composes the base config, the schema doc, and the run context', () => {
    const priorRuns = { total: 2, sample: [{ config: {}, metrics: { totalReturnPct: 1 } }] };
    const { baseConfig, input: built } = buildImproveInput({
      strategyName: 'trailing-trade',
      strategyVersion: '1.2.3',
      configSchema,
      configSchemaDoc: { type: 'object', properties: { candleInterval: {} } },
      profileConfig,
      result: validResult(),
      priorRuns,
      policy,
    });
    expect(baseConfig).toEqual(profileConfig);
    expect(built.strategyName).toBe('trailing-trade');
    expect(built.strategyVersion).toBe('1.2.3');
    const ctx = built.context as Record<string, unknown>;
    expect(ctx.priorRuns).toBe(priorRuns);
    // Curves are downsampled to at most CURVE_SAMPLE points.
    expect((ctx.equityCurve as unknown[]).length).toBeLessThanOrEqual(CURVE_SAMPLE);
    expect(ctx.exitReasonCounts).toEqual({ 'trailing-stop': 2 });
    // fillRealism reflects the parsed params (1h strategy has finer intervals).
    const fill = ctx.fillRealism as Record<string, unknown>;
    expect(fill.favorableIntrabar).toBe(false);
    expect(fill.finerDetailAvailable).toBe(true);
    // A fully-parsed result yields a live-gate checklist and a trade/hold verdict.
    expect((ctx.gateChecks as unknown[]).length).toBeGreaterThan(0);
    expect(ctx.tradeOrHold).not.toBeNull();
  });

  it('degrades to an empty gate checklist and null verdict when the result does not fully parse', () => {
    const partial = { params: {}, metrics: { totalReturnPct: 1 } } as unknown as BacktestResult;
    const { input: built } = buildImproveInput({
      strategyName: 's',
      strategyVersion: '1',
      configSchema,
      configSchemaDoc: {},
      profileConfig,
      result: partial,
      priorRuns: { total: 0, sample: [] },
      policy,
    });
    const ctx = built.context as Record<string, unknown>;
    expect(ctx.gateChecks).toEqual([]);
    expect(ctx.tradeOrHold).toBeNull();
    expect(ctx.fillRealism).toBeNull();
  });

  it('throws AdvisorConfigStaleError when the config no longer matches the schema', () => {
    expect(() =>
      buildImproveInput({
        strategyName: 's',
        strategyVersion: '1',
        configSchema,
        configSchemaDoc: {},
        profileConfig: { candleInterval: 1, maxPurchaseAmount: 'nope' },
        result: { params: {} } as unknown as BacktestResult,
        priorRuns: { total: 0, sample: [] },
        policy,
      }),
    ).toThrow(AdvisorConfigStaleError);
  });
});
