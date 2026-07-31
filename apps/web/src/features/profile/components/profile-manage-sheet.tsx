import { Settings2 } from 'lucide-react';
import { useState } from 'react';

import { ProfileManageCard } from '@/features/profile/components/profile-manage-card';
import { Button } from '@/shared/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/shared/components/ui/sheet';

/**
 * Moves the per-profile admin actions off the overview scroll into a right
 * slide-over. The overview keeps a single "Manage profile" affordance; the full
 * action grid (configure / analyze / operate / danger) opens on demand. Reuses
 * the existing ProfileManageCard verbatim as the sheet body.
 */
export function ProfileManageSheet({
  profileId,
}: {
  readonly profileId: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
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
          <ProfileManageCard profileId={profileId} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
