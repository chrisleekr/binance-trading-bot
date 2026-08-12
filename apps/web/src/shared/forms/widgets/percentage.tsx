import { useController, useFormContext } from 'react-hook-form';

import { Input } from '@/shared/components/ui/input';
import { cn } from '@/shared/lib/cn';

import type { WidgetProps } from './types';

/**
 * Percentage widget: a numeric input with a `%` suffix decoration. The
 * on-the-wire value semantics (fraction vs. multiplier) stay owned by the
 * strategy's zod schema; this widget only adds the visual affordance.
 *
 * The input surface follows the field's declared kind. A `number` field uses
 * `type="number"` with its schema `min`/`max`. A `string` field (a
 * decimal-string, the money-math convention) uses `type="text"
 * inputMode="decimal"` — a native number input would coerce and normalise the
 * string (drop trailing zeros, reject half-typed decimals), corrupting a value
 * the SPA must treat as opaque (CLAUDE.md "Money math"). Same reasoning as
 * the decimal-string input shared by the price/quantity/decimal hints.
 *
 * Clearing the input also follows the kind: a `number` field emits `undefined`
 * (so zod sees a missing value, not `NaN` from `Number('')`), a `string` field
 * passes the empty string through verbatim.
 */
export function PercentageWidget({ name, fieldDef }: WidgetProps) {
  const { control } = useFormContext();
  const { field, fieldState } = useController({ name, control });
  const isNumber = fieldDef.kind === 'number';
  return (
    <div className="relative flex items-center">
      <Input
        id={name}
        type={isNumber ? 'number' : 'text'}
        inputMode={isNumber ? undefined : 'decimal'}
        step={isNumber ? 'any' : undefined}
        min={isNumber ? fieldDef.minimum : undefined}
        max={isNumber ? fieldDef.maximum : undefined}
        autoComplete="off"
        value={field.value ?? ''}
        onChange={(e) =>
          field.onChange(
            isNumber
              ? e.target.value === ''
                ? undefined
                : Number(e.target.value)
              : e.target.value,
          )
        }
        onBlur={field.onBlur}
        name={field.name}
        ref={field.ref}
        aria-invalid={fieldState.invalid || undefined}
        className={cn('pr-9')}
      />
      <span className="pointer-events-none absolute right-3 text-sm text-muted-fg">%</span>
    </div>
  );
}
