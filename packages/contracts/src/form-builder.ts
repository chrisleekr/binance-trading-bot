/**
 * Tag prefix for widget hints. Strategies attach a hint on a leaf via
 * `z.number().describe('@ui:percentage')` so the SPA can pick a domain
 * widget without the strategy package shipping React. The closed registry
 * lookup happens in `apps/web`; the schema only carries the string.
 */
export const WIDGET_TAG_PREFIX = '@ui:';

/**
 * `@ui:` token (not a widget) that marks a field as advanced. The renderer
 * tucks advanced fields into a per-section "Advanced" disclosure so a section
 * lands as its few essential fields, not a wall. A field may carry both a
 * widget hint and this flag in the same leading `@ui:` run, e.g.
 * `@ui:percent-below @ui:advanced How far…`.
 */
export const ADVANCED_TAG = 'advanced';

/**
 * Common metadata extracted for every field. `widget` is the parsed `@ui:*`
 * hint; `description` is the remainder of the zod `.describe()` string with
 * the hint stripped. Both are `null` when absent so render code never has to
 * distinguish "missing key" from "empty string".
 */
export interface FormFieldBase {
  /** dot-path from the schema root, used as react-hook-form `name`. */
  path: string;
  /** human label derived from the last path segment via title-casing. */
  label: string;
  /** widget hint without the `@ui:` prefix, or null when absent. */
  widget: string | null;
  /** description text with the widget hint stripped, or null when empty. */
  description: string | null;
  /** true when the field carries `@ui:advanced` — the renderer folds it into a per-section "Advanced" disclosure. */
  advanced: boolean;
  /** whether the parent object marks this property as required. */
  required: boolean;
  /** initial form value derived from the JSON Schema `default`; `undefined` when none. */
  defaultValue: unknown;
}

/**
 * Discriminated field union. Each variant carries the JSON Schema-derived
 * constraints the renderer needs (min/max for numerics, options for enums,
 * `fields` for objects, `element` template for arrays). Cross-field
 * constraints are not representable in JSON Schema, so the field tree is
 * purely declarative; such rules are enforced server-side on save.
 */
export type FormField =
  | (FormFieldBase & {
      kind: 'string';
      minLength?: number;
      maxLength?: number;
      pattern?: string;
    })
  | (FormFieldBase & {
      kind: 'number';
      minimum?: number;
      maximum?: number;
      exclusiveMinimum?: number;
      exclusiveMaximum?: number;
      step?: number;
      integer: boolean;
    })
  | (FormFieldBase & { kind: 'boolean' })
  | (FormFieldBase & { kind: 'enum'; options: readonly string[] })
  | (FormFieldBase & { kind: 'object'; fields: FormField[] })
  | (FormFieldBase & { kind: 'array'; element: FormField });

/**
 * Walk a JSON Schema object and produce the field tree consumed by the
 * auto-form renderer. The API serialises each strategy's config schema with
 * `z.toJSONSchema` and ships the result; the SPA renders from that without
 * importing the strategy package. The shape returned is intentionally
 * simpler than full JSON Schema, only the properties the SPA renders.
 */
export function buildFormFieldsFromJsonSchema(jsonSchema: unknown): FormField[] {
  const json = jsonSchema as JsonSchemaNode;
  const root = resolve(json, json);
  if (root.type !== 'object' || !root.properties) {
    throw new Error('form-builder expects an object schema at the root');
  }
  return walkObject(root, [], json).fields;
}

interface JsonSchemaNode {
  $ref?: string;
  $defs?: Record<string, JsonSchemaNode>;
  definitions?: Record<string, JsonSchemaNode>;
  type?: string | string[];
  description?: string;
  default?: unknown;
  enum?: readonly unknown[];
  properties?: Record<string, JsonSchemaNode>;
  required?: readonly string[];
  items?: JsonSchemaNode;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  anyOf?: readonly JsonSchemaNode[];
  oneOf?: readonly JsonSchemaNode[];
  allOf?: readonly JsonSchemaNode[];
}

