import type { Widget } from './widgets/types';
import { PercentageWidget } from './widgets/percentage';
import { percentConvertWidget } from './widgets/percentage-convert';
import { decimalStringWidget } from './widgets/decimal-string-input';
import { TechnicalsIntervalRowsWidget } from './widgets/technicals-interval-rows';
import { AmountOrPercentWidget } from './widgets/amount-or-percent';
import { EntrySizingWidget } from './widgets/entry-sizing';

/**
 * Closed registry of widget hints → React components. Strategies tag a
 * field via `z.number().describe('@ui:percentage')`; the auto-form looks
 * the hint up here and falls back to the kind-default widget when the
 * hint is unknown so a typo never blanks a form.
 *
 * Adding a new widget = drop a component into `apps/web/src/forms/widgets/`
 * and register it here. No cross-package coupling; strategies stay React-free.
 */
export const widgetRegistry: Readonly<Record<string, Widget>> = Object.freeze({
  percentage: PercentageWidget,
  // Percent-converting inputs: operator types a plain percent, the widget
  // stores the strategy's multiplier/fraction decimal-string. Direction is
  // baked into the hint so the form needs no per-field sign handling.
  'percent-above': percentConvertWidget('above'),
  'percent-below': percentConvertWidget('below'),
  'percent-of': percentConvertWidget('fraction'),
  // price / decimal are the same decimal-string input; price carries a `0.00`
  // placeholder, plain decimal (multipliers) none.
  price: decimalStringWidget('0.00'),
  decimal: decimalStringWidget(),
  'technicals-interval-rows': TechnicalsIntervalRowsWidget,
  // Segmented "Amount or %" control for an { mode, amount?, percent? } object
  // (entry sizing / account cap). Renders one input per selected mode.
  'amount-or-percent': AmountOrPercentWidget,
  // Entry-sizing variant that hides the control under a grid ladder (the grid
  // sizes each level itself and ignores entrySizing), showing a note instead.
  'amount-or-percent-entry': EntrySizingWidget,
});

/**
 * Returns the registered widget for a hint, or `null` when unknown so the
 * caller can fall back to the kind-default widget. The lookup is exact;
 * we don't normalise casing because hints are author-controlled.
 */
export function lookupWidget(hint: string | null | undefined): Widget | null {
  if (!hint) return null;
  return widgetRegistry[hint] ?? null;
}
