import { z } from 'zod';

/**
 * Describes a notifier provider the API has registered. Each notifier package
 * owns its own config schema; this descriptor exposes just enough metadata
 * for the SPA to render the auto-form without importing the provider's
 * runtime code.
 */
export const NotifyProviderDescriptor = z.object({
  name: z.string(),
  version: z.string(),
  displayName: z.string(),
  configSchema: z.unknown(),
  secretFields: z.array(z.string()),
});
/** TS type derived from {@link NotifyProviderDescriptor} so consumers don't re-run z.infer at every call site. */
export type NotifyProviderDescriptor = z.infer<typeof NotifyProviderDescriptor>;

/** Response for `GET /profiles/:profileId/notify-providers`. */
export const NotifyProviderList = z.array(NotifyProviderDescriptor);
/** TS type derived from {@link NotifyProviderList} so consumers don't re-run z.infer at every call site. */
export type NotifyProviderList = z.infer<typeof NotifyProviderList>;

/**
 * Request body for `POST /profiles/:profileId/notify-providers/:name`.
 * `config` carries the provider-shaped payload; the API validates it
 * against the provider's own `configSchema` and splits the registered
 * `secretFields` out into the DB's `secrets` column before persisting.
 * Sending a partial config replaces the full row (no merge) so the
 * operator's UI must round-trip the existing config when editing.
 */
export const NotifyProviderConfigSave = z.object({
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean().default(true),
});
/** TS type derived from {@link NotifyProviderConfigSave} so consumers don't re-run z.infer at every call site. */
export type NotifyProviderConfigSave = z.infer<typeof NotifyProviderConfigSave>;

/**
 * Response for `POST /profiles/:profileId/notify-providers/:name`. Reuses the
 * descriptor shape — secrets are never returned, only the registered config
 * shape so the SPA can render the next edit cycle.
 */
export const NotifyProviderSaveResponse = NotifyProviderDescriptor.extend({
  enabled: z.boolean(),
});
/** TS type derived from {@link NotifyProviderSaveResponse} so consumers don't re-run z.infer at every call site. */
export type NotifyProviderSaveResponse = z.infer<typeof NotifyProviderSaveResponse>;

/**
 * Body + response for `PATCH /profiles/:profileId/notify-providers/:name/enabled`.
 * A minimal toggle decoupled from the config save: it flips only the `enabled`
 * flag and skips config validation, so an operator can switch a half-configured
 * notifier off without completing its form.
 */
export const NotifyProviderEnabled = z.object({ enabled: z.boolean() });
export type NotifyProviderEnabled = z.infer<typeof NotifyProviderEnabled>;

/**
 * Response for `GET /profiles/:profileId/notify-providers/:name`. Carries
 * descriptor metadata so the SPA can render the form, the persisted
 * `enabled` flag, and the non-secret `config` payload as last saved.
 * Secret-marked fields are omitted from `config` — they live in a separate
 * DB column and are masked by exclusion. The SPA may render the names from
 * `secretFields` as advisory inputs whose blank value, on re-save, falls
 * back to the stored secret per the POST handler's merge rule, so a
 * round-trip GET → POST never wipes a stored secret.
 *
 * `enabled` and `config` are `null` when no row has been saved yet for this
 * provider (operator has not configured it). The route returns the
 * descriptor with both fields null rather than 404'ing — a known-but-
 * unconfigured provider is a benign state, not an error, so the SPA can
 * render the empty form without each GET landing a noisy 404 in the
 * browser console.
 */
export const NotifyProviderSavedConfig = NotifyProviderDescriptor.extend({
  enabled: z.boolean().nullable(),
  config: z.record(z.string(), z.unknown()).nullable(),
});
/** TS type derived from {@link NotifyProviderSavedConfig} so consumers don't re-run z.infer at every call site. */
export type NotifyProviderSavedConfig = z.infer<typeof NotifyProviderSavedConfig>;

/**
 * Response for `POST /profiles/:profileId/notify-providers/:name:test-fire`.
 *
 * Always returns HTTP 200; the provider's success or failure is encoded in
 * the body so the SPA can render a green/red badge without parsing HTTP
 * status codes. `error` is a short human-readable label — when the provider
 * itself returns a structured failure, the operator's full triage path is
 * the audit log + provider logs, not this surface.
 */
export const NotifyProviderTestFireResponse = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
});
/** TS type derived from {@link NotifyProviderTestFireResponse} so consumers don't re-run z.infer at every call site. */
export type NotifyProviderTestFireResponse = z.infer<typeof NotifyProviderTestFireResponse>;
