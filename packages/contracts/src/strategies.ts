import { z } from 'zod';
import { OPERATOR_ACTIONS } from './operator-actions.js';

/**
 * Public strategy registry entry. `configSchema` is the strategy's config
 * schema serialised to JSON Schema (draft-07) by the API; the SPA renders a
 * generated form from it and validates against it client-side, without
 * importing the strategy package. The runtime registry keeps the original
 * zod object for re-validating submitted configs server-side.
 */
export const StrategyDescriptor = z.object({
  name: z.string(),
  version: z.string(),
  displayName: z.string(),
  description: z.string(),
  // Validated as an object-rooted JSON Schema so a malformed descriptor is
  // rejected at the API boundary, not deep in the SPA form renderer. The
  // `.record` base keeps every JSON Schema key (`$schema`, `additionalProperties`,
  // `$defs`, …) intact through parsing.
  configSchema: z
    .record(z.string(), z.unknown())
    .refine((s) => s['type'] === 'object' && typeof s['properties'] === 'object', {
      message: 'configSchema must be an object-rooted JSON Schema',
    }),
  // Partial of `configSchema` serialised the same way — the per-symbol
  // config override surface. The SPA renders the symbol-config editor from
  // it; every property is optional so an override carries only changed keys.
  overrideConfigSchema: z
    .record(z.string(), z.unknown())
    .refine((s) => s['type'] === 'object' && typeof s['properties'] === 'object', {
      message: 'overrideConfigSchema must be an object-rooted JSON Schema',
    }),
  // A valid, schema-conformant config the create-profile wizard seeds its
  // editor with. The strategy owns it because the wizard cannot synthesise a
  // valid config from the opaque `configSchema`. Typed as an object (not bare
  // `unknown`) so a non-object descriptor is rejected at this boundary — the
  // wizard's step-3 editor only accepts an object config.
  defaultConfig: z.record(z.string(), z.unknown()),
  // The operator actions this strategy honors, drawn from the closed
  // OPERATOR_ACTIONS set. The web hides unsupported panels and the api rejects
  // unsupported writes off this one declaration. An empty array means the
  // strategy exposes no operator-action surface (e.g. momentum today).
  operatorActions: z.array(z.enum(OPERATOR_ACTIONS)),
  // Map from a strategy decision reason/metric code to ALL its per-code display
  // copy: the plain-language `gloss`, its `kind` tint, the `setting`/`paths`
  // lever that armed it, and a `note` for a code with no editable lever. The SPA
  // renders the diagnosis funnel off this one declaration instead of a hardcoded
  // web copy. Plain strings; optional (absent on strategies with no entry copy).
  // The `kind` literals mirror strategy-core's ReasonKind (duplicated by design
  // so this package carries no strategy dependency).
  reasonAttribution: z
    .record(
      z.string(),
      z.object({
        setting: z.string().optional(),
        paths: z.array(z.string()).optional(),
        note: z.string().optional(),
        gloss: z.string().optional(),
        kind: z.enum(['market', 'config', 'sizing', 'data']).optional(),
      }),
    )
    .optional(),
});

/**
 * What kind of lever a blocker is, tinting it in the diagnosis funnel. Mirrors
 * strategy-core's `ReasonKind`; kept here so apps/web imports the type from
 * `@app/contracts`, never from a strategy package (core invariant #1).
 */
export type ReasonKind = 'market' | 'config' | 'sizing' | 'data';
/** TS type derived from {@link StrategyDescriptor} so consumers don't re-run z.infer at every call site. */
export type StrategyDescriptor = z.infer<typeof StrategyDescriptor>;

/** Response for `GET /strategies`. */
export const StrategyList = z.array(StrategyDescriptor);
/** TS type derived from {@link StrategyList} so consumers don't re-run z.infer at every call site. */
export type StrategyList = z.infer<typeof StrategyList>;
