import { useState } from 'react';
import { useController, useFormContext } from 'react-hook-form';
import { percentToStored, storedToPercent } from '@app/contracts';
import type { FormField } from '@app/contracts';

import { Input } from '@/shared/components/ui/input';
import { cn } from '@/shared/lib/cn';
import { formatAmount } from '@/shared/lib/format';

import { useFormEquity, type FormEquity } from '@/shared/forms/form-equity';
import type { WidgetProps } from './types';

// Non-negative decimal as the operator types it ("", "3", "3.", "2.5", ".").
const PARTIAL_DECIMAL = /^\d*\.?\d*$/;

// A mode whose value lives in the `percent` sub-field (vs the `amount` field,
// vs `off` which has no value). Both strategies' percent modes contain "percent".
const isPercentMode = (mode: string): boolean => mode.toLowerCase().includes('percent');
const isOffMode = (mode: string): boolean => mode === 'off';

// Operator-facing label per mode value (the schema enum varies by strategy:
// entrySizing = fixed|percentOfAccount; TT cap = off|amount|percent; momentum
// cap = off|percentOfAccount).
const MODE_LABELS: Readonly<Record<string, string>> = {
  fixed: 'Fixed amount',
  amount: 'Amount',
  percentOfAccount: '% of account',
  percent: '% of account',
  off: 'Off',
};

/** Read the mode enum's option list from the object field's `mode` child. */
const modeOptions = (fieldDef: FormField): readonly string[] => {
  if (fieldDef.kind !== 'object') return [];
  const mode = fieldDef.fields.find((f) => f.path.endsWith('.mode'));
  return mode && mode.kind === 'enum' ? mode.options : [];
};

/**
 * Segmented "Amount or %" control for an `{ mode, amount?, percent? }` config
 * object (entry sizing or the account cap). The operator picks one mode and
 * sees only that mode's single input — never the raw three fields — so the
 * "set an amount OR a percent, which wins?" confusion cannot arise. The unused
 * sub-field is blanked on switch so a stale value never reaches the schema.
 *
 * The percent input reuses the shared percent⇄fraction converter (operator
 * types 50, the schema stores 0.5), matching `@ui:percent-of` elsewhere; the
 * amount input stores the decimal-string verbatim. apps/web is barred from
 * decimal.js, so all percent math goes through `@app/contracts`.
 */
