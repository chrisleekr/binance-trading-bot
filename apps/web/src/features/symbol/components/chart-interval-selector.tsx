import { CANDLE_INTERVALS, type CandleInterval } from '@/features/symbol/api/symbol';
import { cn } from '@/shared/lib/cn';

/**
 * Binance-style candle interval tabs. A segmented control, not Radix Tabs —
 * the chart body is one panel switched by re-query, not tab content. Each
 * button is an `aria-pressed` toggle so the active interval is exposed to
 * assistive tech.
 */
export function ChartIntervalSelector({
  value,
  onChange,
}: {
  readonly value: CandleInterval;
  readonly onChange: (interval: CandleInterval) => void;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Chart interval"
      className="border-border bg-bg-elevated inline-flex gap-0.5 rounded-md border p-0.5"
    >
      {CANDLE_INTERVALS.map((interval) => {
        const active = interval === value;
        return (
          <button
            key={interval}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(interval)}
            className={cn(
              'focus-visible:ring-focus rounded px-2.5 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2',
              active ? 'bg-accent text-accent-fg' : 'text-muted-fg hover:text-fg',
            )}
          >
            {interval}
          </button>
        );
      })}
    </div>
  );
}
