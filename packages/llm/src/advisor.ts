import {
  BACKTEST_INTERVALS,
  BacktestParamsSchema,
  gateThresholdChecks,
  mergeImproveResponses,
  recommendTradeOrHold,
  toGateCandidates,
  tokenizePath,
  type BacktestResult,
  type BacktestTrade,
  type ConfigSuggestion,
  type DroppedSuggestion,
  type ImproveConfigMode,
  type ImproveConfigResponse,
} from '@app/contracts';
import { mergeConfig } from '@app/strategy-core';
import type { z } from 'zod';
import type { ImproveConfigInput, LlmAssist } from './llm.js';

// Path segments that would walk into the prototype chain. The patches come from
// the (untrusted) LLM, and `cur[seg] = value` on one of these pollutes
// Object.prototype process-wide — and that write lands BEFORE the schema
// re-validation that otherwise gates a bad patch, so dropping the suggestion
// after the fact cannot undo it. Skip any patch that names one.
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Apply the advisor's path/value patches onto a clone of the base config. Paths
 * are tokenized (dotted keys plus bracketed array indices like
 * `technicals.intervals[2].whenNeutral`) so a patch can target an array element:
 * a numeric segment hits an array index, a missing intermediate becomes an
 * object. Intentionally permissive, the caller re-validates the result against
 * the strategy schema, which is the real guard, so a patch that builds nonsense
 * is dropped, not trusted. Prototype-chain segments are the one exception: they
 * are refused outright because their write escapes the re-validated clone.
 */
export const applyConfigPatches = (
  base: Record<string, unknown>,
  changes: ConfigSuggestion['changes'],
): Record<string, unknown> => {
  const next = structuredClone(base);
  for (const { path, value } of changes) {
    const segs = tokenizePath(path);
    if (segs.some((s) => UNSAFE_PATH_SEGMENTS.has(s))) continue;
    let cur: Record<string, unknown> = next;
    for (let i = 0; i < segs.length - 1; i++) {
      const k = segs[i] as string;
      const child = cur[k];
      if (child === null || typeof child !== 'object') cur[k] = {};
      cur = cur[k] as Record<string, unknown>;
    }
    cur[segs[segs.length - 1] as string] = value;
  }
  return next;
};

// The stored equity/drawdown curves are one point per bar (a 13-month 1m run is
// ~525k points, ~15 MB) — far too large to send. Downsample to this many
// evenly-spaced points (first and last always kept) so the model sees the SHAPE
// of the equity path and where drawdowns landed without the payload exploding.
export const CURVE_SAMPLE = 80;

export const downsample = <T>(arr: readonly T[], n: number): T[] => {
  if (arr.length <= n) return [...arr];
  const step = (arr.length - 1) / (n - 1);
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)] as T);
  return out;
};

// Exit-reason mix across ALL sells, not the capped round-trip sample. Which
// mechanism closed positions (a technicals force-sell vs a trailing stop vs the
// grid ladder) is the sharpest "why the return is what it is" signal; counting
// every sell keeps it accurate even when the round-trip sample is truncated.
export const exitReasonCounts = (trades: readonly BacktestTrade[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const t of trades) {
    if (t.side === 'SELL') out[t.reason] = (out[t.reason] ?? 0) + 1;
  }
  return out;
};

// Render the first schema violation as `field.path: message` so the operator
// learns exactly which field/value the model got wrong (e.g. a percent field's
// (0,1] bound vs a 0-100 value) instead of a silent drop. Empty path → the
// message alone (a root-level cross-field refinement).
export const describeSchemaFailure = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (!issue) return 'does not match the strategy schema';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
};

// Partition suggestions by whether their patched config validates against the
// strategy schema. Valid ones are offered; each invalid one is kept as a
// `dropped` entry with a human-readable reason so the UI can show that the model
// proposed something and why it was skipped — a returned-but-invalid suggestion
// must not read as "no suggestion". Same guard whether the suggestions came from
// the server LLM call or a manual paste-back.
export const partitionSuggestions = (
  configSchema: z.ZodType,
  baseConfig: Record<string, unknown>,
  suggestions: readonly ConfigSuggestion[],
): { valid: ConfigSuggestion[]; dropped: DroppedSuggestion[] } => {
  const valid: ConfigSuggestion[] = [];
  const dropped: DroppedSuggestion[] = [];
  for (const s of suggestions) {
    const parsed = configSchema.safeParse(applyConfigPatches(baseConfig, s.changes));
    if (parsed.success) valid.push(s);
    else dropped.push({ id: s.id, title: s.title, reason: describeSchemaFailure(parsed.error) });
  }
  return { valid, dropped };
};

