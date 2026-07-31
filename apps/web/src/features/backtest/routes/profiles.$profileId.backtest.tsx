// /profiles/$profileId/backtest. Tune the strategy config against history.
//
// A tabbed workbench: Configure (the action surface), Results (the anchored
// run's progress + outcome), and History (past runs). The active tab lives in
// the `?view=` search param alongside `?run=`, so the whole surface is
// URL-restorable. On load with a `?run=` deep link or a newest past run to
// auto-anchor, the surface opens on Results; otherwise on Configure. Launching
// or selecting a run switches to Results; "Adjust & re-run" switches to
// Configure, pre-seeded from the anchored run.
//
// All three tab panels stay mounted (only their visibility toggles), so the
// config form keeps unsaved edits across a tab switch or a data refetch. The
// shared state lives in useBacktestWorkbench; this file is the shell — header,
// tabs, and the two confirm dialogs.

import { createRoute } from '@tanstack/react-router';

import { Page } from '@/shared/components/page';
import { ProfilePageHeader } from '@/features/profile/components/profile-page-header';
import { ActionBanner } from '@/shared/components/action-banner';
import { FormActions } from '@/shared/components/form-actions';
import { Button } from '@/shared/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';
import { ConfigureTab } from '@/features/backtest/components/configure-tab';
import { ResultsTab } from '@/features/backtest/components/results-tab';
import { HistoryTab } from '@/features/backtest/components/history-tab';
import {
  useBacktestWorkbench,
  type BacktestSearch,
  TAB_KEYS,
  type TabKey,
} from '@/features/backtest/components/use-backtest-workbench';
import { isOneOf } from '@/shared/lib/search-param';

function BacktestPage(): React.JSX.Element {
  const { profileId } = backtestRoute.useParams();
  const search = backtestRoute.useSearch();
  const wb = useBacktestWorkbench(profileId, search);

  return (
    <Page className="space-y-4">
      <ProfilePageHeader profileId={profileId} title="Backtest" />

      <ActionBanner banner={wb.banner} />

      <Tabs value={wb.activeTab} onValueChange={(v) => wb.setTab(v as TabKey)}>
        <TabsList className="flex w-full">
          <TabsTrigger value="configure" className="flex-1" data-testid="bt-tab-configure">
            Configure
          </TabsTrigger>
          <TabsTrigger value="results" className="flex-1" data-testid="bt-tab-results">
            Results
          </TabsTrigger>
          <TabsTrigger value="history" className="flex-1" data-testid="bt-tab-history">
            History
          </TabsTrigger>
        </TabsList>

        {/* forceMount keeps every panel in the tree so unsaved config edits and
            in-flight query state survive a tab switch; the inactive panels are
            hidden with CSS rather than unmounted. */}
        <TabsContent value="configure" forceMount className="data-[state=inactive]:hidden">
          <ConfigureTab wb={wb} />
        </TabsContent>
        <TabsContent value="results" forceMount className="data-[state=inactive]:hidden">
          <ResultsTab wb={wb} />
        </TabsContent>
        <TabsContent value="history" forceMount className="data-[state=inactive]:hidden">
          <HistoryTab wb={wb} />
        </TabsContent>
      </Tabs>

      <Dialog
        open={wb.history.confirmDelete !== null}
        onOpenChange={(o) => {
          if (!o) wb.history.setConfirmDelete(null);
        }}
      >
        <DialogContent data-testid="backtest-delete-dialog">
          <DialogHeader>
            <DialogTitle>{wb.history.deleteCopy.title}</DialogTitle>
            <DialogDescription>{wb.history.deleteCopy.body}</DialogDescription>
          </DialogHeader>
          <FormActions className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => wb.history.setConfirmDelete(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={wb.history.deleteBusy}
              onClick={() => {
                const d = wb.history.confirmDelete;
                if (d?.kind === 'run') wb.history.del.mutate(d.runId);
                else if (d?.kind === 'bulk') wb.history.bulkDel.mutate(d.runIds);
              }}
              data-testid="backtest-delete-confirm"
            >
              {wb.history.deleteBusy ? 'Deleting…' : wb.history.deleteCopy.confirmLabel}
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>

      <Dialog
        open={wb.history.pendingDedup !== null}
        onOpenChange={(o) => {
          if (!o) wb.history.setPendingDedup(null);
        }}
      >
        <DialogContent data-testid="backtest-dedup-dialog">
          <DialogHeader>
            <DialogTitle>You already ran this exact backtest.</DialogTitle>
            <DialogDescription>
              A finished run with this exact config and window already exists. Load its saved
              result, or run it fresh anyway to queue a new run.
            </DialogDescription>
          </DialogHeader>
          <FormActions className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (wb.history.pendingDedup)
                  wb.run.launch.mutate({ body: wb.history.pendingDedup.params, force: true });
                wb.history.setPendingDedup(null);
              }}
              data-testid="backtest-dedup-run-fresh"
            >
              Run fresh anyway
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                if (wb.history.pendingDedup) wb.showRun(wb.history.pendingDedup.runId);
                wb.history.setPendingDedup(null);
              }}
              data-testid="backtest-dedup-load-existing"
            >
              Load existing result
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

export const backtestRoute = createRoute({
  staticData: { title: 'Backtest' },
  getParentRoute: () => profileDetailRoute,
  path: 'backtest',
  component: BacktestPage,
  // Optional `?symbol=` carried from a symbol drill-down so the form pre-selects
  // it, `?run=` so a finished run is shareable and reloadable by link, `?view=`
  // so the active Configure/Results/History tab is URL-restorable (`view`, not
  // `tab`, to avoid colliding with the symbol-workspace route's differently-typed
  // `tab` param), and `?autorun=1` to launch a run on arrival. Unlisted params are
  // stripped, so `autorun` must be declared here to survive into the component.
  validateSearch: (search: Record<string, unknown>): BacktestSearch => {
    const out: BacktestSearch = {};
    if (typeof search['symbol'] === 'string') out.symbol = search['symbol'];
    if (typeof search['run'] === 'string') out.run = search['run'];
    if (isOneOf(TAB_KEYS)(search['view'])) out.view = search['view'];
    // Accepts `1`/`true` in either type: the param is hand-written into links,
    // and TanStack parses an unquoted `1` as a number.
    const a = search['autorun'];
    if (a === true || a === 1 || a === '1' || a === 'true') out.autorun = true;
    return out;
  },
});
