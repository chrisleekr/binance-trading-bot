// LOGS tab of the symbol workspace: the live action-log stream (REST window
// merged with WS frames) and the destructive advanced drawer (grid reset/wipe).
// The drawer sits last because its actions are rare and irreversible.

import { SymbolAdvancedDrawer } from '@/features/symbol/components/symbol-advanced-drawer';
import { SymbolLogsPanel } from '@/features/symbol/components/symbol-logs-panel';
import { Card } from '@/shared/components/ui/card';

import type { SymbolLogEntry } from '@app/contracts';

export function WorkspaceLogsTab({
  profileId,
  symbol,
  liveLog,
  operatorActions,
  onWiped,
}: {
  profileId: string;
  symbol: string;
  liveLog: SymbolLogEntry | null;
  operatorActions: ReadonlySet<string>;
  onWiped: () => void;
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      <Card>
        <SymbolLogsPanel profileId={profileId} symbol={symbol} liveFrame={liveLog} />
      </Card>

      <SymbolAdvancedDrawer
        profileId={profileId}
        symbol={symbol}
        showGridActions={
          operatorActions.has('archive-grid') ||
          operatorActions.has('reset-grid') ||
          operatorActions.has('avg-entry-price')
        }
        onWiped={onWiped}
      />
    </div>
  );
}
