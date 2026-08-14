// "Why isn't it trading?" — the investigation drawer, as a CONTROLLED sheet.
//
// The run is durable and server-side, so closing this drawer does not cancel
// anything: reopening returns to whatever the worker has written since. Nothing
// here is cancel-on-close, and nothing here advances on its own.
//
// Open state is the caller's because the drawer has two entry points and one of
// them is another dialog. Both are Radix modal dialogs, and two of them mounted
// at once break the focus trap and strand `pointer-events: none` on the body —
// so the owner of the state is whoever can guarantee only one is ever open.

import { useState } from 'react';
import { DIAGNOSIS_STEPS } from '@app/contracts';

import {
  DiagnosisConfirm,
  DiagnosisRunBody,
} from '@/features/profile/components/diagnosis-run-view';
import { useDiagnosisRunStatus } from '@/features/profile/lib/use-diagnosis-run-status';
import { LoadingRows } from '@/shared/components/page-skeleton';
import { Button } from '@/shared/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/shared/components/ui/sheet';

export function InvestigateSheet({
  profileId,
  open,
  onOpenChange,
}: {
  readonly profileId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  // Starting a second run replaces what the drawer shows; until the operator
  // asks for one, a finished run stays on screen rather than being re-offered.
  // Cleared only once the new run is in the cache, so the drawer never flashes
  // the previous report in the gap between the click and the 202.
  const [restarting, setRestarting] = useState(false);
  const { latest, isLive, isLoading, start } = useDiagnosisRunStatus(profileId);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setRestarting(false);
        onOpenChange(next);
      }}
    >
      <SheetContent
        side="right"
        className="w-full overflow-y-auto sm:max-w-lg"
        data-testid="investigate-sheet"
      >
        <SheetHeader>
          <SheetTitle>Why isn&rsquo;t it trading?</SheetTitle>
          <SheetDescription>
            {/* Counted from the ladder, not written down: a hand-typed number drifts the
                moment a rung is added, on a surface whose whole claim is that it does not
                overstate what it measured. */}
            {DIAGNOSIS_STEPS.length} checks, in the order that matters, against what this profile
            actually did.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4">
          {isLoading ? (
            <LoadingRows rows={4} />
          ) : restarting || latest === undefined ? (
            <DiagnosisConfirm
              isStarting={start.isPending}
              onConfirm={(liveProbe) => {
                start.mutate(liveProbe, { onSuccess: () => setRestarting(false) });
              }}
            />
          ) : (
            <>
              <DiagnosisRunBody run={latest} profileId={profileId} />
              {isLive ? null : (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => setRestarting(true)}
                  data-testid="investigate-again"
                >
                  Check again
                </Button>
              )}
            </>
          )}
          {start.isError ? (
            <p className="mt-3 text-sm text-danger" data-testid="investigate-start-error">
              The investigation could not be started. Nothing was changed.
            </p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
