import { useState } from 'react';
import { useController, useFormContext } from 'react-hook-form';
import { percentToStored, storedToPercent, type PercentMode } from '@app/contracts';

import { Input } from '@/shared/components/ui/input';
import { cn } from '@/shared/lib/cn';

import type { Widget } from './types';

// Non-negative decimal as the operator types it ("", "3", "3.", "2.5", ".").
const PARTIAL_DECIMAL = /^\d*\.?\d*$/;

/**
 * Factory for the percent-converting widget. The operator types a plain percent
 * (e.g. 3 for "3% below"); the widget stores the strategy's decimal-string
 * multiplier/fraction (0.97) verbatim, so the wire format never changes. The
 * percent⇄stored math is exact via `@app/contracts` (decimal.js lives there;
 * apps/web is barred from importing decimal.js directly, so it calls the shared
 * converter rather than doing IEEE-754 math on a value that feeds an order).
 *
 * `mode` is fixed per registry entry — the field's `@ui:` hint picks it:
 * `percent-above` → 'above', `percent-below` → 'below', `percent-of` → 'fraction'.
 *
 * The displayed string is local state, not derived from the stored value every
 * render, so a half-typed decimal ("3.") survives the keystroke instead of being
 * normalised away by the round-trip. RHF still holds the canonical stored value,
 * updated on every parseable keystroke, so validation and submit see it live.
 * The `'0'` and `''` disable sentinels render as a blank input.
 *
 * Call only at module scope (the widget registry); a per-render call remounts
 * the input on every keystroke and loses focus.
 */
export function percentConvertWidget(mode: PercentMode): Widget {
  return function PercentConvertInput({ name }) {
    const { control } = useFormContext();
    const { field, fieldState } = useController({ name, control });
    // Seed once from the stored value. '0'/'' are the disabled sentinels, shown
    // blank rather than as a misleading percent. Subsequent external changes in
    // our flows always remount the widget (strategy switch via form key, grid
    // "Add" appends a fresh row), so a re-seed effect is unnecessary.
    const [text, setText] = useState(() => {
      const stored = typeof field.value === 'string' ? field.value : '';
      return stored === '0' ? '' : storedToPercent(stored, mode);
    });

    const onChange = (raw: string): void => {
      setText(raw);
      if (raw === '') {
        field.onChange('');
        return;
      }
      if (!PARTIAL_DECIMAL.test(raw)) return; // ignore stray paste; keep last good stored
      const norm = raw.endsWith('.') ? raw.slice(0, -1) : raw;
      if (norm === '') return; // bare '.', wait for a digit
      field.onChange(percentToStored(norm, mode));
    };

    return (
      <div className="relative flex items-center">
        <Input
          id={name}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onBlur={field.onBlur}
          name={field.name}
          ref={field.ref}
          aria-invalid={fieldState.invalid || undefined}
          className={cn('pr-9')}
        />
        <span className="pointer-events-none absolute right-3 text-sm text-muted-fg">%</span>
      </div>
    );
  };
}
