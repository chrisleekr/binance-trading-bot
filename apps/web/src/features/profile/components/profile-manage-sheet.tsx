import { Settings2 } from 'lucide-react';
import { useState } from 'react';

import { InvestigateSheet } from '@/features/profile/components/investigate-sheet';
import { ProfileManageCard } from '@/features/profile/components/profile-manage-card';
import { Button } from '@/shared/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/shared/components/ui/sheet';

/** Which drawer is on screen. Never two — see the note on the state below. */
type ManageView = 'closed' | 'manage' | 'investigate';

/**
 * Moves the per-profile admin actions off the overview scroll into a right
 * slide-over. The overview keeps a single "Manage profile" affordance; the full
 * action grid (configure / analyze / operate / danger) opens on demand. Reuses
 * the existing ProfileManageCard verbatim as the sheet body.
 *
 * The Investigate drawer opens from inside that grid, so one three-way state
 * governs both rather than a boolean each. Both are Radix modal dialogs: nesting
 * them means two focus traps fighting over the same document and a
 * `pointer-events: none` the inner one leaves behind when it unmounts. A single
 * state makes "manage closes as investigate opens" the only representable
 * transition instead of a sequencing rule someone has to remember.
 */
export function ProfileManageSheet({
  profileId,
}: {
  readonly profileId: string;
}): React.JSX.Element {
  const [view, setView] = useState<ManageView>('closed');
  return (
    <>
      <Sheet open={view === 'manage'} onOpenChange={(next) => setView(next ? 'manage' : 'closed')}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setView('manage')}
          data-testid="open-manage-sheet"
          className="gap-2"
        >
          <Settings2 className="h-4 w-4" aria-hidden />
          Manage profile
        </Button>
        <SheetContent
          side="right"
          className="w-full overflow-y-auto sm:max-w-md"
          data-testid="manage-sheet"
        >
          <SheetHeader>
            <SheetTitle>Manage profile</SheetTitle>
            <SheetDescription>Configure, analyze, and operate this profile.</SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            <ProfileManageCard profileId={profileId} onInvestigate={() => setView('investigate')} />
          </div>
        </SheetContent>
      </Sheet>
      <InvestigateSheet
        profileId={profileId}
        open={view === 'investigate'}
        onOpenChange={(next) => setView(next ? 'investigate' : 'closed')}
      />
    </>
  );
}
