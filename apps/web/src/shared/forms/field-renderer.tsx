import { createElement, type ReactNode } from 'react';
import type * as React from 'react';
import { useController, useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { titleCase, type FormField } from '@app/contracts';

import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Switch } from '@/shared/components/ui/switch';
import { Panel } from '@/shared/components/panel';
import { cn } from '@/shared/lib/cn';

import { lookupWidget } from './widgetRegistry';
import { reindexPaths } from './field-paths';

/**
 * A field that renders as its own titled panel: an object group without a
 * widget hint. Object fields carrying a `@ui:*` widget (Amount-or-%) render as
 * a scalar control, not a section, so they are not groups. Arrays render inline
 * within whatever panel holds them. The AutoForm root uses this to split the
 * top level into section panels vs. the loose fields it buckets into one panel.
 */
export function isGroupField(field: FormField): boolean {
  return field.kind === 'object' && !field.widget;
}

/**
 * Always-visible field help, rendered under the label (and the section header).
 * The schema's `.describe()` text is the operator's "what this does / what
 * happens" — shown inline rather than hidden behind a tap so every field reads
 * for itself. Kept above the control (which bottom-aligns via `mt-auto`) so a
 * varying help height never knocks the controls in a desktop grid row out of
 * line.
 */
function FieldHelp({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-xs leading-relaxed text-muted-fg">{children}</p>;
}

/**
 * Lay out a list of fields as the two-up (three-up on xl) grid, then any
 * `@ui:advanced` fields under a collapsed "Advanced" disclosure. Shared by the
 * form root ({@link AutoForm}) and every nested section so a group lands as its
 * few essential fields, not a wall, with the expert knobs one click away.
 * `renderChild` lets the root render top-level groups as collapsible cards
 * (depth 0) while sections render their children inline.
 */
export function FieldGrid({
  fields,
  renderChild,
  advancedDefaultOpen = false,
}: {
  fields: readonly FormField[];
  renderChild: (field: FormField) => ReactNode;
  /** Open the Advanced disclosure on first render (e.g. reviewing a past run). */
  advancedDefaultOpen?: boolean;
}): React.JSX.Element {
  const essential = fields.filter((f) => !f.advanced);
  const advanced = fields.filter((f) => f.advanced);
  return (
    <>
      <FieldCells fields={essential} renderChild={renderChild} />
      <AdvancedFold fields={advanced} renderChild={renderChild} defaultOpen={advancedDefaultOpen} />
    </>
  );
}

/**
 * The `@ui:advanced` fields under one collapsed "Advanced settings" disclosure,
 * so a section (or the form root) lands as its essential fields with the expert
 * knobs one click away. Renders nothing when there are no advanced fields.
 * Shared by {@link FieldGrid} (nested sections) and the AutoForm root, so the
 * root's advanced groups and a section's advanced scalars fold identically.
 */
export function AdvancedFold({
  fields,
  renderChild,
  defaultOpen = false,
}: {
  fields: readonly FormField[];
  renderChild: (field: FormField) => ReactNode;
  defaultOpen?: boolean;
}): React.JSX.Element | null {
  if (fields.length === 0) return null;
  return (
    <details
      open={defaultOpen}
      className="group mt-4 rounded-md border border-border bg-surface-alt"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-muted-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <span>
          Advanced settings <span className="tabular-nums">({fields.length})</span>
        </span>
        <ChevronDown
          className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t border-border px-4 py-4">
        <FieldCells fields={fields} renderChild={renderChild} />
      </div>
    </details>
  );
}

/** Single full-width column of field cells so each control has room for its
 * label, its impact-explaining help, and the input on one readable line. */
export function FieldCells({
  fields,
  renderChild,
}: {
  fields: readonly FormField[];
  renderChild: (field: FormField) => ReactNode;
}): React.JSX.Element {
  return (
    <div className="grid gap-y-4">
      {fields.map((child) => (
        <div key={child.path}>{renderChild(child)}</div>
      ))}
    </div>
  );
}

/**
 * Recursively renders one schema-derived field. The renderer owns the
 * label/error chrome and dispatches the inner control to either a registered
 * widget (when the field carries a `@ui:*` hint) or to a kind-default
 * primitive. Splitting "where the value lives" (RHF context) from "what to
 * paint" keeps the registry uniform and the AutoForm walker thin.
 */
export function FieldRenderer({
  field,
  depth = 1,
  defaultOpen = false,
}: {
  field: FormField;
  /** 0 = top-level config group (collapsible); >0 = nested (inline fieldset). */
  depth?: number;
  /** Open state for a top-level collapsible group on first render. */
  defaultOpen?: boolean;
}) {
  if (field.kind === 'object') {
    // An object carrying a `@ui:*` hint (e.g. the Amount-or-% control) renders
    // through its widget with the same label chrome as a scalar, rather than
    // recursing into its raw `{ mode, amount, percent }` sub-fields.
    const ObjectWidget = lookupWidget(field.widget);
    if (ObjectWidget) {
      return (
        <div className="flex h-full flex-col gap-1.5">
          <span className="text-sm font-medium text-fg">{field.label}</span>
          {field.description ? <FieldHelp>{field.description}</FieldHelp> : null}
          <div className="mt-auto">
            {createElement(ObjectWidget, {
              name: field.path,
              fieldDef: field,
              renderChild: (child) => <FieldRenderer field={child} />,
            })}
          </div>
        </div>
      );
    }
    // Fields lay out two-up on desktop; nested groups and arrays are wide, so
    // they span the full row. Each section folds its own `@ui:advanced` fields
    // into an in-section "Advanced" disclosure, so a group lands as its few
    // essential fields rather than every knob it owns.
    const body = (
      <FieldGrid fields={field.fields} renderChild={(child) => <FieldRenderer field={child} />} />
    );

    // Top-level groups are collapsible Panels so the config reads as a short
    // list of section headers, not an endless scroll. Children stay mounted
    // while collapsed (details only hides them visually), so react-hook-form
    // state and schema validation are unaffected by open/closed.
    if (depth === 0) {
      return (
        <Panel
          title={field.label}
          description={field.description}
          collapsible
          defaultOpen={defaultOpen}
        >
          {body}
        </Panel>
      );
    }

    return (
      <fieldset className="space-y-3 rounded-md border border-border bg-bg p-4">
        <legend className="px-1 text-sm font-medium text-fg">{field.label}</legend>
        {field.description ? <FieldHelp>{field.description}</FieldHelp> : null}
        {body}
      </fieldset>
    );
  }

  // Full-height flex column so the control bottom-aligns within its grid cell:
  // sibling cells in a row stretch to the tallest, and `mt-auto` on the control
  // pushes every input onto a shared baseline even when labels in the same row
  // wrap to different line counts.
  return (
    <div className="flex h-full flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <label htmlFor={field.path} className="text-sm font-medium text-fg">
          {field.label}
        </label>
        {field.required ? (
          <span aria-hidden="true" className="text-danger">
            *
          </span>
        ) : null}
      </div>
      {field.description ? <FieldHelp>{field.description}</FieldHelp> : null}
      <div className="mt-auto space-y-1.5">
        <FieldControl field={field} renderChild={(child) => <FieldRenderer field={child} />} />
        <FieldError name={field.path} />
      </div>
    </div>
  );
}

function FieldControl({
  field,
  renderChild,
}: {
  field: FormField;
  renderChild: (field: FormField) => ReactNode;
}) {
  const Widget = lookupWidget(field.widget);
  if (Widget) return createElement(Widget, { name: field.path, fieldDef: field, renderChild });
  switch (field.kind) {
    case 'string':
      return <DefaultStringInput field={field} />;
    case 'number':
      return <DefaultNumberInput field={field} />;
    case 'boolean':
      return <DefaultBooleanInput field={field} />;
    case 'enum':
      return <DefaultEnumSelect field={field} />;
    case 'array':
      return <DefaultArrayRenderer field={field} />;
    default:
      return null;
  }
}

function DefaultStringInput({ field }: { field: FormField & { kind: 'string' } }) {
  const { control } = useFormContext();
  const { field: controller, fieldState } = useController({ name: field.path, control });
  const { value, onChange, onBlur, name, ref: inputRef } = controller;
  return (
    <Input
      id={field.path}
      type="text"
      autoComplete="off"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      name={name}
      ref={inputRef}
      aria-invalid={fieldState.invalid || undefined}
    />
  );
}

function DefaultNumberInput({ field }: { field: FormField & { kind: 'number' } }) {
  const { control } = useFormContext();
  const { field: controller, fieldState } = useController({ name: field.path, control });
  const { value, onChange, onBlur, name, ref: inputRef } = controller;
  return (
    <Input
      id={field.path}
      type="number"
      step={field.integer ? 1 : 'any'}
      min={field.minimum}
      max={field.maximum}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      onBlur={onBlur}
      name={name}
      ref={inputRef}
      aria-invalid={fieldState.invalid || undefined}
    />
  );
}

function DefaultBooleanInput({ field }: { field: FormField & { kind: 'boolean' } }) {
  const { control } = useFormContext();
  const { field: controller } = useController({ name: field.path, control });
  const { value, onChange, onBlur, name } = controller;
  // Radix Switch renders a <button>. A sibling <label htmlFor> names <input>/
  // <select> but NOT a <button> (accessible-name spec), so without this the
  // toggle is nameless to screen readers and tests. Name it from the field
  // label, which is the same text the visible <label> shows (Label in Name).
  return (
    <Switch
      id={field.path}
      aria-label={field.label}
      checked={Boolean(value)}
      onCheckedChange={(v) => onChange(v)}
      onBlur={onBlur}
      name={name}
    />
  );
}

function DefaultEnumSelect({ field }: { field: FormField & { kind: 'enum' } }) {
  const { control } = useFormContext();
  const { field: controller, fieldState } = useController({ name: field.path, control });
  const { value, onChange, onBlur, name, ref: inputRef } = controller;
  return (
    <select
      id={field.path}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      name={name}
      ref={inputRef}
      aria-invalid={fieldState.invalid || undefined}
      className={cn(
        'flex h-11 w-full rounded-xs border border-border bg-surface-alt px-3 py-2 text-sm text-fg focus-visible:border-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      <option value="" disabled>
        Select…
      </option>
      {field.options.map((opt) => (
        <option key={opt} value={opt}>
          {titleCase(opt)}
        </option>
      ))}
    </select>
  );
}

/**
 * For object-typed array rows, pick the row sub-field whose live value should
 * appear next to the auto-generated row label — "Interval 1 — 5m" instead of
 * "Interval 1". Heuristic order matches what schemas actually name their
 * identifying field: `interval` for Technicals rows, then a few generic
 * fallbacks. Returns `null` when no usable hint field exists, in which case
 * the row label keeps its current "{singular} {n}" form.
 */
const ROW_LABEL_HINT_KEYS = ['interval', 'name', 'id', 'label', 'title'] as const;
function pickRowLabelHintKey(element: FormField): string | null {
  if (element.kind !== 'object') return null;
  const fieldByPathSuffix = new Map(element.fields.map((f) => [f.path.split('.').pop() ?? '', f]));
  for (const key of ROW_LABEL_HINT_KEYS) {
    const child = fieldByPathSuffix.get(key);
    if (child && (child.kind === 'string' || child.kind === 'enum')) return key;
  }
  return null;
}

function ArrayRow({
  rowKey,
  rowPath,
  element,
  label,
}: {
  readonly rowKey: string;
  readonly rowPath: string;
  readonly element: FormField;
  readonly label: string;
}): React.JSX.Element {
  return (
    <FieldRenderer
      key={rowKey}
      field={{
        ...reindexPaths(element, element.path, rowPath),
        label,
        required: true,
      }}
    />
  );
}

function ArrayRowWithLiveLabel({
  rowKey,
  rowPath,
  element,
  baseLabel,
  hintKey,
}: {
  readonly rowKey: string;
  readonly rowPath: string;
  readonly element: FormField;
  readonly baseLabel: string;
  readonly hintKey: string;
}): React.JSX.Element {
  // useWatch is scoped per row so a value change in one row does not re-render
  // its siblings. The hook returns `undefined` on the first render before the
  // form mounts; the `typeof === 'string'` guard below elides the suffix
  // until a real string lands, so the legend renders "Interval 1" briefly
  // then "Interval 1 — 5m" once the form is hydrated.
  const hintValue = useWatch({ name: `${rowPath}.${hintKey}` }) as unknown;
  const suffix = typeof hintValue === 'string' && hintValue.length > 0 ? ` — ${hintValue}` : '';
  return (
    <ArrayRow rowKey={rowKey} rowPath={rowPath} element={element} label={`${baseLabel}${suffix}`} />
  );
}

/**
 * Value for a newly-appended array row: a structural clone of the last
 * existing row so "Add" pre-fills the previous row's values for the operator
 * to tweak (e.g. a grid level keeps the prior level's trigger/stop/limit/min/
 * max as a starting point), instead of a blank row. Falls back to `undefined`
 * (RHF's empty-row append) when the array is empty. Cloned so the new row never
 * shares a reference with its source. Exported for unit coverage.
 */
export function seedNextRow(rows: unknown): unknown {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  return structuredClone(rows[rows.length - 1]);
}

function DefaultArrayRenderer({ field }: { field: FormField & { kind: 'array' } }) {
  const { control, getValues } = useFormContext();
  const { fields, append, remove } = useFieldArray({ control, name: field.path });
  // `getValues` reads the live form state, not the `useFieldArray` snapshot,
  // so a freshly-typed last row is cloned when the operator clicks Add.
  const appendRow = () => append(seedNextRow(getValues(field.path)));
  // Each row's label is the array label singularised — "Grid Levels" yields
  // "Grid Level 1", not the generic "Item 1". The row's chrome (bordered box
  // + legend) is the element renderer's own fieldset; the array renderer only
  // adds the remove control, so an object element is not double-boxed.
  // The singularise is deliberately naive (trims a trailing `s`/`ies`) —
  // correct for the schema's array labels, not a general English pluraliser.
  const itemLabel = field.label.replace(/ies$/i, 'y').replace(/s$/i, '');
  // Optional row-label hint: for object rows that carry an identifying field
  // (e.g. `interval` for Technicals rows), show its live value next to the
  // auto-generated index — "Interval 1 — 5m" instead of "Interval 1".
  const hintKey = pickRowLabelHintKey(field.element);
  return (
    <div className="space-y-3">
      {fields.length === 0 ? <p className="text-sm text-muted-fg">No items.</p> : null}
      {fields.map((row, index) => {
        const baseLabel = `${itemLabel} ${index + 1}`;
        const rowPath = `${field.path}.${index}`;
        return (
          // `pr-12` reserves a column for the absolute remove button so it never
          // overlaps the element's content — for a scalar element (no fieldset
          // padding) the button would otherwise sit on top of the input.
          <div key={row.id} className="relative pr-12">
            {hintKey !== null ? (
              <ArrayRowWithLiveLabel
                rowKey={row.id}
                rowPath={rowPath}
                element={field.element}
                baseLabel={baseLabel}
                hintKey={hintKey}
              />
            ) : (
              <ArrayRow
                rowKey={row.id}
                rowPath={rowPath}
                element={field.element}
                label={baseLabel}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${itemLabel} ${index + 1}`}
              onClick={() => remove(index)}
              className="absolute top-1 right-1"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        );
      })}
      <Button type="button" variant="outline" onClick={appendRow} className="gap-2">
        <Plus className="size-4" /> Add
      </Button>
    </div>
  );
}

function FieldError({ name }: { name: string }) {
  const { formState } = useFormContext();
  const error = pickError(formState.errors, name);
  if (!error) return null;
  return (
    <p role="alert" className="text-xs text-danger">
      {error}
    </p>
  );
}

function pickError(errors: Record<string, unknown>, name: string): string | null {
  const segments = name.split('.');
  let cursor: unknown = errors;
  for (const seg of segments) {
    if (cursor && typeof cursor === 'object' && seg in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[seg];
    } else {
      return null;
    }
  }
  if (cursor && typeof cursor === 'object' && 'message' in (cursor as Record<string, unknown>)) {
    const msg = (cursor as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return null;
}
