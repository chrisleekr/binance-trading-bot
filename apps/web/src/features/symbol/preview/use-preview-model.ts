// Resolve a strategy's PreviewModel for the operator's pre-trade view and the
// chart's price lines. Lazy-loads the strategy's preview module, fetches the
// candle history it declares (its own decision interval plus any extra history
// from previewDataNeeds), and runs the pure previewLevels. Form-independent, so
// both the config-page panel (fed a useWatch draft) and the live symbol
// workspace (fed the persisted config) call it.

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';

import type { AccountSnapshotWire, Candle, PreviewModel, SymbolFilters } from '@app/strategy-core';
import type { CandleList } from '@app/contracts';

import {
  CANDLE_INTERVALS,
  fetchSymbolCandles,
  intervalSpanMs,
  type CandleInterval,
} from '@/features/symbol/api/symbol';

import { hasPreviewModule, loadPreviewModule, type PreviewModule } from './preview-modules';

const EMPTY_MODEL: PreviewModel = { sections: [] };

// Frames for the strategy's own decision window. Generous so any moving-average
// period the operator sets fits; capped like the worker's daily ring (500).
const DECISION_WINDOW_FRAMES = 500;

const asCandleInterval = (v: unknown): CandleInterval | null =>
  typeof v === 'string' && (CANDLE_INTERVALS as readonly string[]).includes(v)
    ? (v as CandleInterval)
    : null;

interface CandleNeed {
  readonly interval: CandleInterval;
  frames: number;
}

/**
 * The candle windows the preview needs: the config's own `candleInterval`
 * decision window (so a candle-reading strategy has its moving-average input)
 * plus any extra history the module's `previewDataNeeds` declares. Deduped by
 * interval, taking the larger frame count. Intervals the web candle endpoint
 * does not serve are dropped.
 */
const buildNeeds = (config: Record<string, unknown>, mod: PreviewModule): CandleNeed[] => {
  const needs: CandleNeed[] = [];
  const push = (interval: CandleInterval, frames: number): void => {
    const existing = needs.find((n) => n.interval === interval);
    if (existing) {
      if (frames > existing.frames) existing.frames = frames;
      return;
    }
    needs.push({ interval, frames });
  };
  const decision = asCandleInterval(config['candleInterval']);
  if (decision) push(decision, DECISION_WINDOW_FRAMES);
  for (const need of mod.previewDataNeeds(config)) {
    const interval = asCandleInterval(need.interval);
    if (interval && Number.isFinite(need.frames) && need.frames > 0) {
      push(interval, Math.min(500, Math.floor(need.frames)));
    }
  }
  return needs;
};

/** Map a wire candle window to the strategy contract shape; the still-forming tail is `isClosed: false`. */
const toStrategyCandles = (list: CandleList, interval: CandleInterval, nowMs: number): Candle[] => {
  const span = intervalSpanMs(interval);
  return list.map((c) => {
    const openTimeMs = Date.parse(c.time);
    const closeTimeMs = openTimeMs + span;
    return {
      openTimeMs,
      closeTimeMs,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      isClosed: Number.isFinite(openTimeMs) && closeTimeMs <= nowMs,
    };
  });
};

export interface PreviewModelArgs {
  readonly strategyName: string;
  readonly profileId: string;
  readonly symbol: string | undefined;
  /** The config draft (unparsed) — read defensively by the strategy. */
  readonly config: Record<string, unknown>;
  readonly state: unknown | null;
  /** The position's avg entry, or the price a first entry would fill at. */
  readonly entryPrice: string | null;
  readonly currentPrice: string | null;
  readonly account?: AccountSnapshotWire | undefined;
  readonly quoteAsset?: string | undefined;
  /** Binance sizing filters for the symbol; lets momentum size a concrete entry qty. */
  readonly filters?: SymbolFilters | undefined;
}

export interface PreviewModelResult {
  readonly model: PreviewModel;
  readonly isLoading: boolean;
  readonly error: unknown;
}

export function usePreviewModel(args: PreviewModelArgs): PreviewModelResult {
  const { strategyName, profileId, symbol, config } = args;

  const moduleQuery: UseQueryResult<PreviewModule> = useQuery({
    queryKey: ['preview-module', strategyName],
    queryFn: () => loadPreviewModule(strategyName),
    enabled: hasPreviewModule(strategyName),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const mod = moduleQuery.data;

  const needs = useMemo(() => (mod ? buildNeeds(config, mod) : []), [mod, config]);

  const candlesQuery = useQuery({
    // `needs` is a fresh array each render but a stable value; React Query hashes
    // the key, so an unchanged window does not refetch.
    queryKey: ['preview-candles', profileId, symbol, needs],
    queryFn: async (): Promise<Candle[]> => {
      const nowMs = Date.now();
      const windows = await Promise.all(
        needs.map((need) =>
          fetchSymbolCandles(profileId, symbol ?? '', {
            interval: need.interval,
            frames: need.frames,
          }).then((list) => toStrategyCandles(list, need.interval, nowMs)),
        ),
      );
      return windows.flat();
    },
    enabled: mod !== undefined && symbol !== undefined && symbol !== '' && needs.length > 0,
    staleTime: 60_000,
  });

  const { model, computeError } = useMemo<{
    readonly model: PreviewModel;
    readonly computeError: unknown;
  }>(() => {
    if (!mod) return { model: EMPTY_MODEL, computeError: null };
    try {
      const built = mod.previewLevels({
        config,
        state: args.state,
        entryPrice: args.entryPrice,
        currentPrice: args.currentPrice,
        ...(candlesQuery.data !== undefined ? { candles: candlesQuery.data } : {}),
        ...(args.account !== undefined ? { account: args.account } : {}),
        ...(args.quoteAsset !== undefined ? { quoteAsset: args.quoteAsset } : {}),
        ...(args.filters !== undefined ? { filters: args.filters } : {}),
      });
      return { model: built, computeError: null };
    } catch (err) {
      // A defensive strategy should never throw, but a preview must never crash
      // the page it decorates; fall back to an empty model and surface the error
      // through the same channel as a load failure so it is not silently blank.
      return { model: EMPTY_MODEL, computeError: err };
    }
  }, [
    mod,
    config,
    args.state,
    args.entryPrice,
    args.currentPrice,
    args.account,
    args.quoteAsset,
    args.filters,
    candlesQuery.data,
  ]);

  return {
    model,
    isLoading: moduleQuery.isLoading || candlesQuery.isLoading,
    error: moduleQuery.error ?? candlesQuery.error ?? computeError,
  };
}
