// Per-profile notifier configuration panel, decoupled from any route so it can
// render as the body of its dedicated page (`/profiles/:id/notifications`); the
// host supplies `profileId` and the page chrome. Lists every registered
// provider, lets the operator edit
// the typed config form + enabled flag + secret fields, save the result, and fire
// a synthetic test message against the stored credential. Owns the notifiers
// query; the host only supplies profileId and the drawer chrome.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { AutoForm } from '@/shared/forms';
import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { Panel } from '@/shared/components/panel';
import { LoadingRows, PanelStackSkeleton } from '@/shared/components/page-skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { Switch } from '@/shared/components/ui/switch';
import { ApiError } from '@/shared/lib/api';
import {
  fetchNotifyProviders,
  fetchNotifyProviderSavedConfig,
  saveNotifyProviderConfig,
  setNotifyProviderEnabled,
  testFireNotifyProvider,
} from '@/features/notifications/api/notify-providers';
import { EventSubscriptions } from '@/features/notifications/components/event-subscriptions';

import { titleCase } from '@app/contracts';
import type { NotifyProviderDescriptor } from '@app/contracts';

type ConfigObject = Record<string, unknown>;

/**
 * Strips the provider's secret fields out of its JSON Schema. Secrets get
 * dedicated write-once password inputs below the form — a plain schema-driven
 * field cannot express "leave blank to keep the stored value".
 */
function configSchemaWithoutSecrets(
  schema: unknown,
  secretFields: readonly string[],
): ConfigObject {
  if (typeof schema !== 'object' || schema === null) return { type: 'object', properties: {} };
  const obj = schema as ConfigObject;
  const props = obj['properties'];
  const properties =
    typeof props === 'object' && props !== null
      ? Object.fromEntries(Object.entries(props).filter(([key]) => !secretFields.includes(key)))
      : {};
  const required = Array.isArray(obj['required'])
    ? obj['required'].filter(
        (key): key is string => typeof key === 'string' && !secretFields.includes(key),
      )
    : [];
  const result: ConfigObject = { ...obj, properties, required };
  // The AutoForm edits only the non-secret subset, so the real config always
  // carries "additional" (secret) keys. Drop `additionalProperties: false` so
  // client-side validation does not reject the form on those — the server re-validates against
  // the provider's full Zod schema on save.
  delete result['additionalProperties'];
  return result;
}

/** Drops secret keys from a persisted config so they are not seeded as form defaults. */
function nonSecretConfig(config: ConfigObject, secretFields: readonly string[]): ConfigObject {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !secretFields.includes(key)));
}

/**
 * Pull a field's `description` out of the provider's JSON Schema. Secret
 * fields are stripped from the AutoForm (so the renderer's own help line never
 * shows for them); reading the schema here lets the password input carry the
 * same inline help as the non-secret fields.
 */
function fieldDescription(schema: unknown, field: string): string | null {
  if (typeof schema !== 'object' || schema === null) return null;
  const props = (schema as ConfigObject)['properties'];
  if (typeof props !== 'object' || props === null) return null;
  const node = (props as ConfigObject)[field];
  if (typeof node !== 'object' || node === null) return null;
  const description = (node as ConfigObject)['description'];
  return typeof description === 'string' ? description : null;
}

/**
 * Whether the provider's JSON Schema marks `field` required. A secret can be
 * optional (e.g. the webhook's auth header for an unauthenticated endpoint);
 * marking it with a required `*` would push the operator to invent a value.
 */
function isRequiredField(schema: unknown, field: string): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  const required = (schema as ConfigObject)['required'];
  return Array.isArray(required) && required.includes(field);
}

/**
 * Per-provider editor card. Kept as a child component so each provider's
 * form state (enabled flag, secret inputs, banner state) lives in its own
 * React subtree — saving Slack does not clobber the operator's draft in the
 * Telegram card. The non-secret config is a typed `AutoForm` rendered from the
 * provider's JSON Schema; secrets are separate password inputs with write-once
 * semantics.
 */
