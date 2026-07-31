import { Tabs, TabsList, TabsTrigger } from '@/shared/components/ui/tabs';
import type { PnlBasis } from '@/shared/hooks/use-pnl-basis';

/**
 * Net ↔ Gross switch for P/L readouts. "Net" subtracts Binance commissions
 * (what was actually kept); "Gross" is before fees. Net is the honest default.
 * Shared by the History P/L bands and the Home scoreboard so the choice reads
 * consistently across surfaces.
 */
export function PnlBasisToggle({
  basis,
  onBasisChange,
}: {
  basis: PnlBasis;
  onBasisChange: (next: PnlBasis) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-fg text-xs">P/L</span>
      <Tabs value={basis} onValueChange={(v) => onBasisChange(v as PnlBasis)}>
        <TabsList>
          <TabsTrigger value="net" data-testid="pnl-basis-net" title="Profit after Binance fees">
            Net of fees
          </TabsTrigger>
          <TabsTrigger value="gross" data-testid="pnl-basis-gross" title="Profit before fees">
            Gross
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}
