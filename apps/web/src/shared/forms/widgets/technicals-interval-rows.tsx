import { useController, useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import { Plus, Trash2 } from 'lucide-react';

import { MAX_TECHNICALS_INTERVALS, type FormField } from '@app/contracts';

import { Button } from '@/shared/components/ui/button';
import { Switch } from '@/shared/components/ui/switch';
import { reindexPaths } from '@/shared/forms/field-paths';

import type { WidgetProps } from './types';

/**
 * Technicals intervals array widget. Composes the same
 * useFieldArray + reindexPaths machinery the default array renderer
 * uses, and adds a per-row "contributes nothing" warning when both the
 * buy toggles (whenStrongBuy / whenBuy) and the force-sell toggles
 * (whenSell / whenStrongSell / whenNeutral) are all off. Without it the
 * operator can save a dead-weight row that never affects the gate or
 * the force-sell branch.
 *
 * The per-row body groups the 5 toggles into two semantic clusters:
 * "Allow buy when…" (Strong Buy / Buy) and "Trigger force-sell when…"
 * (Sell / Strong Sell / Neutral). The default fieldset renderer would
 * stack each as a full-width row with title + description + toggle —
 * five vertical sections per interval times up to three intervals fills
 * the screen for an operator who just wants to compare the matrix at
 * a glance.
 */
export function TechnicalsIntervalRowsWidget({ name, fieldDef, renderChild }: WidgetProps) {
  const { control } = useFormContext();
  const { fields, append, remove } = useFieldArray({ control, name });
  const checkTechnicals = useWatch({ name: 'forceBuyOverride.checkTechnicals' });
  const gateOff = checkTechnicals === false;
  if (fieldDef.kind !== 'array') return null;
  const element = fieldDef.element;
  return (
    <div className="space-y-3">
      {gateOff ? (
        <p className="text-warning text-xs" data-testid="tv-rows-master-off">
          The Technicals gate is off (see Force Buy Override → Apply Technicals gate). Rows below
          are kept but inactive.
        </p>
      ) : null}
      {fields.length === 0 ? (
        <p className="text-muted-fg text-sm">
          No intervals — Technicals is opted out for this profile.
        </p>
      ) : null}
      {fields.map((row, index) => (
        <IntervalRow
          key={row.id}
          name={name}
          index={index}
          element={element}
          onRemove={() => remove(index)}
          renderChild={renderChild}
        />
      ))}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={fields.length >= MAX_TECHNICALS_INTERVALS}
          onClick={() =>
            // Seed a sensible default row. `append(undefined)` would render a
            // blank fieldset that immediately fires the dead-weight warning even
            // though the operator just clicked Add, because react-hook-form does
            // not run the zod parse defaults at field creation.
            append({
              interval: '1h',
              whenStrongBuy: true,
              whenBuy: true,
              whenSell: false,
              whenStrongSell: false,
              whenNeutral: false,
              mode: 'block',
            })
          }
          className="gap-2"
        >
          <Plus className="size-4" /> Add
        </Button>
        <span className="text-muted-fg text-xs" data-testid="tv-rows-count" aria-live="polite">
          {fields.length} of {MAX_TECHNICALS_INTERVALS} intervals
        </span>
      </div>
    </div>
  );
}

/** Find a child field by tail segment ("whenBuy") within an object field's `fields[]`. */
function findChildField(parent: FormField, tail: string): FormField | undefined {
  if (parent.kind !== 'object') return undefined;
  return parent.fields.find((f) => f.path === tail || f.path.endsWith(`.${tail}`));
}

/**
 * One interval row. Renders the Interval select via FieldRenderer so the
 * `@ui:` widget hint on the schema's `interval` enum is preserved, then
 * hand-renders the 5 boolean toggles in two semantic groups (buy / sell).
 */
function IntervalRow({
  name,
  index,
  element,
  onRemove,
  renderChild,
}: {
  readonly name: string;
  readonly index: number;
  readonly element: FormField;
  readonly onRemove: () => void;
  readonly renderChild: WidgetProps['renderChild'];
}) {
  const rowPath = `${name}.${index}`;
  const intervalValue = useWatch({ name: `${rowPath}.interval` }) as unknown;
  const suffix =
    typeof intervalValue === 'string' && intervalValue.length > 0 ? ` — ${intervalValue}` : '';
  const label = `Interval ${index + 1}${suffix}`;

  // Per-field reindexed children. The default array renderer would walk
  // every child in order; we render the interval select first then split
  // the booleans across two grouped subsections.
  const intervalField = findChildField(element, 'interval');
  const buyToggles = (['whenStrongBuy', 'whenBuy'] as const)
    .map((tail) => findChildField(element, tail))
    .filter((f): f is FormField => f !== undefined);
  const sellToggles = (['whenSell', 'whenStrongSell', 'whenNeutral'] as const)
    .map((tail) => findChildField(element, tail))
    .filter((f): f is FormField => f !== undefined);

  return (
    <fieldset className="border-border bg-bg-elevated relative space-y-3 rounded-md border p-3 pr-12">
      <legend className="text-fg px-1 text-sm font-medium">{label}</legend>
      {/* renderChild is always injected when FieldRenderer renders this widget
          (both its widget dispatch sites pass it); the guard is defensive for a
          widget rendered outside FieldRenderer, where the interval select simply
          does not render rather than throwing. */}
      {intervalField && renderChild
        ? renderChild({ ...reindexPaths(intervalField, element.path, rowPath), required: true })
        : null}
      <ToggleGroup
        heading="Allow buy when…"
        description="On block rows, the buy gate ANDs across every configured interval; NEUTRAL passes, SELL/STRONG_SELL veto. Advisory rows record their verdict to the audit log but never veto."
        fields={buyToggles}
        rowPath={rowPath}
        elementPath={element.path}
        testIdPrefix={`tv-row-${index}-buy`}
      />
      <AdvisoryToggle rowPath={rowPath} index={index} />
      <ToggleGroup
        heading="Trigger force-sell when…"
        description="Fires only while a position is held at profit AND below its sell-trigger price. All triggers disabled by default."
        fields={sellToggles}
        rowPath={rowPath}
        elementPath={element.path}
        testIdPrefix={`tv-row-${index}-sell`}
      />
      <RowActivityNote name={rowPath} />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Remove Interval ${index + 1}`}
        onClick={onRemove}
        className="absolute right-1 top-1"
      >
        <Trash2 className="size-4" />
      </Button>
    </fieldset>
  );
}

/**
 * One grouped row of inline boolean toggles. Each toggle keeps its own
 * label and tooltip but renders as a compact horizontal cell so the
 * operator can scan all toggles in the group at once instead of paging
 * through a vertical list.
 */
function ToggleGroup({
  heading,
  description,
  fields,
  rowPath,
  elementPath,
  testIdPrefix,
}: {
  readonly heading: string;
  readonly description: string;
  readonly fields: readonly FormField[];
  readonly rowPath: string;
  readonly elementPath: string;
  readonly testIdPrefix: string;
}) {
  if (fields.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="text-muted-fg text-xs font-semibold">{heading}</div>
      <p className="text-muted-fg text-xs">{description}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((f) => (
          <ToggleCell
            key={f.path}
            field={f}
            rowPath={rowPath}
            elementPath={elementPath}
            testId={`${testIdPrefix}-${f.path.split('.').pop()}`}
          />
        ))}
      </div>
    </div>
  );
}

/** One labelled boolean toggle cell. */
function ToggleCell({
  field,
  rowPath,
  elementPath,
  testId,
}: {
  readonly field: FormField;
  readonly rowPath: string;
  readonly elementPath: string;
  readonly testId: string;
}) {
  const reindexed = reindexPaths(field, elementPath, rowPath);
  const { control } = useFormContext();
  const { field: rhf } = useController({ name: reindexed.path, control });
  // Strip the leading "When " prefix from the auto-derived label; the heading
  // already provides the "when" framing for the whole group.
  const compactLabel = (reindexed.label ?? '').replace(/^When\s+/i, '');
  return (
    <label
      htmlFor={reindexed.path}
      className="rounded-xs border-border bg-surface-alt hover:border-border-strong flex cursor-pointer items-center gap-2 border px-2 py-1.5 text-sm"
      title={reindexed.description ?? ''}
      data-testid={testId}
    >
      <Switch
        id={reindexed.path}
        checked={Boolean(rhf.value)}
        onCheckedChange={(v) => rhf.onChange(v)}
      />
      <span>{compactLabel}</span>
    </label>
  );
}

/**
 * Per-row advisory-mode toggle. When advisory, the row's verdict is still
 * computed and recorded in the audit log but never vetoes the buy gate —
 * the operator's lever for "treat 1h as advisory, require 4h to consent".
 */
function AdvisoryToggle({ rowPath, index }: { readonly rowPath: string; readonly index: number }) {
  const { control } = useFormContext();
  const { field } = useController({ name: `${rowPath}.mode`, control, defaultValue: 'block' });
  const advisory = field.value === 'advisory';
  const id = `${rowPath}.mode`;
  return (
    <div className="space-y-1.5">
      <div className="text-muted-fg text-xs font-semibold">Mode</div>
      <label
        htmlFor={id}
        className="rounded-xs border-border bg-surface-alt hover:border-border-strong flex cursor-pointer items-center gap-2 border px-2 py-1.5 text-sm"
        title="Advisory rows record their verdict in the audit log but never veto the buy gate."
        data-testid={`tv-row-${index}-mode`}
      >
        <Switch
          id={id}
          checked={advisory}
          onCheckedChange={(v) => field.onChange(v ? 'advisory' : 'block')}
        />
        <span>Advisory (record verdict, never vetoes)</span>
      </label>
    </div>
  );
}

/**
 * Inline note rendered under each interval row. Watches the row's five
 * toggle values via useWatch so it re-evaluates on every flip without
 * re-rendering the whole array. Reports one of three states:
 *
 *   - "buy-only" — at least one whenStrongBuy/whenBuy, no sell toggles.
 *   - "sell-only" — at least one whenSell/whenStrongSell/whenNeutral, no buy.
 *   - "inactive" — all five off; the row contributes nothing.
 *
 * The neutral two-state case ("both sides active") renders nothing —
 * that is the normal config and needs no commentary.
 */
function RowActivityNote({ name }: { readonly name: string }) {
  const values = useWatch({ name }) as
    | {
        whenStrongBuy?: boolean;
        whenBuy?: boolean;
        whenSell?: boolean;
        whenStrongSell?: boolean;
        whenNeutral?: boolean;
        mode?: 'block' | 'advisory';
      }
    | undefined;
  const buy = Boolean(values?.whenStrongBuy || values?.whenBuy);
  const sell = Boolean(values?.whenSell || values?.whenStrongSell || values?.whenNeutral);
  const advisory = values?.mode === 'advisory';
  if (buy && sell) return null;
  if (!buy && !sell) {
    if (advisory) {
      return (
        <p className="text-muted-fg mt-1 text-xs" data-testid={`tv-row-activity-${name}`}>
          Advisory row with no triggers — verdict still recorded for audit visibility.
        </p>
      );
    }
    return (
      <p className="text-warning mt-1 text-xs" data-testid={`tv-row-activity-${name}`}>
        This interval contributes nothing — enable at least one buy or sell toggle, or remove it.
      </p>
    );
  }
  return (
    <p className="text-muted-fg mt-1 text-xs" data-testid={`tv-row-activity-${name}`}>
      {buy ? 'Buy-gate only — no force-sell trigger.' : 'Force-sell only — does not gate buys.'}
    </p>
  );
}
