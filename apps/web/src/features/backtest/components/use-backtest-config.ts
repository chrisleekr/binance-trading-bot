// Config slice of the backtest workbench: the symbol picker state, the
// backtest-only param form (window, intervals, cost model), and the strategy
// config draft that the AutoForm edits. Owns the seeding logic that fills the
// draft from the live config, a selected past run, or an auto-anchored newest
// run, plus the submit path that assembles the BacktestParams and launches.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import {
  asDecimalString,
  BACKTEST_INTERVALS,
  type BacktestParams,
  type ProfileResponse,
  type StrategyDescriptor,
} from '@app/contracts';
import { mergeConfig } from '@app/strategy-core';
import {
  fetchProfileDashboard,
  profileDashboardQueryKey,
} from '@/features/profile/api/profile-dashboard';
import { strategiesQueryOptions } from '@/features/profile/api/strategies';
import { BASKET_STRATEGIES, basketSymbolsFromConfig } from '@/features/symbol/strategies/registry';
import { syntheticBacktestAccount } from '@/features/symbol/preview/account-wire';
import { omitKey, omitSchemaProperty } from '@/features/backtest/lib/config-schema';
import { deepEqual } from '@/shared/lib/config-diff';
import { useBacktestRun } from './use-backtest-run';
import type { TabKey } from './use-backtest-types';

/** Backtest-only parameters — everything that is not part of the strategy config. */
export interface ParamState {
  from: string;
  to: string;
  strategyInterval: string;
  detailInterval: string;
  initialQuoteBalance: string;
  makerBps: string;
  takerBps: string;
  slippageBps: string;
  spreadBps: string;
  // Empty string disables the cap (sent as undefined).
  volumeCapPct: string;
}

// The lookback an autorun uses when the form carries no window yet. Long enough
// to cover more than one regime, short enough to finish while the operator waits.
const AUTORUN_WINDOW_DAYS = 90;

const INITIAL_PARAMS: ParamState = {
  from: '',
  to: '',
  strategyInterval: '1h',
  detailInterval: '5m',
  initialQuoteBalance: '1000',
  makerBps: '10',
  takerBps: '10',
  slippageBps: '5',
  // Pessimistic-by-default: a half-spread on every fill and a participation cap
  // so the operator must opt OUT of realism, not into it. 5% is a realistic
  // single-bar participation share; a thicker order on a thin bar works across
  // later bars instead of clearing instantly at one price.
  spreadBps: '5',
  volumeCapPct: '5',
};

/** datetime-local string → epoch ms, or NaN when unset/invalid. */
const toMs = (v: string): number => new Date(v).getTime();

/** epoch ms → `YYYY-MM-DDTHH:mm` in the browser's local zone (inverse of toMs). */
const toLocalInput = (ms: number): string =>
  new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/**
 * Map a stored run's params back into the editable backtest-only form state, so
 * loading a past run fills the whole form — window, intervals, and the cost
 * model — not just the strategy config. Absent optional costs reflect what the
 * run actually used (no spread, no volume cap), so a re-run reproduces it.
 */
const paramStateFromResult = (p: BacktestParams): ParamState => ({
  from: toLocalInput(p.fromMs),
  to: toLocalInput(p.toMs),
  strategyInterval: p.strategyInterval,
  detailInterval: p.detailInterval,
  initialQuoteBalance: p.initialQuoteBalance,
  makerBps: String(p.fees.makerBps),
  takerBps: String(p.fees.takerBps),
  slippageBps: String(p.slippageBps),
  spreadBps: String(p.spreadBps ?? 0),
  volumeCapPct: p.volumeCapPct == null ? '' : String(p.volumeCapPct),
});

const intervalRank = (i: string): number =>
  BACKTEST_INTERVALS.indexOf(i as BacktestParams['strategyInterval']);

type Banner = { kind: 'ok' | 'err'; message: string } | null;
type LaunchMutation = ReturnType<typeof useBacktestRun>['launch'];