function resolve(node: JsonSchemaNode, root: JsonSchemaNode): JsonSchemaNode {
  if (!node.$ref) return node;
  const path = node.$ref.replace(/^#\//, '').split('/');
  let cursor: unknown = root;
  for (const seg of path) {
    if (cursor && typeof cursor === 'object' && seg in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[seg];
    } else {
      throw new Error(`form-builder: unresolved $ref ${node.$ref}`);
    }
  }
  return resolve(cursor as JsonSchemaNode, root);
}

const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

const nodeType = (node: JsonSchemaNode): string | undefined =>
  Array.isArray(node.type) ? node.type[0] : node.type;

/**
 * True when a schema node accepts *any* string — an unconstrained `string`
 * type with no enum/pattern/length/format bound. A text input collapsed onto
 * such a variant can never produce a value that variant rejects.
 */
const acceptsAnyString = (node: JsonSchemaNode): boolean =>
  nodeType(node) === 'string' &&
  node.enum === undefined &&
  node.pattern === undefined &&
  node.minLength === undefined &&
  node.maxLength === undefined &&
  node.format === undefined;

function flattenAnyOf(node: JsonSchemaNode, root: JsonSchemaNode): JsonSchemaNode {
  const variants = node.anyOf ?? node.oneOf;
  if (!variants) return node;
  const concrete = variants.map((v) => resolve(v, root)).filter((v) => !(v.type === 'null'));
  if (concrete.length === 1) return { ...node, ...concrete[0] };
  // A scalar union that includes an unconstrained string variant (e.g.
  // `string | number`) has no single JSON Schema `type` the renderer can
  // switch on — collapse it to a string input. Any value the text field
  // produces satisfies the string branch, so the form stays consistent with
  // ajv's `anyOf` validation. A union without a free string member (e.g.
  // `enum | number`) is left alone: collapsing it would let the input emit
  // values ajv rejects.
  if (
    concrete.length > 1 &&
    concrete.every((v) => SCALAR_TYPES.has(nodeType(v) ?? '')) &&
    concrete.some(acceptsAnyString)
  ) {
    return { ...node, type: 'string' };
  }
  return node;
}

/**
 * Domain acronyms that must render fully upper-cased in a label — plain
 * title-casing would mangle `rsiMaxBuy` into `Rsi Max Buy`. Matched
 * case-insensitively against each whitespace-split word; used by `titleCase`
 * for both field labels (from property keys) and enum-option labels.
 */
const LABEL_ACRONYMS = new Set([
  'rsi',
  'sma',
  'ema',
  'ma',
  'atr',
  'usd',
  'usdt',
  'ath',
  'api',
  'url',
  'id',
  'ttl',
]);

/**
 * Path-suffix → operator-facing label overrides. The default `titleCase`
 * derives labels from property keys (`useOnlyWithinMin` → "Use Only Within
 * Min"), which works for most fields but mangles three Technicals keys that
 * the contracts schema keeps. Keys are matched as a longest-
 * suffix on the field's full dotted path — `'technicals.useOnlyWithinMin'`
 * matches both the profile-config and per-symbol-override surfaces, but a
 * hypothetical future `websocket.useOnlyWithinMin` for an unrelated domain
 * stays unaffected. Add new entries when the auto-label is wrong; keep the
 * scope as tight as the override needs.
 *  - `technicals` is the canonical block name; humanises to "Technicals".
 *  - `…technicals.useOnlyWithinMin` is a freshness window in minutes — the
 *    bare suffix "Min" reads as ambiguous ("minimum"? "min cap"?) without
 *    context.
 *  - `…technicals.ifExpires` does not say what expires; the form has plenty
 *    of room to name it clearly.
 */
const LABEL_OVERRIDES: Record<string, string> = {
  technicals: 'Technicals',
  'technicals.useOnlyWithinMin': 'Freshness window (minutes)',
  'technicals.ifExpires': 'When signal is stale',
  // `checkTechnicals` humanises to "Check Technicals" which reads as
  // "verify Technicals status" — the field actually toggles whether the
  // Technicals signal vetoes a buy. The clearer label keeps the operator
  // mental model aligned with the gate the toggle controls.
  'forceBuyOverride.checkTechnicals': 'Apply Technicals gate',
  // Directional labels for the move-by-percent fields. These render with the
  // percent-converting widget (`@ui:percent-above/below/of`), so the operator
  // types a plain percent and the widget stores the multiplier/fraction. The
  // label states the direction (above/below/from-peak) the bare `%` suffix
  // can't, so the operator never has to remember which way the value points.
  // Bare suffixes match the grid-level array paths
  // (`buy.gridLevels.<n>.stopPricePercentage`); the sell.* keys are longer and
  // win the longest-suffix tie-break over a bare `triggerPercentage`.
  triggerPercentage: 'Buy-again trigger (below avg cost)',
  stopPricePercentage: 'Buy stop price (above current)',
  limitPricePercentage: 'Buy limit price (above current)',
  'buy.avgEntryPriceRemoveThreshold': 'Dust cleanup price (below avg entry)',
  'sell.stopLossPercentage': 'Stop-loss (below entry)',
  'sell.triggerPercentage': 'Trailing-stop arm (above entry)',
  'sell.trailingStopPercentage': 'Trailing-stop distance (from peak)',
  trailingStopPct: 'Trailing-stop distance (from peak)',
  // Quote-absolute risk caps; the auto-labels ("Max Symbol Exposure Quote")
  // read as jargon. Plain labels; the help text carries the worked example.
  maxSymbolExposureQuote: 'Max capital per symbol',
  maxPositionLossQuote: 'Max loss per position',
  // Indicator-gate knobs: name what the operator sets, not the raw acronym key.
  rsiMaxBuy: 'RSI buy ceiling',
  smaBias: 'SMA price filter',
  emaBias: 'EMA price filter',
  // Candle-count / ATR-distance fields read as a bare "Period"/"Multiplier"
  // out of their group; name the unit inline. Scoped 2-segment so they only
  // match the intended array/object member.
  'atrTrailing.period': 'ATR lookback (candles)',
  'atrTrailing.multiplier': 'ATR trail distance (× ATR)',
  'ema.fast': 'Fast EMA length (candles)',
  'ema.slow': 'Slow EMA length (candles)',
  // Auto-discovery config (DiscoveryConfigSchema). The camelCase keys
  // title-case into jargon ("Refresh Period Ms", "Min24h Quote Volume",
  // "Change Min Percent"); name the operator-facing meaning + unit instead.
  // All discovery-specific keys, so a bare-suffix match is unambiguous.
  refreshPeriodMs: 'Scan interval (ms)',
  min24hPairVolumeUsd: 'Min 24h volume on this market (USD)',
  min24hAssetVolumeUsd: 'Min 24h volume for the coin (USD)',
  rankTopPercent: 'Consider top % of gainers',
  rankExcludeTopPercent: 'Skip hottest % of gainers',
  maxSpreadRatio: 'Max bid/ask spread',
  changeMinPercent: 'Min 24h gain (%)',
  minAgeDays: 'Min listing age (days)',
  minHoldMinutes: 'Min hold (minutes)',
  // "blocklist" everywhere else in the discovery UI (Block button, reason copy).
  blacklist: 'Blocklist',
};

/** Return the first LABEL_OVERRIDES key that matches `path` as a longest-suffix, or `null`. */
function pickOverride(path: string): string | null {
  // Longest-suffix wins so `technicals.useOnlyWithinMin` outranks a
  // hypothetical bare `useOnlyWithinMin` entry if one is ever added.
  let best: { key: string; label: string } | null = null;
  for (const [key, label] of Object.entries(LABEL_OVERRIDES)) {
    if (path === key || path.endsWith(`.${key}`)) {
      if (best === null || key.length > best.key.length) best = { key, label };
    }
  }
  return best?.label ?? null;
}

/**
 * Title-case an identifier-shaped segment for display — `rsiMaxBuy` and
 * `price-below-sma` both become readable labels. Splits on `_`/`-` and
 * camelCase boundaries; domain acronyms (RSI/SMA/EMA/…) render fully
 * upper-cased. Exported so enum-option labels reuse the same humanisation
 * as the field labels derived from property keys.
 */
export function titleCase(segment: string): string {
  return segment
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) =>
      LABEL_ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

/** A plain object — not an array, not null. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Collect a JSON Schema's `default` keywords into a nested object. Recurses
 * into nested object `properties`; a node carrying its own `default` is taken
 * whole (zod emits an object `.default()` as one `default` keyword that
 * already encodes the nested values).
 *
 * Traverses inline `properties` only — it does not dereference `$ref` or
 * flatten `anyOf`. `z.toJSONSchema` emits the v1.0 strategy and notifier
 * config schemas fully inline (each sub-schema is used once, so nothing is
 * deduped into `$defs`), so this is sufficient today. A schema that reuses a
 * sub-schema, producing `$ref`, would need this to share the `resolve` /
 * `flattenAnyOf` walk that {@link buildFormFieldsFromJsonSchema} uses.
 */
function collectSchemaDefaults(node: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(node)) return out;
  const props = node['properties'];
  if (!isPlainObject(props)) return out;
  for (const [key, raw] of Object.entries(props)) {
    if (!isPlainObject(raw)) continue;
    if ('default' in raw) {
      out[key] = raw['default'];
    } else if (raw['type'] === 'object') {
      const nested = collectSchemaDefaults(raw);
      if (Object.keys(nested).length > 0) out[key] = nested;
    }
  }
  return out;
}