function ProviderEditor({
  profileId,
  provider,
}: {
  profileId: string;
  provider: NotifyProviderDescriptor;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const saved = useQuery({
    queryKey: ['notify-provider-saved', profileId, provider.name],
    queryFn: () => fetchNotifyProviderSavedConfig(profileId, provider.name),
  });
  const [enabled, setEnabled] = useState(true);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<ActionBannerState | null>(null);

  // Hydrate the enabled flag once the GET completes; reset secret inputs so a
  // stale draft from a previous provider does not leak across selection.
  // `enabled` is null when no row has been saved yet — leave the local default
  // (true) for the unconfigured form.
  useEffect(() => {
    if (saved.data?.enabled != null) setEnabled(saved.data.enabled);
    setSecrets({});
  }, [saved.data]);

  const save = useMutation({
    mutationFn: (config: ConfigObject) => {
      // Merge operator-entered secrets into the body. Blank inputs are dropped
      // so the API falls back to the stored secret — sending `''` would 422 on
      // a required-secret check.
      const body: ConfigObject = { ...config };
      for (const field of provider.secretFields) {
        const value = secrets[field];
        if (typeof value === 'string' && value.length > 0) body[field] = value;
      }
      // First save (no row yet) enables the notifier — the operator just
      // configured it to use it. A later save preserves the switch state, which
      // the standalone toggle otherwise owns.
      const nextEnabled = saved.data?.config != null ? enabled : true;
      return saveNotifyProviderConfig(profileId, provider.name, {
        config: body,
        enabled: nextEnabled,
      });
    },
    onSuccess: () => {
      setBanner({ kind: 'ok', message: 'Saved.' });
      setSecrets({});
      void queryClient.invalidateQueries({
        queryKey: ['notify-provider-saved', profileId, provider.name],
      });
    },
    onError: (err: unknown) => {
      const message =
        err instanceof ApiError ? `${err.code}: ${err.message}` : ((err as Error).message ?? '');
      setBanner({ kind: 'err', message: message || 'save failed' });
    },
  });

  // The enabled switch persists on its own, decoupled from the config Save:
  // toggling off never re-validates config, so a half-configured notifier can
  // still be turned off. Optimistic — revert the switch if the PATCH fails.
  const toggleEnabled = useMutation({
    mutationFn: (next: boolean) => setNotifyProviderEnabled(profileId, provider.name, next),
    onMutate: (next: boolean) => {
      const prev = enabled;
      setEnabled(next);
      return { prev };
    },
    onError: (err: unknown, _next, ctx) => {
      if (ctx) setEnabled(ctx.prev);
      const message =
        err instanceof ApiError ? `${err.code}: ${err.message}` : ((err as Error).message ?? '');
      setBanner({ kind: 'err', message: message || 'toggle failed' });
    },
    onSuccess: (res) => {
      setEnabled(res.enabled);
      setBanner({ kind: 'ok', message: res.enabled ? 'Enabled.' : 'Disabled.' });
      void queryClient.invalidateQueries({
        queryKey: ['notify-provider-saved', profileId, provider.name],
      });
    },
  });

  const testFire = useMutation({
    mutationFn: () => testFireNotifyProvider(profileId, provider.name),
    // A 200 can still carry ok:false (the provider rejected the synthetic
    // message), so branch on the payload, not just the HTTP result.
    onSuccess: (result) =>
      setBanner(
        result.ok
          ? { kind: 'ok', message: 'Test message sent.' }
          : { kind: 'err', message: result.error ?? 'Test fire failed' },
      ),
    onError: (err: unknown) => {
      const message = err instanceof ApiError ? `${err.code}: ${err.message}` : 'test-fire failed';
      setBanner({ kind: 'err', message });
    },
  });

  // `saved.data` is always present once loaded (the route returns the
  // descriptor with config:null when nothing has been saved yet). The
  // "has a saved row" signal is whether `config` itself is populated.
  const hasSavedRow = saved.data?.config != null;
  const jsonSchema = configSchemaWithoutSecrets(provider.configSchema, provider.secretFields);
  const savedConfig = saved.data?.config ?? null;
  const defaultValues =
    savedConfig != null ? nonSecretConfig(savedConfig, provider.secretFields) : undefined;

  const enabledControl = (
    <div className="flex items-center gap-2">
      <Label htmlFor={`enabled-${provider.name}`} className="text-sm font-medium text-fg">
        Enabled
      </Label>
      <Switch
        id={`enabled-${provider.name}`}
        // Off + inert until a config exists: enabling needs a saved (valid)
        // config, and there is nothing to disable before the first save.
        checked={hasSavedRow ? enabled : false}
        onCheckedChange={(next) => toggleEnabled.mutate(next)}
        disabled={!hasSavedRow || toggleEnabled.isPending}
        data-testid={`enabled-${provider.name}`}
      />
      {!hasSavedRow ? <span className="text-xs text-muted-fg">Save a config to enable</span> : null}
    </div>
  );

  return (
    <Panel
      title={provider.displayName}
      description={`${provider.name} · v${provider.version}`}
      actions={enabledControl}
    >
      {/* Gate the AutoForm on the GET so `defaultValues` is populated at mount
          — `useForm` reads them once and a later arrival would not re-seed. */}
      {saved.isLoading ? (
        // Stands in for the generated provider form: its config fields plus the
        // save row.
        <LoadingRows rows={4} />
      ) : (
        // groupLooseFields={false}: this Panel is the provider's section, so the
        // form's loose fields render bare rather than in a nested "Core settings" box.
        <AutoForm<ConfigObject>
          jsonSchema={jsonSchema}
          {...(defaultValues ? { defaultValues } : {})}
          onSubmit={(values) => save.mutate(values)}
          submitError={save.error}
          groupLooseFields={false}
        >
          {provider.secretFields.length > 0 ? (
            <div className="space-y-2">
              {provider.secretFields.map((field) => {
                const requiredSecret = isRequiredField(provider.configSchema, field);
                const description = fieldDescription(provider.configSchema, field);
                return (
                  <div key={field} className="space-y-1">
                    <Label
                      htmlFor={`secret-${provider.name}-${field}`}
                      className="flex items-center gap-1 text-sm font-medium text-fg"
                    >
                      {titleCase(field)}
                      {hasSavedRow ? (
                        <span className="font-normal text-muted-fg">
                          (leave blank to keep current value)
                        </span>
                      ) : requiredSecret ? (
                        <span aria-hidden="true" className="text-danger">
                          *
                        </span>
                      ) : (
                        <span className="font-normal text-muted-fg">(optional)</span>
                      )}
                    </Label>
                    {description ? <p className="text-xs text-muted-fg">{description}</p> : null}
                    <Input
                      id={`secret-${provider.name}-${field}`}
                      data-testid={`secret-${provider.name}-${field}`}
                      className="h-9 rounded-none border-0 border-b bg-transparent px-0 focus-visible:ring-0"
                      // A required secret renders a visual `*` (aria-hidden);
                      // aria-required carries the required state to assistive
                      // tech. A saved row (blank keeps the stored value) or an
                      // optional secret (e.g. webhook auth header) is non-required.
                      aria-required={requiredSecret && !hasSavedRow}
                      type="password"
                      autoComplete="new-password"
                      value={secrets[field] ?? ''}
                      onChange={(e) => setSecrets((prev) => ({ ...prev, [field]: e.target.value }))}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}

          <ActionBanner banner={banner} />

          <div className="flex gap-2">
            <Button
              type="submit"
              variant="default"
              disabled={save.isPending}
              data-testid={`save-${provider.name}`}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => testFire.mutate()}
              disabled={!hasSavedRow || testFire.isPending}
              data-testid={`test-fire-${provider.name}`}
              title={hasSavedRow ? '' : 'Save a config before firing a test'}
            >
              {testFire.isPending ? 'Sending…' : 'Test Fire'}
            </Button>
          </div>
        </AutoForm>
      )}
    </Panel>
  );
}

/**
 * Self-contained per-profile notifier editor. Renders the notifiers query's
 * load/error/empty states, then one `ProviderEditor` card per registered
 * provider. Owns only the providers list query; each card owns its own saved
 * config and mutations.
 */
export function NotificationsPanel({
  profileId,
}: {
  readonly profileId: string;
}): React.JSX.Element {
  const list = useQuery({
    queryKey: ['notify-providers', profileId],
    queryFn: () => fetchNotifyProviders(profileId),
  });

  return (
    <div className="space-y-6" data-testid="notifications-panel">
      <EventSubscriptions profileId={profileId} />

      {/* One panel per registered provider — Slack, Telegram and Webhook ship
          in the default build. */}
      {list.isLoading ? <PanelStackSkeleton shape={[3, 2, 2]} /> : null}
      {list.error ? (
        <Alert variant="danger">
          <AlertTitle>Failed</AlertTitle>
          <AlertDescription>
            {list.error instanceof Error ? list.error.message : 'unknown'}
          </AlertDescription>
        </Alert>
      ) : null}

      {list.data && list.data.length === 0 ? (
        <p className="text-sm text-muted-fg">
          No notifiers registered. The build links Slack, Telegram, and Webhook by default — check
          the api boot wiring.
        </p>
      ) : null}

      <ul className="space-y-6">
        {(list.data ?? []).map((provider: NotifyProviderDescriptor) => (
          <li key={provider.name}>
            <ProviderEditor profileId={profileId} provider={provider} />
          </li>
        ))}
      </ul>
    </div>
  );
}
