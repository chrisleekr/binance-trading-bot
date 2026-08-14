// "Why isn't it trading?" — the visible trigger on the profile landing header.
//
// Trigger and drawer are separate components because the drawer also opens from
// inside the Manage slide-over, where the two dialogs must hand over rather than
// stack. This wrapper owns nothing but its own open flag; everything the
// investigation does lives in InvestigateSheet.
//
// The label reads the run status so a live investigation stays visible after the
// operator closes the drawer — the run is server-side and keeps going.

import { Loader2, Stethoscope } from 'lucide-react';
import { useState } from 'react';

import { InvestigateSheet } from '@/features/profile/components/investigate-sheet';
import { useDiagnosisRunStatus } from '@/features/profile/lib/use-diagnosis-run-status';
import { Button } from '@/shared/components/ui/button';

export function InvestigateButton({
  profileId,
}: {
  readonly profileId: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const { isLive } = useDiagnosisRunStatus(profileId);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="open-investigate"
        className="gap-2"
      >
        {isLive ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <Stethoscope className="h-4 w-4" aria-hidden />
        )}
        {isLive ? 'Investigating' : 'Investigate'}
      </Button>
      <InvestigateSheet profileId={profileId} open={open} onOpenChange={setOpen} />
    </>
  );
}
