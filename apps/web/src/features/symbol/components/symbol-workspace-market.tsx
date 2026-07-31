// MARKET tab of the symbol workspace: the Technicals buy-gate readout, the live
// order book and recent trades, and the auto-discovery removal status. The book
// and trades panels open their own WS subscriptions on mount, so those streams
// start only when the operator opens this tab.

import { SymbolDiscoveryStatus } from '@/features/symbol/components/symbol-discovery-status';
import { SymbolOrderBookPanel } from '@/features/symbol/components/symbol-order-book-panel';
import { SymbolRecentTradesPanel } from '@/features/symbol/components/symbol-recent-trades-panel';
import { SymbolTechnicalsPanel } from '@/features/symbol/components/symbol-technicals-panel';
import { Card } from '@/shared/components/ui/card';

export function WorkspaceMarketTab({
  profileId,
  symbol,
  lastPrice,
  operatorActions,
  flat,
}: {
  profileId: string;
  symbol: string;
  lastPrice: string | null;
  operatorActions: ReadonlySet<string>;
  // undefined while symbol state is still loading — defer the discovery panel
  // rather than render its "holding" headline against an unknown position.
  flat: boolean | undefined;
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      {/* Auto-discovery removal status — renders only for an auto-managed
          symbol. `flat` is the reap flat-guard condition (no position AND no
          resting orders); a non-flat symbol is never auto-dropped. */}
      {flat !== undefined ? (
        <SymbolDiscoveryStatus profileId={profileId} symbol={symbol} flat={flat} />
      ) : null}

      {/* Gated on `trigger-buy`: the Technicals buy-gate readout only means
          something for a strategy whose buy a force-trigger can bypass. A
          strategy that honors no force-buy gets no technicals data. */}
      {operatorActions.has('trigger-buy') ? (
        <Card>
          <SymbolTechnicalsPanel profileId={profileId} symbol={symbol} />
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <SymbolOrderBookPanel profileId={profileId} symbol={symbol} lastPrice={lastPrice} />
        </Card>
        <Card className="flex flex-col">
          <SymbolRecentTradesPanel profileId={profileId} symbol={symbol} />
        </Card>
      </div>
    </div>
  );
}
