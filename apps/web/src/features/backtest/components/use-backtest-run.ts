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
}: BacktestRunArgs) {
  // Keeping the selected run with its live progress prevents a prior run's final frame from bleeding into the next run.
  type LiveProgress = {
    payload: BacktestProgressPayload;
    receivedAtMs: number;
    replayStartedAtMs: number | null;
  };
  const [liveProgressState, setLiveProgressState] = useState<{
    selectedRunId: string | null;
    progress: LiveProgress | null;
  }>(() => ({ selectedRunId: activeRunId, progress: null }));
  if (liveProgressState.selectedRunId !== activeRunId) {
    setLiveProgressState({ selectedRunId: activeRunId, progress: null });
  }
  const liveProgress =
    liveProgressState.selectedRunId === activeRunId ? liveProgressState.progress : null;
  const launchedRunIdRef = useRef<string | null>(null);
  const handleBacktestFrame = useCallback(
    (frame: SocketFrame): void => {
      if (frame.topic === 'backtest-progress') {
        if (activeRunId && frame.payload.runId === activeRunId) {
          setLiveProgressState((previousState) => {
            const receivedAtMs = Date.now();
            const previous =
              previousState.selectedRunId === activeRunId ? previousState.progress : null;
            const sameRun = previous?.payload.runId === frame.payload.runId;
            const replayStartedAtMs =
              frame.payload.phase === 'replay'
                ? sameRun
                  ? (previous.replayStartedAtMs ?? receivedAtMs)
                  : receivedAtMs
                : sameRun
                  ? previous.replayStartedAtMs
                  : null;
            return {
              selectedRunId: activeRunId,
              progress: { payload: frame.payload, receivedAtMs, replayStartedAtMs },
            };
          });
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
    if (!activeRunId || !(activeRunError instanceof ApiError) || activeRunError.status !== 404) {
      return;
    }
    const handleMissing = setTimeout(() => {
      setBanner({ kind: 'err', message: 'That backtest run no longer exists.' });
      showRun(null);
    }, 0);
    return () => clearTimeout(handleMissing);
  }, [activeRunId, activeRunError, showRun, setBanner]);

  const status = activeRun.data?.status;
  const viewedDone = status === 'done';
  const parentRunId = activeRun.data?.parentRunId ?? null;
  const previousRunRef = useRef({ runId: activeRunId, status });

  useEffect(() => {
    const previous = previousRunRef.current;
    previousRunRef.current = { runId: activeRunId, status };
    if (status !== 'done' && status !== 'error') return;
    const observedTransition =
      previous.runId === activeRunId &&
      (previous.status === 'queued' || previous.status === 'running');
    if (!observedTransition && launchedRunIdRef.current !== activeRunId) return;
    launchedRunIdRef.current = null;
    const refreshHistory = setTimeout(() => {
      setPage({ cursor: null, history: [] });
      void queryClient.invalidateQueries({ queryKey: ['backtest', 'list', profileId] });
    }, 0);
    return () => clearTimeout(refreshHistory);
  }, [activeRunId, status, profileId, queryClient, setPage]);

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
      launchedRunIdRef.current = created.runId;
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
          // A queued run has executed no config yet; the fingerprint is stamped at completion.
          configFingerprint: null,
        };
        queryClient.setQueryData<BacktestListResponse>(
          backtestListQueryKey(profileId, null, runsLimitParam, runsFilterParam),
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
      launchedRunIdRef.current = created.runId;
      showRun(created.runId);
      setBanner({ kind: 'ok', message: 'Backtest re-queued.' });
      setPage({ cursor: null, history: [] });
      void queryClient.invalidateQueries({ queryKey: ['backtest', 'list', profileId] });
    },
    onError: (err) => setBanner({ kind: 'err', message: errorMessage(err) }),
  });

  const liveForActive = liveProgress?.payload.runId === activeRunId ? liveProgress : null;
  const progress = liveForActive?.payload.pct ?? activeRun.data?.progress ?? 0;
  const progressDetail: BacktestProgressDetail | null =
    liveForActive?.payload ?? activeRun.data?.progressDetail ?? null;
  const replayStartMs = liveForActive?.replayStartedAtMs;
  const etaLabel =
    progressDetail?.phase === 'replay' &&
    progressDetail.processed &&
    progressDetail.total &&
    replayStartMs
      ? formatEta(
          ((liveForActive.receivedAtMs - replayStartMs) / progressDetail.processed) *
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
