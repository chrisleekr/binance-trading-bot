// Composition root for the backtest workbench, consumed by the Configure /
// Results / History tabs and the thin route shell. Mounted once in the route
// shell, it owns the shell-level state (banner, active run identity, tab and run
// navigation writers) and wires four focused slices together: config (the draft
// + submit path), run (the anchored run lifecycle), history (past runs +
// deletion), and compare (verdict anchors + baseline pin). Kept as one mounted
// hook so the tabs stay pure presentation and unsaved config edits survive a tab
// switch (every tab's content stays mounted; the tabs only toggle visibility).

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useActiveAccountId } from '@/shared/lib/account-scope';
import { fetchProfile, profileQueryKey } from '@/features/profile/api/profile';
import { useStrategyDescriptor } from '@/shared/hooks/use-strategy-descriptor';
import { useBacktestConfig } from './use-backtest-config';
import { useBacktestRun } from './use-backtest-run';
import { useBacktestHistory } from './use-backtest-history';
import { useBacktestCompare } from './use-backtest-compare';
import { oneOf } from '@/shared/lib/search-param';

import { TAB_KEYS, type BacktestSearch, type TabKey } from './use-backtest-types';

export { TAB_KEYS } from './use-backtest-types';
export type { TabKey, BacktestSearch } from './use-backtest-types';
export type { ParamState } from './use-backtest-config';
export {
  RUNS_FILTERS,
  RUNS_PAGE_SIZES,
  deleteDialogCopy,
  type RunFilter,
  type PendingDelete,
} from './use-backtest-history';

/**
 * The whole workbench: mounted once in the route shell, its return object drives
 * every tab. `search` is the route's current search (the shell reads it via the
 * route so this hook stays free of the route import).
 */
