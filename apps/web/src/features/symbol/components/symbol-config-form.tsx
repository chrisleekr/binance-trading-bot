// Per-symbol config override editor.
//
// Reuses the schema-driven `AutoForm` (same renderer the profile-config
// editor uses), seeded with the *effective* config — the profile config
// deep-merged with the stored override — so the operator edits from the
// state the worker actually runs. On submit the form values are diffed back
// against the profile config so only genuinely-overridden leaves persist;
// see `config-diff.ts` for why a naive full-config save is wrong.
//
// An override-summary panel rides the form's `children` slot (inside the
// react-hook-form provider) so it can read live values and revert a field
// without the shared `FieldRenderer` needing per-field decoration hooks.

import { useMemo, type ReactNode } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';

import { AutoForm } from '@/shared/forms';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Panel } from '@/shared/components/panel';
import { diffConfig, overrideLeaves } from '@/shared/lib/config-diff';
import { ForceSellGuardNudge } from '@/features/symbol/components/force-sell-guard-nudge';

import { titleCase } from '@app/contracts';
import { mergeConfig } from '@app/strategy-core/merge-config';

type Config = Record<string, unknown>;

// The override schema is `.strict()` and deliberately omits these
// profile-level keys (`candleInterval` drives the shared WS subscription),
// so they must not reach the override form or its diff.
const PROFILE_ONLY_KEYS: readonly string[] = ['symbol', 'candleInterval'];

function stripProfileOnly(config: Config): Config {
  const out: Config = {};
  for (const [key, value] of Object.entries(config)) {
    if (!PROFILE_ONLY_KEYS.includes(key)) out[key] = value;
  }
  return out;
}

/**
 * Render a config leaf value for the summary list. A scalar prints as-is; an
 * object prints its fields inline as humanised `Key: value` pairs; an array
 * prints its elements likewise — rather than as a raw JSON blob the operator
 * must parse. The input is a JSON-schema-derived config tree (finite, acyclic,
 * plain values), so the recursion always terminates.
 */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) {
    return value.length === 0 ? '—' : value.map((element) => formatValue(element)).join('; ');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '—';
    return entries.map(([key, inner]) => `${titleCase(key)}: ${formatValue(inner)}`).join(' · ');
  }
  return String(value);
}

/** Turn a dotted react-hook-form path into a humanised breadcrumb label. */
export function humanisePath(path: string): string {
  return path
    .split('.')
    .map((segment) => titleCase(segment))
    .join(' › ');
}

/**
 * Live override summary — count of overridden leaves plus a per-leaf row
 * showing the override value, the inherited profile value, and a revert
 * control. Reads the form's current values via `useWatch`, so it tracks
 * edits before they are saved.
 */
function OverrideSummary({ profileConfig }: { readonly profileConfig: Config }): React.JSX.Element {
  const { setValue } = useFormContext();
  const values = useWatch() as Config;
  const leaves = useMemo(
    () => overrideLeaves(profileConfig, diffConfig(profileConfig, values)),
    [profileConfig, values],
  );

  return (
    <Panel
      title="Overrides"
      testId="override-summary"
      actions={
        <Badge variant={leaves.length > 0 ? 'default' : 'outline'} data-testid="override-count">
          {leaves.length} overridden
        </Badge>
      }
    >
      {leaves.length === 0 ? (
        <p className="text-muted-fg text-xs">
          Every field matches the profile config — this symbol inherits it.
        </p>
      ) : (
        <ul className="divide-border divide-y text-sm">
          {leaves.map((leaf) => (
            <li
              key={leaf.path}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-1.5"
              data-testid={`override-leaf-${leaf.path}`}
            >
              <span className="font-medium">{humanisePath(leaf.path)}</span>
              <span className="text-muted-fg">
                <span className="font-mono">{formatValue(leaf.override)}</span>{' '}
                <span className="text-muted-fg">
                  (profile: <span className="font-mono">{formatValue(leaf.inherited)}</span>)
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="default"
                data-testid={`override-revert-${leaf.path}`}
                onClick={() =>
                  // `leaf.path` is a react-hook-form nested path (dot segments
                  // address nested fields). `structuredClone` so reverting an
                  // array/object field cannot alias the profile config.
                  setValue(leaf.path, structuredClone(leaf.inherited), {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
              >
                Revert
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * Schema-driven editor for a symbol's config override. `onSave` receives the
 * minimal override partial, or `null` when the edited config matches the
 * profile config (nothing to override).
 */
export function SymbolConfigForm({
  overrideConfigSchema,
  profileConfig,
  overrideConfig,
  onSave,
  defaultOpenGroups = false,
  aside,
  submitError,
}: {
  readonly overrideConfigSchema: Config;
  readonly profileConfig: Config;
  readonly overrideConfig: Config | null;
  readonly onSave: (override: Config | null) => void;
  /** Open every config section by default — set when rendered in the drawer. */
  readonly defaultOpenGroups?: boolean;
  /** Strategy live-preview side panel; reads the form's unsaved values. */
  readonly aside?: ReactNode;
  /** Save-mutation error; forwarded so server field issues render inline. */
  readonly submitError?: unknown;
}): React.JSX.Element {
  const base = useMemo(() => stripProfileOnly(profileConfig), [profileConfig]);
  // Seed the form with the effective config the worker would run, so the
  // operator edits from the current realised state rather than blank fields.
  const effective = useMemo(
    () => stripProfileOnly(mergeConfig(profileConfig, overrideConfig)),
    [profileConfig, overrideConfig],
  );

  return (
    <AutoForm
      jsonSchema={overrideConfigSchema}
      defaultValues={effective}
      onSubmit={(values) => onSave(diffConfig(base, values as Config))}
      submitError={submitError}
      formId="symbol-config-form"
      defaultOpenGroups={defaultOpenGroups}
      aside={aside}
    >
      {/* Save lives in the panel's sticky footer (the form is long when every
          section is open), wired back to this form via the submit button's
          `form` attribute. The override summary stays inline above it. */}
      <ForceSellGuardNudge />
      <OverrideSummary profileConfig={base} />
    </AutoForm>
  );
}
