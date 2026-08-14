// "This position has no safety net right now." Louder than the entry blocker: an
// entry that does not fire costs an opportunity, an open position with no
// protective stop costs money if the price falls. Renders nothing when the stop
// is armed (or there is no position).

import type { SymbolStateResponse } from '@app/contracts';

import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import {
  blockerPositionGuarded,
  glossProtectiveStopBlocker,
} from '@/shared/lib/gloss-protective-stop-blocker';

export function SymbolProtectiveStopBlocker({
  protectiveStopBlocker,
}: {
  readonly protectiveStopBlocker: SymbolStateResponse['protectiveStopBlocker'];
}): React.JSX.Element | null {
  if (!protectiveStopBlocker) return null;
  // A stop that is still resting at a stale level is a smaller emergency than no
  // stop at all, and red on both trains the operator to skim past the real one.
  const stale = blockerPositionGuarded(protectiveStopBlocker);
  return (
    <Alert variant={stale ? 'warning' : 'danger'} data-testid="symbol-protective-stop-blocker">
      <AlertTitle>
        {stale ? 'Protective stop stuck at an older level' : 'Protective stop not in place'}
      </AlertTitle>
      <AlertDescription>{glossProtectiveStopBlocker(protectiveStopBlocker)}</AlertDescription>
    </Alert>
  );
}
