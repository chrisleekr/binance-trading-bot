import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';

/** The cost-model fields the backtest reads. */
export type CostModelField = 'initialQuoteBalance' | 'slippageBps' | 'makerBps' | 'takerBps';

/**
 * Execution-realism fields that make a backtest pessimistic about fills rather
 * than assuming perfect liquidity. Opt-in: a form that wants the inputs passes
 * the `realism` block (the backtest form does).
 */
export type ExecutionRealismField = 'spreadBps' | 'volumeCapPct';

/**
 * Starting balance + slippage/maker/taker fee inputs for the backtest form.
 * Each fee field glosses "bps" (basis points) inline — a non-expert operator
 * should not have to know the term to fill the form. `idPrefix` namespaces the
 * input ids; `onChange(field)` returns the change handler for that field (the
 * form's `setParam`/`setBaseField` satisfy it directly).
 *
 * `realism` (optional) renders the spread + volume-participation-cap inputs that
 * model imperfect execution. The backtest form passes it.
 */
export function CostModelFields({
  idPrefix,
  values,
  onChange,
  realism,
}: {
  readonly idPrefix: string;
  readonly values: Readonly<Record<CostModelField, string>>;
  readonly onChange: (field: CostModelField) => React.ChangeEventHandler<HTMLInputElement>;
  readonly realism?: {
    readonly values: Readonly<Record<ExecutionRealismField, string>>;
    readonly onChange: (field: ExecutionRealismField) => React.ChangeEventHandler<HTMLInputElement>;
  };
}): React.JSX.Element {
  return (
    <>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-balance`}>Starting balance (quote)</Label>
        <Input
          id={`${idPrefix}-balance`}
          inputMode="decimal"
          value={values.initialQuoteBalance}
          onChange={onChange('initialQuoteBalance')}
          autoComplete="off"
        />
        <p className="text-muted-fg text-xs">
          Quote currency (e.g. USDT) the simulated run starts with.
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-slippage`}>Slippage (bps)</Label>
        <Input
          id={`${idPrefix}-slippage`}
          inputMode="decimal"
          value={values.slippageBps}
          onChange={onChange('slippageBps')}
          autoComplete="off"
        />
        <p className="text-muted-fg text-xs">
          Price slippage per fill, in basis points (1 bps = 0.01%). 5 means each fill is 0.05% worse
          than the quoted price.
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-maker`}>Maker fee (bps)</Label>
        <Input
          id={`${idPrefix}-maker`}
          inputMode="decimal"
          value={values.makerBps}
          onChange={onChange('makerBps')}
          autoComplete="off"
        />
        <p className="text-muted-fg text-xs">
          Fee on orders that add liquidity (resting limit orders), in basis points (1 bps = 0.01%).
          10 = 0.10%.
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-taker`}>Taker fee (bps)</Label>
        <Input
          id={`${idPrefix}-taker`}
          inputMode="decimal"
          value={values.takerBps}
          onChange={onChange('takerBps')}
          autoComplete="off"
        />
        <p className="text-muted-fg text-xs">
          Fee on orders that take liquidity (market orders), in basis points (1 bps = 0.01%). 10 =
          0.10%.
        </p>
      </div>
      {realism && (
        <>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-spread`}>Spread (bps)</Label>
            <Input
              id={`${idPrefix}-spread`}
              inputMode="decimal"
              value={realism.values.spreadBps}
              onChange={realism.onChange('spreadBps')}
              autoComplete="off"
            />
            <p className="text-muted-fg text-xs">
              Bid/ask spread charged on every fill, in basis points (1 bps = 0.01%). Makes even
              limit-order fills realistic instead of free. 5 = 0.05%.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-volcap`}>Max fill per candle (% volume)</Label>
            <Input
              id={`${idPrefix}-volcap`}
              inputMode="decimal"
              value={realism.values.volumeCapPct}
              onChange={realism.onChange('volumeCapPct')}
              autoComplete="off"
            />
            <p className="text-muted-fg text-xs">
              Most of a candle's traded volume one order may take. Caps fills on thin candles so a
              large order can't fill instantly. Leave blank to disable.
            </p>
          </div>
        </>
      )}
    </>
  );
}
