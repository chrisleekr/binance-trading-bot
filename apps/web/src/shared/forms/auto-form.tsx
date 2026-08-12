import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  FormProvider,
  useForm,
  type DefaultValues,
  type FieldValues,
  type Path,
} from 'react-hook-form';
import {
  applyJsonSchemaDefaults,
  buildFormFieldsFromJsonSchema,
  type FormField,
} from '@app/contracts';

import { cn } from '@/shared/lib/cn';
import { Panel } from '@/shared/components/panel';
import { serverValidationErrors } from '@/shared/lib/api';
import { t } from '@/shared/lib/i18n';

import { AdvancedFold, FieldCells, FieldRenderer, isGroupField } from './field-renderer';
import { jsonSchemaResolver } from './json-schema-resolver';

/**
 * Top-level auto-form component. Pass a JSON Schema and an `onSubmit` handler
 * and the form renders itself: fields are derived from the schema and
 * per-field client validation runs against the same JSON Schema. The
 * schema is JSON Schema rather than a zod object because it arrives from the
 * API over the wire; the strategy package is never imported into the SPA.
 */
export interface AutoFormProps<T extends FieldValues> {
  /** JSON Schema (draft-07) describing the form shape, as sent by the API. */
  jsonSchema: Record<string, unknown>;
  defaultValues?: DefaultValues<T>;
  onSubmit: (values: T) => void | Promise<void>;
  children?: ReactNode;
  formId?: string;
  /**
   * Open every essential top-level group panel on first render instead of
   * leaving them collapsed. On by default in the symbol-config drawer and the
   * full-page profile config, where the operator came to read and edit the live
   * config — hiding its enabled values behind a click per section is friction.
   */
  defaultOpenGroups?: boolean;
  /**
   * Open the "Advanced settings" fold on first render. Defaults to
   * `defaultOpenGroups` so a fully-open surface (the drawer, past-run review)
   * opens everything, but the profile config sets it `false` to keep the
   * deliberately-tucked advanced knobs folded while its essential groups show.
   */
  defaultOpenAdvanced?: boolean;
  /**
   * Wrap the loose top-level fields (those not in an object group) in a static
   * "Core settings" panel. On by default so a generated form self-panels. A
   * single-purpose page whose one section IS the form (risk's daily-loss limit)
   * sets this `false` and renders `<AutoForm>` inside its own `Panel`, so the
   * fields don't get a redundant second box.
   */
  groupLooseFields?: boolean;
  /**
   * Optional sticky side panel rendered beside the form on desktop, inside the
   * form's react-hook-form context so it can `useWatch` the live, unsaved
   * values (the Config page's live ladder preview). Omitted → the form renders
   * full width as before.
   */
  aside?: ReactNode;
  /**
   * Called whenever the form's dirty state flips. Dirty = current values differ
   * from `defaultValues` (react-hook-form's own comparison), so it reads true
   * once the operator edits a field and false again if they revert it. The
   * backtest form uses it to reveal a "reset to live config" affordance only
   * while the config has drifted from the saved one. Pass a stable reference (a
   * `useState` setter or a `useCallback`); an inline function re-runs the
   * effect on every parent render.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * The error from the save/submit mutation (`mutation.error`). When it is a
   * server `VALIDATION_FAILED` carrying zod issues, each field-bound issue is
   * mapped onto its control so the message shows inline at the field — the same
   * place client-side schema-validation errors render. Cross-field rules the JSON Schema can't
   * express (a zod `.refine`) thus surface in the form instead of only in a
   * detached banner. Pass the raw error; non-validation errors are ignored here
   * and stay the caller's banner to render.
   */
  submitError?: unknown;
}

/**
 * Render a JSON-Schema-driven auto-form. The schema is the single source of
 * truth for field shape and client-side validation; the server re-validates
 * the submitted config against the strategy's own schema on save.
 */
