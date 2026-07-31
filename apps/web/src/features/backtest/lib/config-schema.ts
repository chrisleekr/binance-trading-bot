// Backtest config-form schema shaping.
//
// The backtest reuses the strategy's full config schema in an embedded
// AutoForm, but the symbol is chosen by a dedicated picker (the market under
// test), not typed as a free-text config field. Stripping `symbol` from the
// schema keeps a single source of truth and stops AutoForm rendering a second
// symbol input. The picked symbol is folded back into the submitted override.

/** A JSON Schema object node: `properties` map plus an optional `required` list. */
interface ObjectSchema {
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly [key: string]: unknown;
}

/**
 * Clone a JSON Schema with one top-level property removed from both
 * `properties` and `required`. Pure; the input is not mutated. A schema
 * without that property is returned unchanged in shape.
 */
export function omitSchemaProperty(
  schema: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const s = schema as ObjectSchema;
  const properties = Object.fromEntries(
    Object.entries(s.properties ?? {}).filter(([k]) => k !== key),
  );
  const out: Record<string, unknown> = { ...schema, properties };
  if (Array.isArray(s.required)) {
    out['required'] = s.required.filter((k) => k !== key);
  }
  return out;
}

/** Shallow copy of a config object with one key removed (pure). */
export function omitKey(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _removed, ...rest } = config;
  return rest;
}
