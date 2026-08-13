// One plain-language status line answering "why isn't the bot buying this coin
// right now?". The symbol-state response carries a structured `entryBlocker`
// (the strategy's own reason code + sparse detail); the shared gloss turns each
// code into a sentence and this renders nothing when nothing is blocking.

import type { SymbolStateResponse } from '@app/contracts';

import { Card } from '@/shared/components/ui/card';
import { glossEntryBlocker } from '@/shared/lib/gloss-entry-blocker';

export function SymbolEntryBlocker({
  entryBlocker,
}: {
  readonly entryBlocker: SymbolStateResponse['entryBlocker'];
}): React.JSX.Element | null {
  if (!entryBlocker) return null;
  return (
    <Card data-testid="symbol-entry-blocker" className="space-y-1">
      <h2 className="text-sm font-semibold text-fg">Not buying right now</h2>
      <p className="text-sm text-muted-fg">{glossEntryBlocker(entryBlocker)}</p>
    </Card>
  );
}
