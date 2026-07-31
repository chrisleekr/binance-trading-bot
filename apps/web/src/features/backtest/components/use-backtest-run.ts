// Run slice of the backtest workbench: the anchored run's lifecycle. Owns the
// active-run query (with its poll-while-running cadence), the low-latency live
// progress overlay pushed over the profile WebSocket, the launch / abort / retry
// mutations, and the derived progress / ETA / result / attribution values the
// Results tab renders.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useMutation,
  useQuery,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';

import {
  gateThresholdChecks,
  recommendTradeOrHold,
  type BacktestListItem,
  type BacktestListResponse,
  type BacktestParams,
  type BacktestProgressDetail,
  type BacktestProgressPayload,
  type ProfileResponse,
  type StrategyDescriptor,
} from '@app/contracts';
import { mergeConfig } from '@app/strategy-core';
import { useProfileSocketHandlers, type SocketFrame } from '@/features/profile/socket';
import { buildProfileWsUrl } from '@/shared/lib/ws';
import { ApiError, errorMessage } from '@/shared/lib/api';
import { notifySaveDiagnostics } from '@/shared/lib/save-diagnostics';
import { gateCandidate } from '@/features/backtest/lib/gate-candidate';
import {
  abortBacktest,
  backtestListQueryKey,
  backtestRunQueryKey,
  createBacktest,
  fetchBacktestRun,
  retryBacktest,
} from '@/features/backtest/api/backtest';
import type { RunFilter } from './use-backtest-history';

type Banner = { kind: 'ok' | 'err'; message: string } | null;

