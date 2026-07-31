import { useWatch } from 'react-hook-form';

import { formatAmount } from '@/shared/lib/format';
import type { FormEquity } from '@/shared/forms/form-equity';
import { AmountOrPercentWidget } from './amount-or-percent';
import type { WidgetProps } from './types';

/** The sibling `gridLevels` array path within the same parent object as `name`. */
const siblingGridLevelsPath = (name: string): string => {
  const parent = name.split('.').slice(0, -1).join('.');
  return parent ? `${parent}.gridLevels` : 'gridLevels';
};

/** A `sell.<field>` path on the same config root as `buy.entrySizing`. */
const sellFieldPath = (name: string, field: string): string => {
  const root = name.split('.').slice(0, -2).join('.');
  return root ? `${root}.sell.${field}` : `sell.${field}`;
};

/** Hard cap on a single risk-based entry, mirroring sizing.ts MAX_DEPLOY_FRACTION. */
const MAX_DEPLOY_FRACTION = 0.5;

/**
 * Entry-sizing control that steps aside under grid mode. A grid ladder sizes
 * each level from its own min/max purchase amount and ignores `entrySizing`;
 * only an empty grid falls through to the single buy this field sizes. Showing
 * the editable control while a grid is configured reads as a live knob that
 * silently does nothing, so swap it for a one-line note. Watches the sibling
 * `gridLevels` in the same form, so it reacts as the operator adds or clears
 * levels without a save. A field whose parent has no `gridLevels` sibling (the
 * momentum strategy keeps the plain `@ui:amount-or-percent` hint, so this never
 * fires there) reads the watch as undefined and renders the control as usual.
 *
 * In percent mode it overrides the generic "≈ N USDT" preview: here the percent
 * is the RISK per trade, so the position is risk ÷ stop distance (capped at half
 * equity), mirroring the worker's sizing. Watching `sell.stopLossPercentage`
 * keeps the preview live as the operator edits the stop.
 */
export function EntrySizingWidget({ name, fieldDef }: WidgetProps): React.JSX.Element {
  const gridLevels = useWatch({ name: siblingGridLevelsPath(name) }) as unknown;
  const stopRaw = useWatch({ name: sellFieldPath(name, 'stopLossPercentage') }) as unknown;
  const sellEnabled = useWatch({ name: sellFieldPath(name, 'enabled') }) as unknown;
  const gridActive = Array.isArray(gridLevels) && gridLevels.length > 0;

  if (gridActive) {
    return (
      <p className="text-muted-fg text-xs" data-testid={`entry-sizing-grid-note-${name}`}>
        Each grid level sizes its own buy, so entry sizing is not used here. Clear all grid levels
        to size a single entry instead.
      </p>
    );
  }

  // Display-only Number math (apps/web is barred from decimal.js); the worker
  // re-derives the size in Decimal at tick time, so this never feeds an order.
  const renderPercentPreview = (fraction: number, equity: FormEquity | null): React.ReactNode => {
    if (!equity || !Number.isFinite(fraction) || fraction <= 0 || equity.equityQuote <= 0) {
      return (
        <p className="text-muted-fg text-xs">
          Percent of equity to risk per trade, sized against your stop-loss.
        </p>
      );
    }
    const risk = fraction * equity.equityQuote;
    const stopNum = typeof stopRaw === 'string' ? Number(stopRaw) : Number.NaN;
    // Mirror the worker: a stop only sizes risk when the sell side is enabled
    // (a disabled sell never runs the stop). Treat a disabled or unset stop the same.
    const hasStop = sellEnabled === true && Number.isFinite(stopNum) && stopNum > 0 && stopNum < 1;
    if (!hasStop) {
      return (
        <p className="text-muted-fg text-xs" data-testid={`entry-risk-preview-${name}`}>
          No active stop-loss, so this just spends ≈ {formatAmount(risk)} {equity.quoteAsset} on the
          entry. Set and enable a stop-loss to size by risk.
        </p>
      );
    }
    const rawPosition = risk / (1 - stopNum);
    const cap = MAX_DEPLOY_FRACTION * equity.equityQuote;
    const position = Math.min(rawPosition, cap);
    const capped = rawPosition > cap;
    // "up to" because the worker also clamps to free cash, which this preview
    // cannot see (FormEquity exposes equity, not the free-cash split).
    return (
      <p className="text-fg text-xs font-medium" data-testid={`entry-risk-preview-${name}`}>
        Risking ≈ {formatAmount(risk)} {equity.quoteAsset} per trade · position up to ≈{' '}
        {formatAmount(position)} {equity.quoteAsset}
        {capped ? ' (capped at half your equity)' : ''}, subject to available cash.
      </p>
    );
  };

  return (
    <AmountOrPercentWidget
      name={name}
      fieldDef={fieldDef}
      renderPercentPreview={renderPercentPreview}
    />
  );
}