/** Deep-overlay `values` onto `defaults` — `values` wins per key; nested objects merge. */
function mergeDefaults(
  defaults: Record<string, unknown>,
  values: unknown,
): Record<string, unknown> {
  if (!isPlainObject(values)) return defaults;
  const out: Record<string, unknown> = { ...values };
  for (const [key, dflt] of Object.entries(defaults)) {
    const cur = out[key];
    if (cur === undefined) {
      out[key] = dflt;
    } else if (isPlainObject(dflt) && isPlainObject(cur)) {
      out[key] = mergeDefaults(dflt, cur);
    }
  }
  return out;
}

/**
 * Seed form values from a JSON Schema: overlay the supplied `values` onto the
 * schema's `default` keywords so a record persisted before a schema field
 * existed still renders that field at its default rather than blank (which
 * would then fail validation on save). The supplied values win wherever
 * present; only genuinely missing fields fall back to the schema default. A
 * key set to `null` is kept (only `undefined` falls back to the default).
 *
 * The result may share nested references with `values` for keys the schema
 * has no default for — callers must not mutate it. react-hook-form clones
 * `defaultValues` internally, so the {@link applyJsonSchemaDefaults} caller
 * (`AutoForm`) is safe.
 */
export function applyJsonSchemaDefaults(
  jsonSchema: unknown,
  values: unknown,
): Record<string, unknown> {
  return mergeDefaults(collectSchemaDefaults(jsonSchema), values);
}

