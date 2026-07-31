import { InfoHint } from '@/shared/components/ui/info-hint';

interface MetricCardProps {
  readonly label: string;
  readonly value: string;
  /** Sign-based tint for PnL-style metrics; omit for neutral numbers. */
  readonly tone?: 'up' | 'down' | undefined;
  /** One-line plain-language gloss shown under the value. */
  readonly hint?: string | undefined;
  /** Plain-language explanation revealed by an ⓘ popover beside the label. */
  readonly info?: React.ReactNode;
  /** Headline cards read first, so the value is larger and the padding roomier. */
  readonly prominent?: boolean;
}

export function MetricCard({
  label,
  value,
  tone,
  hint,
  info,
  prominent,
}: MetricCardProps): React.JSX.Element {
  const toneClass = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-fg';
  return (
    <div className={`border-border bg-bg-elevated border ${prominent ? 'p-4' : 'p-3'}`}>
      <div className="text-muted-fg flex items-center gap-1 text-xs">
        {label}
        {info ? <InfoHint label={label}>{info}</InfoHint> : null}
      </div>
      <div
        className={`font-mono font-medium tabular-nums ${prominent ? 'text-2xl' : 'text-base'} ${toneClass}`}
      >
        {value}
      </div>
      {hint ? <div className="text-muted-fg mt-0.5 text-[11px] leading-tight">{hint}</div> : null}
    </div>
  );
}