export function AutoForm<T extends FieldValues>({
  jsonSchema,
  defaultValues,
  onSubmit,
  children,
  formId,
  defaultOpenGroups = false,
  defaultOpenAdvanced = defaultOpenGroups,
  groupLooseFields = true,
  aside,
  onDirtyChange,
  submitError,
}: AutoFormProps<T>) {
  const fields = useMemo(() => buildFormFieldsFromJsonSchema(jsonSchema), [jsonSchema]);
  // Overlay the supplied values onto the schema's defaults so a config saved
  // before a schema field existed renders that field at its default rather
  // than blank — a blank required field would then fail validation on save.
  const seeded = useMemo(
    () => applyJsonSchemaDefaults(jsonSchema, defaultValues ?? {}) as DefaultValues<T>,
    [jsonSchema, defaultValues],
  );
  const form = useForm<T>({
    resolver: jsonSchemaResolver(jsonSchema),
    defaultValues: seeded,
    mode: 'onBlur',
  });

  // Surface the form's dirty state to the parent. react-hook-form's `isDirty`
  // compares current values to `defaultValues`, so it reads true after an edit
  // and false again once values are reverted (or the form is remounted with new
  // defaults). Reading it here subscribes the proxy so the effect re-runs on flip.
  const { isDirty } = form.formState;
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Map a server validation rejection onto the form: each field-bound issue
  // renders inline at its control via setError, the same place client schema-validation errors
  // show. Tracks the names it set so the next submit (or a cleared error) removes
  // the stale ones rather than leaving a fixed field flagged. Form-level issues
  // (no path) and non-validation errors stay the caller's banner to surface.
  // `setError`/`clearErrors` are stable, so this runs only when `submitError`
  // changes.
  const { setError, clearErrors } = form;
  const serverErrorNames = useRef<string[]>([]);
  useEffect(() => {
    for (const name of serverErrorNames.current) clearErrors(name as Path<T>);
    const fieldIssues = serverValidationErrors(submitError);
    for (const issue of fieldIssues) {
      setError(issue.name as Path<T>, { type: 'server', message: issue.message });
    }
    serverErrorNames.current = fieldIssues.map((i) => i.name);
  }, [submitError, setError, clearErrors]);
  // Top-level groups render in collapsed <details>, so a field-level validation
  // error can sit hidden inside a closed section and block the save with no
  // visible cue. Surface a banner once the operator has tried to submit, so a
  // blocked save is never silent. Gated on a submit attempt to avoid nagging
  // mid-edit (mode: 'onBlur' populates errors before submit).
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const formError = pickFormLevelError(form.formState.errors);
  const hasFieldErrors = Object.keys(form.formState.errors).length > 0;
  const banner = formError ?? (submitAttempted && hasFieldErrors ? t('form.errors.blocked') : null);
  return (
    <FormProvider {...form}>
      <div className={cn(aside && 'grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]')}>
        <form
          id={formId}
          noValidate
          onSubmit={form.handleSubmit(onSubmit, () => setSubmitAttempted(true))}
          className="min-w-0 space-y-4"
        >
          {banner ? (
            <div
              role="alert"
              className="rounded-xs border border-danger bg-danger/10 p-3 text-sm text-danger"
            >
              {banner}
            </div>
          ) : null}
          <RootPanels
            fields={fields}
            openGroups={defaultOpenGroups}
            openAdvanced={defaultOpenAdvanced}
            groupLoose={groupLooseFields}
          />
          {children}
        </form>
        {aside ? (
          <aside className="lg:sticky lg:top-4 lg:max-h-[calc(100svh-6rem)] lg:self-start lg:overflow-y-auto">
            {aside}
          </aside>
        ) : null}
      </div>
    </FormProvider>
  );
}

/**
 * The form root as a vertical stack of titled panels: the loose top-level
 * fields (scalars and Amount-or-% controls, everything that is not a section)
 * bucket into one static "Core settings" panel, each object group is its own
 * collapsible panel, and the `@ui:advanced` fields fold under one disclosure.
 * So the top level reads as a uniform column of section panels rather than a
 * mix of boxed groups and loose fields. `defaultOpen` opens the group panels
 * and the Advanced fold for the symbol-config drawer and past-run review, where
 * a disclosure click per section is friction.
 */
function RootPanels({
  fields,
  openGroups,
  openAdvanced,
  groupLoose,
}: {
  readonly fields: readonly FormField[];
  /** Open the essential group panels on first render. */
  readonly openGroups: boolean;
  /** Open the "Advanced settings" fold (and its panels) on first render. */
  readonly openAdvanced: boolean;
  /** Wrap the loose top-level fields in a "Core settings" panel; when false they
   *  render bare so the host page can place them in its own section panel. */
  readonly groupLoose: boolean;
}): React.JSX.Element {
  const essential = fields.filter((f) => !f.advanced);
  const advanced = fields.filter((f) => f.advanced);
  const loose = essential.filter((f) => !isGroupField(f));
  const groups = essential.filter(isGroupField);
  const looseCells = (
    <FieldCells fields={loose} renderChild={(child) => <FieldRenderer field={child} />} />
  );
  return (
    <div className="space-y-4">
      {loose.length > 0 ? (
        groupLoose ? (
          <Panel title="Core settings">{looseCells}</Panel>
        ) : (
          looseCells
        )
      ) : null}
      {groups.map((group) => (
        <FieldRenderer key={group.path} field={group} depth={0} defaultOpen={openGroups} />
      ))}
      <AdvancedFold
        fields={advanced}
        defaultOpen={openAdvanced}
        renderChild={(field) => (
          <FieldRenderer field={field} depth={0} defaultOpen={openAdvanced} />
        )}
      />
    </div>
  );
}

/**
 * Surfaces a form-level error as a banner — a schema violation that is not
 * bound to a single field (e.g. a root-level `additionalProperties` or a
 * `required` miss the resolver reports against the form root).
 */
function pickFormLevelError(errors: Record<string, unknown>): string | null {
  const root = (errors as { root?: { message?: unknown } }).root;
  if (root && typeof root.message === 'string') return root.message;
  return null;
}
