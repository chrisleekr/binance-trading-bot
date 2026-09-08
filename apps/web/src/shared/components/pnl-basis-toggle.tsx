import { Tabs, TabsList, TabsTrigger } from '@/shared/components/ui/tabs';
import type { PnlBasis } from '@/shared/hooks/use-pnl-basis';

/** What each basis actually covers, in the operator's words. Rendered under the control rather than hung off `title`, because a tooltip is hover-only: the reader most likely to hold the misconception is on a phone, where a long press raises the OS text menu instead. */
const BASIS_GLOSS: Record<PnlBasis, string> = {
  net: 'Every commission this build could value, including the ones charged in BNB or in the coin you sold.',
  gross:
    'The result as it was booked. A commission taken out of the coin you bought is already inside this figure; one charged in BNB or in the quote coin is not.',
};

/**
 * Net and recorded-basis switch shared by History and the Home scoreboard.
 *
 * Neither option is "before fees", and saying so is the point of the gloss. Binance can take its commission in the asset being bought, in which case the fill quantity itself already arrived net of it and no later subtraction can put it back — so the Recorded figure is fee-inclusive in part, and the choice here is between all of the fees and some of them. Labelling the pair Net/Gross taught exactly the wrong thing, which is the misreading that sent an operator hunting for a P/L discrepancy that was never there.
 *
 * @param props - Current basis and the callback that persists the operator's next choice.
 * @returns The two-option P/L basis control with the gloss for the option in force.
 */
export function PnlBasisToggle({
  basis,
  onBasisChange,
}: {
  basis: PnlBasis;
  onBasisChange: (next: PnlBasis) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-fg">P/L</span>
        <Tabs value={basis} onValueChange={(v) => onBasisChange(v as PnlBasis)}>
          <TabsList>
            <TabsTrigger
              value="net"
              data-testid="pnl-basis-net"
              title="Profit after every Binance commission that could be valued"
            >
              Net of all fees
            </TabsTrigger>
            <TabsTrigger
              value="gross"
              data-testid="pnl-basis-gross"
              title="The stored cost-basis result, which already includes a commission charged in the coin you bought"
            >
              Recorded
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <p className="max-w-prose text-[11px] text-muted-fg" data-testid="pnl-basis-gloss">
        {BASIS_GLOSS[basis]}
      </p>
    </div>
  );
}
