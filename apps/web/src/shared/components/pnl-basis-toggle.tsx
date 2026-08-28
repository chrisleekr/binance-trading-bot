import { Tabs, TabsList, TabsTrigger } from '@/shared/components/ui/tabs';
import type { PnlBasis } from '@/shared/hooks/use-pnl-basis';

/**
 * Net and recorded-basis switch shared by History and the Home scoreboard. Net subtracts the additional commission adjustment when evidence is complete; Recorded preserves the stored cost-basis figure, which can already include a base-asset BUY fee.
 *
 * @param props - Current basis and callback that persists the operator's next choice.
 * @returns The two-option P/L basis control.
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
      <span className="text-xs text-muted-fg">P/L</span>
      <Tabs value={basis} onValueChange={(v) => onBasisChange(v as PnlBasis)}>
        <TabsList>
          <TabsTrigger value="net" data-testid="pnl-basis-net" title="Profit after Binance fees">
            Net of fees
          </TabsTrigger>
          <TabsTrigger
            value="gross"
            data-testid="pnl-basis-gross"
            title="Stored cost-basis profit before additional fee adjustments"
          >
            Recorded
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}