export interface BacktestConfigArgs {
  profileId: string;
  symbolParam: string | undefined;
  activeRunId: string | null;
  setBanner: (b: Banner) => void;
  setTab: (tab: TabKey) => void;
  profile: UseQueryResult<ProfileResponse>;
  descriptor: StrategyDescriptor | undefined;
  launch: LaunchMutation;
  // Sourced from the run slice's active-run query.
  activeRunData: ReturnType<typeof useBacktestRun>['activeRunData'];
  result: ReturnType<typeof useBacktestRun>['result'];
  attributionConfig: Record<string, unknown>;
  testedConfig: ReturnType<typeof useBacktestRun>['testedConfig'];
}

export function useBacktestConfig({
  profileId,
  symbolParam,
  activeRunId,
  setBanner,
  setTab,
  profile,
  descriptor,
  launch,
  activeRunData,
  result,
  attributionConfig,
  testedConfig,
}: BacktestConfigArgs) {
  const [params, setParams] = useState<ParamState>(INITIAL_PARAMS);
  const [symbol, setSymbol] = useState(() => symbolParam ?? '');

  const dashboard = useQuery({
    queryKey: profileDashboardQueryKey(profileId),
    queryFn: () => fetchProfileDashboard(profileId),
    staleTime: 5_000,
  });
  const strategies = useQuery(strategiesQueryOptions);

  const setParam =
    (k: keyof ParamState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setParams((p) => ({ ...p, [k]: e.target.value }));

  // Fill From/To with a window of `days` ending now. The datetime-local inputs
  // remain the editable source of truth — presets are a shortcut, not a mode.
  const applyWindowPreset = (days: number): void => {
    const to = Date.now();
    setParams((p) => ({
      ...p,
      from: toLocalInput(to - days * 86_400_000),
      to: toLocalInput(to),
    }));
  };

  // Seed the symbol picker once: prefer the `?symbol=` the symbol drill-down
  // carries, then the symbol the profile is actually holding a position in, then
  // the first traded symbol. The operator can still pick another.
  const tradedSymbols = dashboard.data?.symbols ?? [];
  const defaultSymbol =
    tradedSymbols.find((s) => s.quantity !== null && Number(s.quantity) > 0)?.symbol ??
    tradedSymbols[0]?.symbol;
  if (symbol === '' && defaultSymbol) setSymbol(defaultSymbol);

  // Default the cost model from the profile's configured live fees so a backtest
  // measures the same round-trip cost the live bot pays. Seeds once when the
  // profile loads; the operator can still override.
  const [feesSeeded, setFeesSeeded] = useState(false);
  const fees = (profile.data?.config as { fees?: { makerBps?: string; takerBps?: string } })?.fees;
  if (!feesSeeded && fees) {
    setParams((p) => ({
      ...p,
      makerBps: p.makerBps === INITIAL_PARAMS.makerBps ? (fees.makerBps ?? p.makerBps) : p.makerBps,
      takerBps: p.takerBps === INITIAL_PARAMS.takerBps ? (fees.takerBps ?? p.takerBps) : p.takerBps,
    }));
    setFeesSeeded(true);
  }

  // The config form (AutoForm) starts seeded from the live config. Track when it
  // drifts so the "reset to live config" affordance shows only then; bumping the
  // nonce remounts the form, reseeding it back to the live config.
  const [configDrifted, setConfigDrifted] = useState(false);
  const [configResetNonce, setConfigResetNonce] = useState(0);
  // When a past run is selected, the form is seeded from that run's tested
  // config instead of the live config. Null = seed from the live config.
  const [runConfigSeed, setRunConfigSeed] = useState<Record<string, unknown> | null>(null);
  const seededRunIdRef = useRef<string | null>(null);
  // Holds the runId the operator clicked in the history list, so the run-detail
  // load seeds the form ONLY from that explicit pick.
  const wantConfigLoadForRunRef = useRef<string | null>(null);
  // Bumped on every explicit history pick so the load effect re-fires even when
  // the picked run is already the active run.
  const [configLoadNonce, setConfigLoadNonce] = useState(0);
  // The runId the auto-anchor chose (no `?run=` deep link), so its executed
  // config seeds the draft once its detail loads.
  const autoAnchoredRunIdRef = useRef<string | null>(null);
  const autoSeededRunIdRef = useRef<string | null>(null);

  // name@version string, used only to remount the config form on a strategy
  // change and to label the "no schema" fallback.
  const strategyKey =
    profile.data !== undefined
      ? `${profile.data.strategyName}@${profile.data.strategyVersion}`
      : '';

  // A basket strategy trades several symbols whose weights live in its config, so
  // the single picker doesn't apply — the symbols are derived at submit time.
  const isBasket = descriptor ? BASKET_STRATEGIES.has(descriptor.name) : false;

  // The config form owns every config field except the symbol, which the picker
  // supplies — one source of truth.
  const configSchema = useMemo(
    () => (descriptor ? omitSchemaProperty(descriptor.configSchema, 'symbol') : null),
    [descriptor],
  );
  const configDefaults = useMemo(
    () => omitKey((profile.data?.config ?? {}) as Record<string, unknown>, 'symbol'),
    [profile.data],
  );
  // The form seeds from a selected past run's config when one is loaded, else
  // from the live config.
  const effectiveConfigDefaults = runConfigSeed ?? configDefaults;

  const previewPrice = tradedSymbols.find((s) => s.symbol === symbol)?.currentPrice ?? null;
  // Synthetic account for the generic preview: the operator's typed starting
  // quote balance as free cash, nothing deployed — the backtest has no live
  // wallet, so this mirrors the engine's opening balance.
  const previewQuoteAsset = dashboard.data?.quoteAsset ?? 'USDT';
  const previewAccount = syntheticBacktestAccount(previewQuoteAsset, params.initialQuoteBalance);
  const strategyName = profile.data?.strategyName ?? '';

  // The interval the strategy decides on is owned by its config (`candleInterval`),
  // so the backtest streams that interval and mirrors live.
  const seededInterval = effectiveConfigDefaults['candleInterval'];
  const defaultConfig = descriptor?.defaultConfig;
  const defaultInterval =
    defaultConfig && typeof defaultConfig === 'object'
      ? (defaultConfig as Record<string, unknown>)['candleInterval']
      : undefined;
  const configInterval =
    typeof seededInterval === 'string'
      ? seededInterval
      : typeof defaultInterval === 'string'
        ? defaultInterval
        : null;
  const decisionInterval = configInterval ?? params.strategyInterval;

  // The detail interval must be the same as or finer than the decision interval.
  const detailIntervalTooCoarse =
    intervalRank(params.detailInterval) > intervalRank(decisionInterval);

  // Clamp a now-too-coarse detail interval down to the decision interval, during
  // render, so the too-coarse frame never commits.
  const [clampedForInterval, setClampedForInterval] = useState<string | null>(null);
  if (decisionInterval !== clampedForInterval) {
    setClampedForInterval(decisionInterval);
    if (detailIntervalTooCoarse) {
      setParams((p) => ({ ...p, detailInterval: decisionInterval }));
    }
  }

  // Validate the symbols + backtest-only params shared by both run actions and
  // assemble the BacktestParams base (everything except strategyConfigOverride).
  const assembleBase = (
    configValues?: Record<string, unknown>,
    // The window/cost state to assemble from. Defaults to the live form state;
    // the autorun path passes a freshly windowed copy, whose `setParams` has not
    // been applied to `params` yet.
    p: ParamState = params,
  ): Omit<BacktestParams, 'strategyConfigOverride'> | null => {
    setBanner(null);
    const symbols = isBasket
      ? basketSymbolsFromConfig(configValues ?? {})
      : symbol === ''
        ? []
        : [symbol];
    if (isBasket && symbols.length < 2) {
      setBanner({
        kind: 'err',
        message: 'Add at least two symbols to the basket under Strategy config.',
      });
      return null;
    }
    if (!isBasket && symbol === '') {
      setBanner({ kind: 'err', message: 'Pick a symbol.' });
      return null;
    }
    if (Number.isNaN(toMs(p.from)) || Number.isNaN(toMs(p.to))) {
      setBanner({ kind: 'err', message: 'Pick a From and To date.' });
      return null;
    }
    const runInterval =
      configValues && typeof configValues['candleInterval'] === 'string'
        ? (configValues['candleInterval'] as string)
        : p.strategyInterval;
    if (intervalRank(p.detailInterval) > intervalRank(runInterval)) {
      setBanner({
        kind: 'err',
        message: `Detail interval must be the same as or finer than your Candle Interval (${runInterval}).`,
      });
      return null;
    }
    const costs = [p.makerBps, p.takerBps, p.slippageBps, p.spreadBps].map(Number);
    if (costs.some((n) => !Number.isFinite(n) || n < 0)) {
      setBanner({
        kind: 'err',
        message: 'Fees, slippage, and spread must be non-negative numbers.',
      });
      return null;
    }
    const capRaw = p.volumeCapPct.trim();
    const volumeCapPct = capRaw === '' ? undefined : Number(capRaw);
    if (
      volumeCapPct !== undefined &&
      (!Number.isFinite(volumeCapPct) || volumeCapPct <= 0 || volumeCapPct > 100)
    ) {
      setBanner({
        kind: 'err',
        message: 'Max fill per candle must be a percentage between 0 and 100, or blank to disable.',
      });
      return null;
    }
    return {
      symbols,
      fromMs: toMs(p.from),
      toMs: toMs(p.to),
      strategyInterval: runInterval as BacktestParams['strategyInterval'],
      detailInterval: p.detailInterval as BacktestParams['detailInterval'],
      initialQuoteBalance: asDecimalString(p.initialQuoteBalance),
      fees: { makerBps: Number(p.makerBps), takerBps: Number(p.takerBps) },
      slippageBps: Number(p.slippageBps),
      spreadBps: Number(p.spreadBps),
      ...(volumeCapPct !== undefined ? { volumeCapPct } : {}),
      discoveryMode: false,
    };
  };

  // Assemble + launch. `p` is the window/cost state to run with: the form's own
  // by default, or a freshly windowed copy on the autorun path (whose setParams
  // has not landed in `params` yet).
  const submitConfig = (configValues: Record<string, unknown>, p: ParamState): void => {
    const baseParams = assembleBase(configValues, p);
    if (!baseParams) return;
    launch.mutate({
      body: {
        ...baseParams,
        strategyConfigOverride: isBasket ? configValues : { ...configValues, symbol },
        parentRunId: activeRunId,
      },
    });
  };

  // AutoForm hands the validated config here. Single-argument by contract:
  // react-hook-form's handleSubmit passes the submit EVENT as the second
  // argument, so this must not forward its own arguments blindly.
  const onConfigSubmit = (configValues: Record<string, unknown>): void => {
    submitConfig(configValues, params);
  };

  /**
   * Launch a run on the config exactly as it stands, with no form interaction —
   * the `?autorun=1` entry. It goes through the same submit path as the button,
   * so the same symbol / date / interval / basket validation applies; only the
   * window is defaulted, because a form the operator never opened carries none
   * and failing it with "pick a date" would be a dead end.
   */
  const launchCurrentConfig = (): void => {
    const now = Date.now();
    const windowed: ParamState =
      params.from !== '' && params.to !== ''
        ? params
        : {
            ...params,
            from: toLocalInput(now - AUTORUN_WINDOW_DAYS * 86_400_000),
            to: toLocalInput(now),
          };
    // Keep the visible form in step with what was actually run.
    if (windowed !== params) setParams(windowed);
    submitConfig(effectiveConfigDefaults, windowed);
  };

  // Restore the live config in the form, discarding edits or a loaded past-run config.
  const resetToLiveConfig = (): void => {
    setBanner(null);
    setRunConfigSeed(null);
    seededRunIdRef.current = null;
    setConfigResetNonce((n) => n + 1);
  };

  // Load the selected suggested changes into the Configure tab. Never writes the
  // live config and never runs a backtest.
  const seedConfigForRetest = (nextConfig: Record<string, unknown>): void => {
    setRunConfigSeed(omitKey(nextConfig, 'symbol'));
    seededRunIdRef.current = null;
    setConfigResetNonce((n) => n + 1);
    // Switch to the Configure tab so the operator sees the loaded changes.
    setTab('configure');
    setBanner({
      kind: 'ok',
      message:
        'Loaded your selected changes in the Configure tab. Review them and Run backtest when ready — your live config is unchanged.',
    });
  };

  // Mark a run as an explicit history pick so its stored config seeds the draft
  // when the run detail loads. Stable so the composition root's selectRun stays
  // stable across renders.
  const requestConfigLoad = useCallback((runId: string): void => {
    wantConfigLoadForRunRef.current = runId;
    setConfigLoadNonce((n) => n + 1);
  }, []);

  // Same intent as requestConfigLoad but without bumping the nonce: the mount-time
  // `?run=` hydration seeds from an activeRunId transition that already re-fires
  // the load effect, so a nonce bump would be a redundant extra pass.
  const primeConfigLoad = useCallback((runId: string): void => {
    wantConfigLoadForRunRef.current = runId;
  }, []);

  // Record the auto-anchored newest run so its executed config seeds the draft.
  const markAutoAnchored = useCallback((runId: string): void => {
    autoAnchoredRunIdRef.current = runId;
  }, []);

  // Load a selected run's full setup into the form (once per run): the
  // backtest-only params, the symbol picker, and the tested config. Config seeds
  // even before the result is ready (a queued/running run carries its params), so
  // clicking an in-flight run still loads its config; only the metrics stay
  // gated on `done`.
  const loadedRunId = activeRunData?.runId ?? null;
  const loadedParams = activeRunData?.params ?? null;
  useEffect(() => {
    if (loadedRunId === null || wantConfigLoadForRunRef.current !== loadedRunId) return;
    if (loadedRunId === seededRunIdRef.current) {
      wantConfigLoadForRunRef.current = null; // already seeded this run; intent done
      return;
    }
    if (!loadedParams) return; // detail still loading — keep the intent for the next tick
    const loadRun = setTimeout(() => {
      if (wantConfigLoadForRunRef.current !== loadedRunId) return;
      wantConfigLoadForRunRef.current = null;
      seededRunIdRef.current = loadedRunId;
      setParams(paramStateFromResult(loadedParams));
      const runSymbol = loadedParams.symbols[0];
      if (!isBasket && runSymbol) setSymbol(runSymbol);
      if (result) {
        const hasOverride = testedConfig != null && Object.keys(testedConfig).length > 0;
        setRunConfigSeed(hasOverride ? omitKey(attributionConfig, 'symbol') : null);
      } else {
        const override = loadedParams.strategyConfigOverride;
        const hasOverride = override != null && Object.keys(override).length > 0;
        const merged = mergeConfig(
          (profile.data?.config ?? {}) as Record<string, unknown>,
          (override ?? {}) as Record<string, unknown>,
        );
        setRunConfigSeed(hasOverride ? omitKey(merged, 'symbol') : null);
      }
      setConfigResetNonce((n) => n + 1);
    }, 0);
    return () => clearTimeout(loadRun);
  }, [
    loadedRunId,
    loadedParams,
    attributionConfig,
    result,
    isBasket,
    configLoadNonce,
    profile.data?.config,
  ]);

  // Auto-anchor seeds the Draft from the anchored run's executed config so
  // "Adjust & re-run" starts from what that run actually ran. Config only.
  useEffect(() => {
    const anchoredId = autoAnchoredRunIdRef.current;
    if (anchoredId === null || loadedRunId !== anchoredId) return;
    if (autoSeededRunIdRef.current === anchoredId) return;
    if (!result) return; // detail still loading — seed on the next tick
    const resolved = result.resolvedConfig as Record<string, unknown> | null | undefined;
    const seedAnchored = setTimeout(() => {
      if (autoAnchoredRunIdRef.current !== anchoredId) return;
      autoSeededRunIdRef.current = anchoredId;
      if (resolved == null) return;
      const seed = omitKey(resolved, 'symbol');
      setRunConfigSeed(deepEqual(seed, configDefaults) ? null : seed);
      setConfigResetNonce((n) => n + 1);
    }, 0);
    return () => clearTimeout(seedAnchored);
  }, [loadedRunId, result, configDefaults]);

  return {
    isBasket,
    symbol,
    setSymbol,
    params,
    setParam,
    applyWindowPreset,
    decisionInterval,
    detailIntervalTooCoarse,
    configSchema,
    strategyKey,
    configResetNonce,
    effectiveConfigDefaults,
    onConfigSubmit,
    launchCurrentConfig,
    setConfigDrifted,
    runConfigSeed,
    configDrifted,
    resetToLiveConfig,
    strategyName,
    previewPrice,
    previewAccount,
    previewQuoteAsset,
    profileLoading: profile.isLoading,
    profileError: profile.isError,
    strategiesLoading: strategies.isLoading,
    launchPending: launch.isPending,
    seedConfigForRetest,
    // Consumed by the composition root's selectRun and auto-anchor wiring.
    requestConfigLoad,
    primeConfigLoad,
    markAutoAnchored,
  };
}
