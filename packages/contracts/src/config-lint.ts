import { z } from 'zod';

/**
 * One config diagnostic. Mirrors the strategy-core `ConfigDiagnostic`
 * (strategy-core has no contracts dependency, so the shape is restated here for
 * the API/web boundary). `warn` / `info` are advisory settings-lint findings;
 * `block` comes from the per-symbol order-feasibility check and means the config
 * cannot place a valid order — the form disables save on it and the profile /
 * backtest mutation rejects it. `path` is the config field path so the form can
 * point the operator at the setting.
 */
export const ConfigDiagnostic = z.object({
  level: z.enum(['warn', 'info', 'block']),
  code: z.string(),
  message: z.string(),
  path: z.array(z.string()).optional(),
});
export type ConfigDiagnostic = z.infer<typeof ConfigDiagnostic>;

/**
 * Advisories a successful mutation carries back: findings the operator can act
 * on that did not stop the write, so a save whose order sizing could not be
 * verified stops reading as a verified one.
 *
 * Optional and omitted (never `[]`) when there is nothing actionable, so the
 * common clean save keeps its exact shape and the field's presence is itself the
 * signal. Routine gaps a solo operator cannot act on, such as a profile that has
 * no streaming price until it is enabled, deliberately stay out.
 */
export const SaveDiagnostics = z.array(ConfigDiagnostic).optional();
/** TS type derived from {@link SaveDiagnostics} so consumers don't re-run z.infer at every call site. */
export type SaveDiagnostics = z.infer<typeof SaveDiagnostics>;

/** Request body for `POST /strategies/:name/lint-config`: the config to lint. */
export const ConfigLintRequest = z.object({
  config: z.unknown(),
});
export type ConfigLintRequest = z.infer<typeof ConfigLintRequest>;

/**
 * Response for the lint routes. `diagnostics` is empty when nothing is inert (or
 * the strategy has no lint). The config is validated against the strategy schema
 * first, and the two routes answer a schema-invalid config differently on
 * purpose: the strategy-scoped `POST /strategies/:name/lint-config` returns no
 * diagnostics, because the form's own field validation is already showing the
 * hard errors beside each input. The profile-scoped
 * `POST /profiles/:id/lint-config` returns a single `config-unverified` warn,
 * because it also reports the per-symbol order-feasibility check, and going
 * blank there would read as "sizing is fine" when sizing never ran.
 */
export const ConfigLintResponse = z.object({
  diagnostics: z.array(ConfigDiagnostic),
});
export type ConfigLintResponse = z.infer<typeof ConfigLintResponse>;