// Prior same-market runs fed to the advisor as history: the full count so the
// model gauges search density, plus a bounded newest-first sample of `{config,
// metrics}`. Assembled by the caller (a DB read); passed in so this module stays
// pure and DB-free.
export interface AdvisorPriorRuns {
  total: number;
  sample: { config: unknown; metrics: Record<string, unknown> }[];
}

// Headline metrics carried per prior run in the advisor's history: just the
// signals it reasons over (return, alpha, sample size, risk). The heavy series
// never enter the ledger, so this is the whole informative surface. Order is
// stable so the compacted objects read identically across runs.
export const HISTORY_METRIC_KEYS = [
  'totalReturnPct',
  'alphaVsHoldPct',
  'totalTrades',
  'winRate',
  'maxDrawdownPct',
  'profitFactor',
  'sharpe',
] as const;

// Most-recent prior runs fed as history. Bounded so the payload stays sane; the
// full count is reported separately (`total`) so the model still knows the density.
export const HISTORY_CAP = 20;

// Keep only the headline metric keys the advisor reasons over, dropping the rest
// of the stored outcome. A key that is absent from the outcome is simply omitted.
export const compactMetrics = (outcome: unknown): Record<string, unknown> => {
  const m = (outcome ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of HISTORY_METRIC_KEYS) if (key in m) out[key] = m[key];
  return out;
};

// One stored prior-run outcome, structurally: the exact fields shapePriorRuns
// reads off each ledger row. Declared here so @app/llm stays DB-free; the db rows
// satisfy it structurally, no @app/db type import needed.
export interface PriorRunRow {
  readonly params: unknown;
  readonly outcome: unknown;
  readonly backtestSignature: string;
}

// Shape same-market ledger rows into the advisor's prior-run history: exclude the
// current run by its own stored signature, cap at the newest HISTORY_CAP, and
// compact each to `{config, metrics}`. `total` is the full excluded count (before
// the cap) so the model gauges search density even though only HISTORY_CAP are
// sent. The DB read stays at the call site; this shaping is pure and DB-free.
export const shapePriorRuns = (
  rows: readonly PriorRunRow[],
  currentSignature: string | null,
): AdvisorPriorRuns => {
  const others = rows.filter((r) => r.backtestSignature !== currentSignature);
  return {
    total: others.length,
    sample: others
      .slice(0, HISTORY_CAP)
      .map((r) => ({ config: r.params, metrics: compactMetrics(r.outcome) })),
  };
};

/**
 * Thrown when a finished run's config can no longer be reconstructed against the
 * current strategy schema (the profile config was edited into an incompatible
 * shape after the run). The advisor cannot advise on a config it cannot rebuild;
 * the caller maps this to a 409.
 */
export class AdvisorConfigStaleError extends Error {}

/** Already-fetched inputs the pure {@link buildImproveInput} composes into the
 * advisor prompt. The caller resolves the strategy plugin, reads the run result,
 * and fetches prior-run history + the enablement policy; this module does no I/O. */
export interface BuildImproveInputArgs {
  strategyName: string;
  strategyVersion: string;
  // The strategy's zod config schema: parses the profile base and re-validates
  // the merged config. The same schema the caller passes to partitionSuggestions.
  configSchema: z.ZodType;
  // The JSON-schema doc the model reads (the fields it may change, with bounds).
  configSchemaDoc: unknown;
  profileConfig: unknown;
  // The finished run's stored result. The caller has already proven the run is
  // `done` with a non-null result before calling.
  result: BacktestResult;
  priorRuns: AdvisorPriorRuns;
  // The profile's parsed enablement policy (the gate thresholds this run's
  // checklist is scored against).
  policy: Parameters<typeof gateThresholdChecks>[1];
}

