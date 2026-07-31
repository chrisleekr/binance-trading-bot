import { cn } from '@/shared/lib/cn';
import { formatSignedAmount, signOf } from '@/shared/lib/format';

/**
 * Colour for a PnL value, keyed by its sign. Exported so sign-coloured
 * readouts that aren't a full `PnlValue` (e.g. a percent) cannot drift from
 * the green-up / red-down / muted-flat convention.
 */
export const PNL_TONE: Record<'pos' | 'neg' | 'zero', string> = {
  pos: 'text-success',
  neg: 'text-danger',
  zero: 'text-muted-fg',
};

/**
 * Unrealised-PnL readout — a sign-prefixed, formatted amount colour-coded by
 * direction (green up / red down / muted flat); a null value renders as an em
 * dash. The single PnL presentation shared by the dashboard cards and the
 * profile symbol list, so the two cannot drift.
 */
export function PnlValue({
  value,
  unit,
  className,
  testId,
}: {
  readonly value: string | null;
  /** Quote asset (e.g. "USDT") appended after the amount so the number isn't unitless. Omitted when the value is null/em-dash. */
  readonly unit?: string;
  readonly className?: string;
  readonly testId?: string;
}): React.JSX.Element {
  return (
    <span className={cn('font-mono', PNL_TONE[signOf(value)], className)} data-testid={testId}>
      {value != null ? formatSignedAmount(value) : '—'}
      {value != null && unit ? (
        <span className="text-muted-fg ml-1 font-mono text-xs">{unit}</span>
      ) : null}
    </span>
  );
}