export function AmountOrPercentWidget({
  name,
  fieldDef,
  renderPercentPreview,
}: WidgetProps & {
  // Optional override for the percent-mode preview + help text. The account cap
  // (default) shows "≈ N USDT" because there the percent IS the deployed figure;
  // entry sizing supplies a risk-aware version because there the percent is the
  // risk per trade and the position is risk ÷ stop distance.
  renderPercentPreview?: (storedFraction: number, equity: FormEquity | null) => React.ReactNode;
}): React.JSX.Element | null {
  const { control } = useFormContext();
  const equity = useFormEquity();
  const mode = useController({ name: `${name}.mode`, control });
  const amount = useController({ name: `${name}.amount`, control });
  const percent = useController({ name: `${name}.percent`, control });

  const current = typeof mode.field.value === 'string' ? mode.field.value : '';
  const options = modeOptions(fieldDef);
  // The momentum cap object has no `amount` sub-field; only blank a sub-field
  // the schema actually declares so a switch never writes a phantom key.
  const hasField = (suffix: string): boolean =>
    fieldDef.kind === 'object' && fieldDef.fields.some((f) => f.path.endsWith(suffix));
  const hasAmount = hasField('.amount');
  const hasPercent = hasField('.percent');

  // Local text for the active input so a half-typed decimal survives a keystroke
  // (RHF still holds the canonical stored value).
  const [amountText, setAmountText] = useState(() =>
    typeof amount.field.value === 'string' ? amount.field.value : '',
  );
  const [percentText, setPercentText] = useState(() => {
    const stored = typeof percent.field.value === 'string' ? percent.field.value : '';
    return stored === '' || stored === '0' ? '' : storedToPercent(stored, 'fraction');
  });

  // Live quote figure for the percent input, shown only when the form supplied
  // account equity (the profile-config page). `percent.field.value` is the
  // stored fraction (0.5 = 50%) and updates on each valid keystroke. The worker
  // re-derives this equity in Decimal at tick time, so this Number math is
  // display-only — apps/web is barred from decimal.js.
  const storedFraction =
    typeof percent.field.value === 'string' ? Number(percent.field.value) : Number.NaN;
  const equityPreview =
    equity && Number.isFinite(storedFraction) && storedFraction > 0 && equity.equityQuote > 0
      ? { value: storedFraction * equity.equityQuote, quoteAsset: equity.quoteAsset }
      : null;
  // Every percent field on this widget is bounded (0, 1] server-side, so a typed
  // value over 100% is rejected on save. The client schema can't see that bound
  // (it lives in a zod refine that JSON Schema can't express), so warn here —
  // independent of equity — instead of letting the operator hit a 422 blind.
  const overMaxPercent = Number.isFinite(storedFraction) && storedFraction > 1;

  const selectMode = (next: string): void => {
    mode.field.onChange(next);
    // Blank the now-inactive value(s) so a stale value cannot trip the schema's
    // exactly-one-per-mode refine. Only touch sub-fields the object declares.
    const clearAmount = (): void => {
      if (hasAmount) {
        amount.field.onChange('');
        setAmountText('');
      }
    };
    const clearPercent = (): void => {
      if (hasPercent) {
        percent.field.onChange('');
        setPercentText('');
      }
    };
    if (isPercentMode(next)) clearAmount();
    else if (!isOffMode(next)) clearPercent();
    else {
      clearAmount();
      clearPercent();
    }
  };

  const onAmount = (raw: string): void => {
    setAmountText(raw);
    if (raw === '' || PARTIAL_DECIMAL.test(raw)) amount.field.onChange(raw);
  };
  const onPercent = (raw: string): void => {
    setPercentText(raw);
    if (raw === '') {
      percent.field.onChange('');
      return;
    }
    if (!PARTIAL_DECIMAL.test(raw)) return;
    const norm = raw.endsWith('.') ? raw.slice(0, -1) : raw;
    if (norm === '') return;
    percent.field.onChange(percentToStored(norm, 'fraction'));
  };

  return (
    <div className="space-y-2" data-testid={`amount-or-percent-${name}`}>
      <div className="border-border inline-flex rounded-md border p-0.5" role="group">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            aria-pressed={current === opt}
            onClick={() => selectMode(opt)}
            className={cn(
              'rounded px-2.5 py-1 text-xs font-medium transition-colors',
              current === opt ? 'bg-accent text-accent-fg' : 'text-muted-fg hover:text-fg',
            )}
          >
            {MODE_LABELS[opt] ?? opt}
          </button>
        ))}
      </div>

      {isOffMode(current) ? null : isPercentMode(current) ? (
        <div className="space-y-1">
          <div className="relative flex items-center">
            <Input
              id={`${name}.percent`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={percentText}
              onChange={(e) => onPercent(e.target.value)}
              onBlur={percent.field.onBlur}
              aria-invalid={percent.fieldState.invalid || undefined}
              className={cn('pr-9')}
            />
            <span className="text-muted-fg pointer-events-none absolute right-3 text-sm">%</span>
          </div>
          {renderPercentPreview ? (
            renderPercentPreview(storedFraction, equity)
          ) : (
            <>
              {equityPreview ? (
                <p
                  className="text-fg text-xs font-medium"
                  data-testid={`amount-or-percent-${name}-preview`}
                >
                  ≈ {formatAmount(equityPreview.value)} {equityPreview.quoteAsset}
                </p>
              ) : null}
            </>
          )}
          {overMaxPercent ? (
            <p
              className="text-warning text-xs font-medium"
              data-testid={`amount-or-percent-${name}-over-max`}
            >
              Over 100% of the account. The most you can set is 100% — a higher value is rejected
              when you save.
            </p>
          ) : null}
          {renderPercentPreview ? null : (
            <p className="text-muted-fg text-xs">
              % of account = your cash plus the value of coins you hold
              {equity ? ` (${formatAmount(equity.equityQuote)} ${equity.quoteAsset} now)` : ''}.
            </p>
          )}
        </div>
      ) : (
        <Input
          id={`${name}.amount`}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={amountText}
          onChange={(e) => onAmount(e.target.value)}
          onBlur={amount.field.onBlur}
          aria-invalid={amount.fieldState.invalid || undefined}
        />
      )}
    </div>
  );
}