/**
 * Compose the advisor's read of a finished run: the base config its patches
 * compose onto, plus the `improveConfig` input (config schema doc + the full run
 * context). Pure — every DB/registry read is done by the caller and passed in.
 * Throws {@link AdvisorConfigStaleError} when the run's config no longer parses
 * against the strategy schema.
 */
export const buildImproveInput = (
  args: BuildImproveInputArgs,
): { baseConfig: Record<string, unknown>; input: ImproveConfigInput } => {
  const { configSchema, result, priorRuns, policy } = args;
  // Normalize the stored params on read (strip unknown keys, default-fill) before
  // they feed the prompt context. The prototype-pollution defense is mergeConfig's
  // own key guard, not this parse; nullish/defaulted contract fields mean genuine
  // legacy shapes still parse, so the raw fallback is hit only by a malformed blob
  // — which the merge guard and the configSchema re-parse below still contain.
  const parsedParams = BacktestParamsSchema.safeParse(result.params);
  const params = parsedParams.data ?? result.params;
  // The config that produced these metrics: the run parsed the profile config,
  // merged its override onto it, then re-parsed (backtest-runner.ts). The override
  // is a PARTIAL diff — a run override carries only the changed keys — so
  // using it raw as the base feeds a partial config to the schema and drops every
  // suggestion. Mirror the runner's parse-then-merge: parsing the base first
  // default-fills it, so a numeric override coerces onto a decimal-string
  // field (mergeConfig only stringifies a number when the base key already holds a
  // string). Fall back to the raw config when the stored base no longer parses, so
  // a still-completable override can recover; an unrecoverable merge throws.
  const parsedBase = configSchema.safeParse(args.profileConfig);
  const merged = configSchema.safeParse(
    mergeConfig(
      parsedBase.success
        ? (parsedBase.data as Record<string, unknown>)
        : (args.profileConfig as Record<string, unknown>),
      params.strategyConfigOverride ?? {},
    ),
  );
  if (!merged.success) {
    throw new AdvisorConfigStaleError(
      "this run's config no longer matches the strategy schema — re-run the backtest on the current config",
    );
  }
  const baseConfig = merged.data as Record<string, unknown>;
  // The live-enablement gate's own checklist for THIS run: the exact bars that
  // decide go-live (coverage, profit factor, closed trades, alpha, and the
  // out-of-sample trio), each with its current pass/fail, under this profile's
  // policy. Feeding the advisor the target it must clear, and which checks fail,
  // aims its suggestions at the binding constraint instead of an abstract
  // "improve performance", and steers it off the risk-adjusted metrics the gate
  // ignores. Same evaluation the gate-status card and admission gate use, so the
  // advisor never reasons against a different bar than the operator sees.
  const gateMetrics =
    toGateCandidates([{ id: 'advisor', configFingerprint: null, createdAt: EPOCH, result }])[0]
      ?.metrics ?? null;
  const gateChecks = gateMetrics ? gateThresholdChecks(gateMetrics, policy) : [];
  // The honest "should this trade live at all" baseline: HOLD when the run lost
  // to a fee-free buy-and-hold or closed no trades. Anchors the advisor to the
  // just-hold answer so it does not manufacture patches for a run with no edge.
  // Derived from the parsed gate metrics (null when the stored result did not
  // fully parse), so a legacy partial result yields no verdict rather than a
  // crash on a missing field.
  const tradeOrHold = gateMetrics
    ? recommendTradeOrHold({
        alphaVsHoldPct: gateMetrics.alphaVsHoldPct,
        totalTrades: gateMetrics.totalTrades,
      })
    : null;
  // What the fill model assumed, so the advisor can discount optimistic profits.
  // `favorableIntrabar` (detail interval == strategy interval) and null
  // spread/volume-cap mean intra-candle fills are optimistic. A tight-grid
  // round-trip that only closes under that assumption may not repeat live.
  // Built from the PARSED params only (null when they did not parse), so an
  // unparseable legacy blob never mislabels `favorableIntrabar` as true from an
  // `undefined === undefined` comparison — same honest-or-absent stance as the
  // gate checklist above.
  const fp = parsedParams.data;
  const fillRealism = fp
    ? {
        detailInterval: fp.detailInterval,
        strategyInterval: fp.strategyInterval,
        favorableIntrabar: fp.detailInterval === fp.strategyInterval,
        // False when the strategy already runs at the finest supported interval
        // (index 0 of BACKTEST_INTERVALS, i.e. 1m): no finer detail interval
        // exists, so favorable intra-candle fills are inherent and cannot be
        // removed by tuning. The advisor must not propose a finer detail then.
        finerDetailAvailable: BACKTEST_INTERVALS.indexOf(fp.strategyInterval) > 0,
        spreadBps: fp.spreadBps ?? null,
        volumeCapPct: fp.volumeCapPct ?? null,
        slippageBps: fp.slippageBps,
      }
    : null;
  return {
    baseConfig,
    input: {
      strategyName: args.strategyName,
      strategyVersion: args.strategyVersion,
      configSchema: args.configSchemaDoc,
      context: {
        config: baseConfig,
        params,
        metrics: result.metrics,
        // The live-gate checklist this run must clear (per-check pass/fail under
        // the profile's policy) and its data-quality warnings. The gate decides
        // go-live on these bars only; a non-empty `dataWarnings` means the
        // metrics are computed on patchy candle data and are not trustworthy.
        gateChecks,
        dataWarnings: result.dataWarnings ?? [],
        // Honest trade-or-hold baseline and the fill-model assumptions, so the
        // advisor discounts optimistic profits and does not over-tune a no-edge run.
        tradeOrHold,
        fillRealism,
        decisionBreakdown: result.decisionBreakdown,
        regimeBreakdown: result.regimeBreakdown ?? [],
        outOfSample: result.outOfSample ?? null,
        perSymbol: result.perSymbol ?? [],
        // Cap the round-trip sample so the payload stays bounded on a long run.
        roundTrips: (result.roundTrips ?? []).slice(0, 50),
        priorRuns,
        // Time-resolved evidence: the SHAPE of the equity path (long flat
        // stretches = capital sat idle) and where drawdowns landed, downsampled
        // from the per-bar series; plus the exit-reason mix across every sell so
        // the model sees WHAT closed positions, not just aggregate return.
        equityCurve: downsample(result.equityCurve ?? [], CURVE_SAMPLE),
        drawdownSeries: downsample(result.drawdownSeries ?? [], CURVE_SAMPLE),
        exitReasonCounts: exitReasonCounts(result.trades ?? []),
      },
    },
  };
};