export function useBacktestWorkbench(profileId: string, search: BacktestSearch) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const accountId = useActiveAccountId() ?? '';
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const profile = useQuery({
    queryKey: profileQueryKey(profileId),
    queryFn: () => fetchProfile(profileId),
  });
  const descriptor = useStrategyDescriptor(profileId, { matchVersion: true });
  const baselineBacktestRunId = profile.data?.baselineBacktestRunId ?? null;

  const symbolParam = search.symbol;
  const runParam = search.run;

  // The active run lives in the URL (`?run=`) so a finished run is shareable and
  // reloadable by link. `showRun` is the single writer: it sets the state and
  // mirrors it into the query string, and switches to the Results tab (selecting
  // or launching a run lands the operator on the answer). Clearing to null drops
  // the run and keeps the current tab.
  const showRun = useCallback(
    (runId: string | null): void => {
      setActiveRunId(runId);
      void navigate({
        to: '/accounts/$accountId/profiles/$profileId/backtest',
        params: { accountId, profileId },
        search: (prev) => {
          const next: BacktestSearch = {};
          if (prev.symbol !== undefined) next.symbol = prev.symbol;
          if (runId !== null) {
            next.run = runId;
            next.view = 'results';
          } else if (prev.view !== undefined) {
            next.view = prev.view;
          }
          return next;
        },
        replace: true,
      });
    },
    [navigate, accountId, profileId],
  );

  // Switch the active tab, preserving the run + symbol deep-link params.
  const setTab = useCallback(
    (tab: TabKey): void => {
      void navigate({
        to: '/accounts/$accountId/profiles/$profileId/backtest',
        params: { accountId, profileId },
        search: (prev) => {
          const next: BacktestSearch = { view: tab };
          if (prev.symbol !== undefined) next.symbol = prev.symbol;
          if (prev.run !== undefined) next.run = prev.run;
          return next;
        },
        replace: true,
      });
    },
    [navigate, accountId, profileId],
  );

  const history = useBacktestHistory({
    profileId,
    activeRunId,
    showRun,
    setBanner,
    baselineBacktestRunId,
    queryClient,
  });

  const run = useBacktestRun({
    profileId,
    accountId,
    activeRunId,
    showRun,
    setBanner,
    descriptor,
    profile,
    queryClient,
    setPage: history.setPage,
    setPendingDedup: history.setPendingDedup,
    runFilter: history.runFilter,
    runsLimitParam: history.runsLimitParam,
    runsFilterParam: history.runsFilterParam,
  });

  const config = useBacktestConfig({
    profileId,
    symbolParam,
    activeRunId,
    setBanner,
    setTab,
    profile,
    descriptor,
    launch: run.launch,
    activeRunData: run.activeRunData,
    result: run.result,
    attributionConfig: run.attributionConfig,
    testedConfig: run.testedConfig,
  });

  const compare = useBacktestCompare({
    profileId,
    activeRunId,
    viewedDone: run.viewedDone,
    parentRunId: run.parentRunId,
    baselineRunId: baselineBacktestRunId,
    setBanner,
    queryClient,
  });

  // Select a past run from the history list: mark it as an explicit pick (so its
  // config seeds the form), show its result, and switch to the Results tab.
  const selectRun = useCallback(
    (runId: string): void => {
      setBanner(null);
      config.requestConfigLoad(runId);
      showRun(runId);
    },
    [config.requestConfigLoad, showRun],
  );

  // Hydrate the active run from a `?run=` deep link once on mount, seeding the
  // config form from it like a history pick.
  const deepLinkRef = useRef(false);
  useEffect(() => {
    if (deepLinkRef.current) return;
    const hydrate = setTimeout(() => {
      deepLinkRef.current = true;
      if (runParam) {
        config.primeConfigLoad(runParam);
        setActiveRunId(runParam);
      }
    }, 0);
    return () => clearTimeout(hydrate);
  }, [runParam, config.primeConfigLoad]);

  // With no `?run=` deep link, anchor the surface to the newest past run on
  // first load so its result shows instead of an empty Results view.
  const autoAnchoredRef = useRef(false);
  useEffect(() => {
    if (autoAnchoredRef.current || runParam || activeRunId !== null) return;
    // Only the default landing (no `?view=`) or an explicit Results view should
    // anchor the newest run. An explicit Configure ("Run backtest on current
    // config") or History view is the operator's own choice — don't hijack it to
    // Results. Not latched, so switching to Results later still anchors the newest.
    if (search.view !== undefined && search.view !== 'results') return;
    if (!history.runsQuery.isSuccess) return; // wait for the first settled list; never auto-anchor twice
    const newest = history.runItems[0];
    const anchor = setTimeout(() => {
      autoAnchoredRef.current = true;
      if (newest) {
        config.markAutoAnchored(newest.runId);
        showRun(newest.runId);
      }
    }, 0);
    return () => clearTimeout(anchor);
  }, [
    history.runsQuery.isSuccess,
    history.runItems,
    activeRunId,
    runParam,
    search.view,
    showRun,
    config.markAutoAnchored,
  ]);

  // `?autorun=1`: launch a run on the current config as soon as the form can
  // produce one, then drop the param. Latched by a ref, not by the param alone:
  // the app's global MutationCache invalidate re-renders this tree on every
  // settled mutation (including the launch itself), so a param-only guard would
  // re-fire before the navigation that clears it lands.
  const autorunRef = useRef(false);
  useEffect(() => {
    if (autorunRef.current || !search.autorun) return;
    // Wait until the form is genuinely runnable: the strategy schema decides the
    // interval and the basket shape, and a non-basket run needs its seeded
    // symbol. Firing early would only produce a validation banner.
    const ready =
      config.configSchema !== null &&
      !config.profileLoading &&
      !config.strategiesLoading &&
      (config.isBasket || config.symbol !== '');
    if (!ready) return;
    autorunRef.current = true;
    config.launchCurrentConfig();
    void navigate({
      to: '/accounts/$accountId/profiles/$profileId/backtest',
      params: { accountId, profileId },
      search: (prev) => {
        const { autorun: _autorun, ...rest } = prev;
        return rest;
      },
      replace: true,
    });
  }, [
    search.autorun,
    config.configSchema,
    config.profileLoading,
    config.strategiesLoading,
    config.isBasket,
    config.symbol,
    config.launchCurrentConfig,
    navigate,
    accountId,
    profileId,
  ]);

  // Open the Configure view on a year-long lookback (today-365 .. today) when the
  // operator lands there with an empty window, so a fresh profile can run without
  // hand-filling two dates. Fires on the deliberate Configure entry (`?view=configure`,
  // set by the symbol Backtest link and the Configure tab) AND on the bare Configure
  // landing (no `?view=`, resolving to Configure via the same fallback `activeTab`
  // uses), while the `?run=`/auto-anchor, autorun, and touched-window guards still
  // keep it from pre-empting a loaded window, the 90-day autorun default, or an
  // edited window. Fires at most once.
  const windowSeededRef = useRef(false);
  useEffect(() => {
    if (windowSeededRef.current) return;
    // Bare landing (no `?view=`) resolves to Configure and seeds. The run/active-run
    // cases activeTab's fallback would route to 'results' are already short-circuited
    // by the guards on the next line, so `search.view ?? 'configure'` suffices here.
    const resolvedTab = search.view ?? 'configure';
    if (resolvedTab !== 'configure' || search.autorun || runParam || activeRunId !== null) return;
    if (config.params.from !== '' || config.params.to !== '') return;
    windowSeededRef.current = true;
    config.applyWindowPreset(365);
  }, [
    search.view,
    search.autorun,
    runParam,
    activeRunId,
    config.params.from,
    config.params.to,
    config.applyWindowPreset,
  ]);

  // The active tab: honor an explicit `?view=`, else default to Results when a run
  // is anchored (deep link or auto-anchored newest), otherwise Configure.
  // Re-validated here rather than trusted from validateSearch — see `oneOf` for
  // why the router cannot strip an unrecognised value. The fallback depends on
  // whether a run is anchored, which `validateSearch` cannot know.
  const fallbackTab: TabKey = activeRunId ? 'results' : 'configure';
  const activeTab = oneOf(search.view, TAB_KEYS, fallbackTab);

  return {
    profileId,
    banner,
    setBanner,
    activeTab,
    setTab,
    showRun,
    selectRun,
    config,
    run,
    history,
    compare,
  };
}

export type BacktestWorkbench = ReturnType<typeof useBacktestWorkbench>;
