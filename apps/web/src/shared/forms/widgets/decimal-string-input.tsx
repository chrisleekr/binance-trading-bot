import { useController, useFormContext } from 'react-hook-form';

import { Input } from '@/shared/components/ui/input';
import { useQuoteAsset } from '@/shared/forms/quote-asset-context';

import type { Widget } from './types';

/**
 * Factory for the decimal-string input widget. Price, quantity, and plain
 * decimal (multiplier / ratio) fields all render the same control — a
 * `type="text" inputMode="decimal"` input that round-trips the string
 * verbatim without native float coercion (Decimal end-to-end per CLAUDE.md
 * "Money math") and shows a numeric keypad on mobile. They differ only in
 * the empty-state `placeholder`, so they are one component behind three
 * `@ui:` hints rather than three near-identical files.
 *
 * `placeholder` omitted → no placeholder (a multiplier has no natural
 * zero-shaped hint); `'0.00'` for price/quantity.
 *
 * Call only at module scope (the widget registry). A per-render call yields
 * a fresh component identity and would remount the input on every keystroke,
 * losing focus and caret.
 */
export function decimalStringWidget(placeholder?: string): Widget {
  return function DecimalStringInput({ name }) {
    const { control } = useFormContext();
    const { field, fieldState } = useController({ name, control });
    const quoteAsset = useQuoteAsset();
    const input = (
      <Input
        id={name}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={field.value ?? ''}
        onChange={(e) => field.onChange(e.target.value)}
        onBlur={field.onBlur}
        name={field.name}
        ref={field.ref}
        aria-invalid={fieldState.invalid || undefined}
        placeholder={placeholder}
        className={quoteAsset ? 'pr-16' : undefined}
      />
    );
    // No provider means no known unit, so the control renders exactly as it did before rather than inventing one. The suffix decoration mirrors the percentage widget's, which is the established affordance for "this input has a unit".
    if (!quoteAsset) return input;
    return (
      <div className="relative flex items-center">
        {input}
        <span className="pointer-events-none absolute right-3 text-sm text-muted-fg">
          {quoteAsset}
        </span>
      </div>
    );
  };
}