// The synthetic createdAt for the gate-metric adapter. Only `metrics` is read
// off the candidate, and metrics derive from `result` alone, so the timestamp is
// never observed — a fixed epoch keeps the call pure.
const EPOCH = new Date(0);

// Model samples per EXPLORE variant. Each variant asks the model twice and merges
// the deduped union, widening the set beyond a single call's 2-4 suggestions
// without repeats. `safe` is a single call (it withholds by design, so extra
// samples would only add near-duplicate "hold" reads). Kept small: each sample is
// a full ~30s generation billed per token.
const VARIANT_SAMPLES = 2;

// Run the advisor for a variant, sampling the model VARIANT_SAMPLES times for an
// EXPLORE variant and merging (dedup + unique ids), or a single call for `safe`.
export const runAdvisor = async (
  llm: LlmAssist,
  input: ImproveConfigInput,
  mode: ImproveConfigMode,
): Promise<ImproveConfigResponse> => {
  if (mode === 'safe') {
    return llm.improveConfig(input, mode);
  }
  // allSettled, not all: with two parallel calls an OAuth rate-limit (429) on one
  // sample is likely, and losing the whole ask because one sample failed is worse
  // than returning the survivor. Merge the fulfilled samples; only fail if EVERY
  // sample failed, rethrowing the first reason so a real error still surfaces.
  const settled = await Promise.allSettled(
    Array.from({ length: VARIANT_SAMPLES }, () => llm.improveConfig(input, mode)),
  );
  const ok = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  if (ok.length === 0) {
    const rejected = settled.find((s) => s.status === 'rejected');
    throw rejected ? (rejected as PromiseRejectedResult).reason : new Error('llm advisor failed');
  }
  return mergeImproveResponses(ok);
};