/** "2m 30s" / "45s" from a millisecond estimate, or null when not meaningful. */
function formatEta(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export interface BacktestRunArgs {
  profileId: string;
  accountId: string;
  activeRunId: string | null;
  showRun: (runId: string | null) => void;
  setBanner: (b: Banner) => void;
  descriptor: StrategyDescriptor | undefined;
  profile: UseQueryResult<ProfileResponse>;
  queryClient: QueryClient;
  // Owned by the history slice; run resets the page and writes the optimistic
  // list row through these.
  setPage: (p: { cursor: string | null; history: readonly (string | null)[] }) => void;
  setPendingDedup: (v: { runId: string; params: BacktestParams } | null) => void;
  runFilter: RunFilter;
  runsLimitParam: number | null;
  runsFilterParam: RunFilter | null;
  runsKindParam: string | null;
}

export function useBacktestRun({
  profileId,
  accountId,
  activeRunId,
  showRun,
  setBanner,
  descriptor,
  profile,
  queryClient,
  setPage,
  setPendingDedup,
  runFilter,
  runsLimitParam,
  runsFilterParam,
  runsKindParam,
}: BacktestRunArgs) {
  // Live progress pushed over the profile WebSocket — a low-latency overlay on
  // the polled run row. Reset when the active run changes so a prior run's phase
  // cannot bleed into the next.
  const [liveProgress, setLiveProgress] = useState<BacktestProgressPayload | null>(null);
  // Wall-clock at the first replay frame, the honest origin for the ETA: the
  // run's startedAt precedes backfill + warm-up, so dividing elapsed-since-start
  // by replay ticks would over-estimate by the whole load time. Null until the
  // first replay frame, and reset per run.
  const replayStartMsRef = useRef<number | null>(null);
  useEffect(() => {
    setLiveProgress(null);
    replayStartMsRef.current = null;
  }, [activeRunId]);
  const handleBacktestFrame = useCallback(
    (frame: SocketFrame): void => {
      if (frame.topic === 'backtest-progress') {
        if (activeRunId && frame.payload.runId === activeRunId) {
          if (frame.payload.phase === 'replay' && replayStartMsRef.current === null) {
            replayStartMsRef.current = Date.now();
          }
          setLiveProgress(frame.payload);
        }
      } else if (frame.topic === 'backtest-complete') {
        if (activeRunId && frame.payload.runId === activeRunId) {
          void queryClient.invalidateQueries({
            queryKey: backtestRunQueryKey(profileId, activeRunId),
          });
        }
      }
    },
    [activeRunId, profileId, queryClient],
  );
  useProfileSocketHandlers({
    profileId,
    url: (since) => buildProfileWsUrl(accountId, profileId, since),
    onMessage: handleBacktestFrame,
  });

  const activeRun = useQuery({
    queryKey: activeRunId
      ? backtestRunQueryKey(profileId, activeRunId)
      : ['backtest', 'run', 'none'],
    queryFn: () => fetchBacktestRun(profileId, activeRunId as string),
    enabled: activeRunId !== null,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === 'queued' || s === 'running' ? 1500 : false;
    },
  });

  // A `?run=` deep link can point at a run that 404s. Surface it and fall back to
  // an empty Results view instead of a permanent "loading". 404 only.
  const activeRunError = activeRun.error;
  useEffect(() => {
    if (activeRunId && activeRunError instanceof ApiError && activeRunError.status === 404) {
      setBanner({ kind: 'err', message: 'That backtest run no longer exists.' });
      showRun(null);
    }
  }, [activeRunId, activeRunError, showRun, setBanner]);

  const status = activeRun.data?.status;
  const viewedDone = status === 'done';
  const parentRunId = activeRun.data?.parentRunId ?? null;

  useEffect(() => {
    if (status === 'done' || status === 'error') {
      // A new terminal run shifts the head of the list; snap back to the first
      // page so the cursor stack stays coherent with the new insert.
      setPage({ cursor: null, history: [] });
      void queryClient.invalidateQueries({ queryKey: ['backtest', 'list', profileId] });
    }
  }, [status, profileId, queryClient, setPage]);

  const launch = useMutation({
    mutationFn: ({ body, force }: { body: BacktestParams; force?: boolean }) =>
      createBacktest(profileId, body, force ? { force: true } : {}),
    onSuccess: (created, { body }) => {
      // The API dedups an identical re-run: instead of a new run it returns the
      // existing completed one with `deduped:true`. Block on an explicit choice.
      if (created.deduped) {
        setPendingDedup({ runId: created.runId, params: body });
        return;
      }
      showRun(created.runId);
      setBanner({ kind: 'ok', message: 'Backtest queued.' });
      notifySaveDiagnostics(created.diagnostics);
      setPage({ cursor: null, history: [] });
      // Show the queued row instantly instead of waiting for the list refetch.
      if (runFilter === 'all') {
        const optimistic: BacktestListItem = {
          runId: created.runId,
          status: 'queued',
          progress: 0,
          symbols: body.symbols,
          fromMs: body.fromMs,
          toMs: body.toMs,
          createdAt: new Date().toISOString(),
          finishedAt: null,
          totalReturnPct: null,
        };
        queryClient.setQueryData<BacktestListResponse>(
          backtestListQueryKey(profileId, null, runsLimitParam, runsFilterParam, runsKindParam),
          (prev) => {
            if (!prev) return { items: [optimistic], nextCursor: null, total: 1 };
            const existed = prev.items.some((r) => r.runId === created.runId);
            return {
              ...prev,
              items: [optimistic, ...prev.items.filter((r) => r.runId !== created.runId)],
              total: existed ? prev.total : prev.total + 1,
            };
          },
        );
      }
      void queryClient.invalidateQueries({ queryKey: ['backtest', 'list', profileId] });
    },
    onError: (err) => setBanner({ kind: 'err', message: errorMessage(err) }),
  });

  // Abort a hung queued/running run.
  const abort = useMutation({
    mutationFn: (runId: string) => abortBacktest(profileId, runId),
    onSuccess: (detail) => {
      setBanner({ kind: 'ok', message: `Run ${detail.runId.slice(0, 8)} aborted.` });
      void queryClient.invalidateQueries({ queryKey: ['backtest', 'list', profileId] });
      void queryClient.invalidateQueries({
        queryKey: backtestRunQueryKey(profileId, detail.runId),
      });
    },
    onError: (err) => setBanner({ kind: 'err', message: errorMessage(err) }),
  });

  // Retry a finished error/cancelled run: re-runs its stored config as a fresh run.
  const retry = useMutation({
    mutationFn: (runId: string) => retryBacktest(profileId, runId),
    onSuccess: (created) => {
      showRun(created.runId);
      setBanner({ kind: 'ok', message: 'Backtest re-queued.' });
      setPage({ cursor: null, history: [] });
      void queryClient.invalidateQueries({ queryKey: ['backtest', 'list', profileId] });
    },
    onError: (err) => setBanner({ kind: 'err', message: errorMessage(err) }),
  });

  const liveForActive = liveProgress?.runId === activeRunId ? liveProgress : null;
  const progress = liveForActive?.pct ?? activeRun.data?.progress ?? 0;
  const progressDetail: BacktestProgressDetail | null =
    liveForActive ?? activeRun.data?.progressDetail ?? null;
  const replayStartMs = replayStartMsRef.current;
  const etaLabel =
    progressDetail?.phase === 'replay' &&
    progressDetail.processed &&
    progressDetail.total &&
    replayStartMs
      ? formatEta(
          ((Date.now() - replayStartMs) / progressDetail.processed) *
            (progressDetail.total - progressDetail.processed),
        )
      : null;
  const result = status === 'done' ? activeRun.data?.result : undefined;
  const testedConfig = result?.params.strategyConfigOverride;
  // The full config the run executed: prefer the persisted resolvedConfig, else
  // merge the current profile config with the override.
  const attributionConfig = useMemo(
    () =>
      (result?.resolvedConfig ??
        mergeConfig(
          (profile.data?.config ?? {}) as Record<string, unknown>,
          (testedConfig ?? {}) as Record<string, unknown>,
        )) as Record<string, unknown>,
    [result?.resolvedConfig, profile.data?.config, testedConfig],
  );

  // Apply writes the config; it does not enable the profile.
  const policy = profile.data?.enablementPolicy;
  const applyWarning = ((): string | null => {
    if (!result) return null;
    const lostToHold = recommendTradeOrHold(result.metrics).recommend === 'hold';
    const belowGate =
      policy !== undefined &&
      !gateThresholdChecks(
        gateCandidate(result.metrics, result.outOfSample, result.dataWarnings),
        policy,
      ).every((c) => c.ok);
    if (!lostToHold && !belowGate) return null;
    return 'Applying updates the live config, but this run didn’t clear the live gate (it lost to simply holding, or fell short of the gate’s thresholds). Enabling live is never blocked, but if you’ve turned on “pause new buys when unproven,” a live profile on this config keeps its new buys paused until a run clears the gate.';
  })();

  return {
    activeRunId,
    launch,
    abort,
    retry,
    activeRun,
    activeRunData: activeRun.data,
    status,
    viewedDone,
    parentRunId,
    progress,
    progressDetail,
    etaLabel,
    result,
    testedConfig,
    attributionConfig,
    applyWarning,
    descriptor,
    profileData: profile.data,
  };
}