function parseDescription(raw: string | undefined): {
  widget: string | null;
  description: string | null;
  advanced: boolean;
} {
  if (!raw) return { widget: null, description: null, advanced: false };
  // Consume the leading run of `@ui:<token>` hints. The first non-`advanced`
  // token is the widget; an `advanced` token sets the tier flag; whatever
  // follows the run is the human description.
  let rest = raw.trim();
  let widget: string | null = null;
  let advanced = false;
  while (rest.startsWith(WIDGET_TAG_PREFIX)) {
    const space = rest.indexOf(' ');
    const token = (space === -1 ? rest : rest.slice(0, space)).slice(WIDGET_TAG_PREFIX.length);
    rest = space === -1 ? '' : rest.slice(space + 1).trimStart();
    if (token === ADVANCED_TAG) advanced = true;
    else if (widget === null) widget = token;
    if (space === -1) break;
  }
  return { widget, description: rest.trim() || null, advanced };
}

function walkObject(
  node: JsonSchemaNode,
  parentPath: readonly string[],
  root: JsonSchemaNode,
): { fields: FormField[] } {
  const required = new Set(node.required ?? []);
  const fields: FormField[] = [];
  for (const [key, raw] of Object.entries(node.properties ?? {})) {
    const child = flattenAnyOf(resolve(raw, root), root);
    const field = walkField(child, [...parentPath, key], required.has(key), root);
    if (field) fields.push(field);
  }
  return { fields };
}

function walkField(
  node: JsonSchemaNode,
  path: readonly string[],
  required: boolean,
  root: JsonSchemaNode,
): FormField | null {
  const dotPath = path.join('.');
  const last = path[path.length - 1] ?? '';
  const meta = parseDescription(node.description);
  const base: FormFieldBase = {
    path: dotPath,
    label: pickOverride(dotPath) ?? titleCase(last),
    widget: meta.widget,
    description: meta.description,
    advanced: meta.advanced,
    required,
    defaultValue: node.default,
  };

  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return {
      ...base,
      kind: 'enum',
      options: node.enum.map(String),
    };
  }

  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (type) {
    case 'string': {
      const out: FormField = { ...base, kind: 'string' };
      if (node.minLength !== undefined) out.minLength = node.minLength;
      if (node.maxLength !== undefined) out.maxLength = node.maxLength;
      if (node.pattern !== undefined) out.pattern = node.pattern;
      return out;
    }
    case 'integer':
    case 'number': {
      const out: FormField = { ...base, kind: 'number', integer: type === 'integer' };
      if (node.minimum !== undefined) out.minimum = node.minimum;
      if (node.maximum !== undefined) out.maximum = node.maximum;
      if (node.exclusiveMinimum !== undefined) out.exclusiveMinimum = node.exclusiveMinimum;
      if (node.exclusiveMaximum !== undefined) out.exclusiveMaximum = node.exclusiveMaximum;
      if (node.multipleOf !== undefined) out.step = node.multipleOf;
      return out;
    }
    case 'boolean':
      return { ...base, kind: 'boolean' };
    case 'object': {
      const { fields } = walkObject(node, path, root);
      return { ...base, kind: 'object', fields };
    }
    case 'array': {
      if (!node.items) return null;
      const itemNode = flattenAnyOf(resolve(node.items, root), root);
      const element = walkField(itemNode, [...path, '$item'], true, root);
      if (!element) return null;
      return { ...base, kind: 'array', element };
    }
    default:
      return null;
  }
}
