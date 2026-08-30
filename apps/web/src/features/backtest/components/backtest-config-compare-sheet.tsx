// The drawer that answers "what did these two runs differ by?".
//
// The past-runs list already carries each run's config FINGERPRINT, which is enough to say WHETHER two runs match but never WHAT changed. The resolved config that answers it lives on the run detail, one fetch per run, and is deliberately not added to the list projection: a page of twenty rows would then carry twenty full strategy configs to answer a question the operator asks about two of them.

import { useQuery } from '@tanstack/react-query';

import type { BacktestRunDetail } from '@app/contracts';
import { backtestRunQueryKey, fetchBacktestRun } from '@/features/backtest/api/backtest';
import { LoadingRows } from '@/shared/components/page-skeleton';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/shared/components/ui/sheet';
import { BacktestConfigDiff, type RunConfigSide } from './backtest-config-diff';

/** One run as the list knows it, before its resolved config has been fetched. */
export interface CompareSide {
  readonly runId: string;
  readonly label: string;
  readonly configFingerprint: string | null;
}

/**
 * Fetch one side's run detail for the resolved config it carries.
 *
 * Disabled while the drawer is closed and while the side is unpicked, so opening the drawer is what costs the two requests and merely arming the first run costs nothing. The disabled branch still passes a stable query key, because a key that changes shape between renders re-registers the observer on every commit.
 *
 * @param profileId - The profile the runs belong to, part of the run-detail cache key.
 * @param side - The picked run, or null while the operator has not picked one.
 * @param enabled - Whether the drawer is open; no fetch fires while it is not.
 * @returns The run-detail query, whose data is undefined until it resolves.
 */
function useSideDetail(
  profileId: string,
  side: CompareSide | null,
  enabled: boolean,
): ReturnType<typeof useQuery<BacktestRunDetail>> {
  return useQuery({
    queryKey: side
      ? backtestRunQueryKey(profileId, side.runId)
      : ['backtest', 'run', 'compare-none'],
    queryFn: () => fetchBacktestRun(profileId, side?.runId as string),
    enabled: enabled && side !== null,
  });
}

/**
 * Assemble one side for the diff from what the list knew plus what the detail returned.
 *
 * A run whose detail has not arrived yet must NOT reach the diff: the diff reads a null resolved config as "this run never recorded one", which is a permanent fact about the run, and a request still in flight would be reported as that. The caller renders a loading state instead while this returns null.
 *
 * @param side - The picked run as the list knows it, or null.
 * @param query - That run's detail query.
 * @returns The diff-ready side, or null while the detail is still unresolved.
 */
function toSide(
  side: CompareSide | null,
  query: ReturnType<typeof useSideDetail>,
): RunConfigSide | null {
  if (!side || query.isPending || query.isError) return null;
  return {
    runId: side.runId,
    label: side.label,
    configFingerprint: side.configFingerprint,
    resolvedConfig: query.data?.result?.resolvedConfig ?? null,
  };
}

/**
 * Compare the settings of two past runs, full-screen on mobile.
 *
 * @param props - The profile, the two picked runs, and the controlled open state.
 * @returns The comparison drawer.
 */
export function BacktestConfigCompareSheet({
  profileId,
  a,
  b,
  open,
  onOpenChange,
}: {
  readonly profileId: string;
  readonly a: CompareSide | null;
  readonly b: CompareSide | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryA = useSideDetail(profileId, a, open);
  const queryB = useSideDetail(profileId, b, open);
  const sideA = toSide(a, queryA);
  const sideB = toSide(b, queryB);
  const failed = queryA.isError || queryB.isError;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[85svh] overflow-y-auto"
        data-testid="backtest-config-compare-sheet"
      >
        <SheetHeader>
          <SheetTitle>Config difference</SheetTitle>
          <SheetDescription>
            The settings these two runs executed. Two runs of one coin over one market window differ
            only by config, so this is what separates a confirmation from a coincidence.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4">
          {failed ? (
            <p className="text-sm text-down" data-testid="backtest-config-compare-error">
              One of the two runs could not be loaded, so the comparison is not being shown rather
              than shown against half its input. Close and try again.
            </p>
          ) : sideA && sideB ? (
            <BacktestConfigDiff a={sideA} b={sideB} />
          ) : (
            <LoadingRows rows={3} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
