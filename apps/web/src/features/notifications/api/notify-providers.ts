// Per-profile notifier registry. The list endpoint returns the providers the
// API has registered (Slack/Telegram/Webhook in v1.0); each descriptor exposes
// the JSON-shaped config schema and the names of fields the operator must
// treat as write-once secrets.

import {
  NotifyProviderConfigSave,
  NotifyProviderEnabled,
  NotifyProviderList,
  NotifyProviderSavedConfig,
  NotifyProviderSaveResponse,
  NotifyProviderTestFireResponse,
} from '@app/contracts';

import { apiFetch, encodePathSegment } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

const providerPath = (profileId: string, name: string): string =>
  accountPath(
    `/profiles/${encodePathSegment(profileId)}/notify-providers/${encodePathSegment(name)}`,
  );

/**
 * Fetch the notifier registry for one profile.
 *
 * The result is read-only metadata about which providers the API can drive
 * (one entry per registered package); callers render the list without ever
 * receiving secret material — secret fields are returned as redacted markers
 * by the backend. Path-encoding `profileId` keeps a malformed id surfacing as
 * a 404 instead of a malformed URL.
 */
export const fetchNotifyProviders = (profileId: string): Promise<NotifyProviderList> =>
  apiFetch(
    accountPath(`/profiles/${encodePathSegment(profileId)}/notify-providers`),
    NotifyProviderList,
    {
      method: 'GET',
    },
  );

/**
 * Fetch the persisted config for one provider on one profile. Returns the
 * descriptor plus the `enabled` flag and the non-secret `config` payload;
 * stored secrets are masked-by-exclusion at the API and never appear here.
 * The API answers 200 with `enabled: null, config: null` when nothing is
 * saved yet — a benign empty state rather than a 404 so the console isn't
 * spammed on every visit to the notifications page.
 */
export const fetchNotifyProviderSavedConfig = (
  profileId: string,
  name: string,
): Promise<NotifyProviderSavedConfig> =>
  apiFetch(providerPath(profileId, name), NotifyProviderSavedConfig, { method: 'GET' });

/**
 * Save the operator-edited config + enabled flag. Secret fields the operator
 * left blank fall back to whatever the backend already has — the POST handler
 * merges blank inputs with the stored secret, so a save-after-edit round-trip
 * never wipes a previously-stored secret.
 */
export const saveNotifyProviderConfig = (
  profileId: string,
  name: string,
  body: NotifyProviderConfigSave,
): Promise<NotifyProviderSaveResponse> =>
  apiFetch(providerPath(profileId, name), NotifyProviderSaveResponse, {
    method: 'POST',
    body,
  });

/**
 * Toggle a provider's enabled flag on its own, without re-sending (or
 * re-validating) the config. Lets the switch persist immediately and lets an
 * operator disable a half-configured notifier that the Save form would reject.
 * 404s when no config row exists yet — the switch is inert until first save.
 */
export const setNotifyProviderEnabled = (
  profileId: string,
  name: string,
  enabled: boolean,
): Promise<NotifyProviderEnabled> =>
  apiFetch(`${providerPath(profileId, name)}/enabled`, NotifyProviderEnabled, {
    method: 'PATCH',
    body: { enabled },
  });

/**
 * Synthetic send against the stored credential — used by the SPA's
 * "Test Fire" button. Always HTTP 200; the provider's outcome rides in the
 * `{ ok, error }` body so the UI can render a green/red badge without
 * branching on status codes. `test-fire` is a path segment, not a colon-verb
 * suffix, so Hono routes it past the bare `{name}` save handler.
 */
export const testFireNotifyProvider = (
  profileId: string,
  name: string,
): Promise<NotifyProviderTestFireResponse> =>
  apiFetch(`${providerPath(profileId, name)}/test-fire`, NotifyProviderTestFireResponse, {
    method: 'POST',
  });
