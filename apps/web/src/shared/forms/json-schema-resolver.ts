import { Validator, type OutputUnit } from '@cfworker/json-schema';
import { toNestErrors, validateFieldsNatively } from '@hookform/resolvers';
import type { FieldError, FieldValues, Resolver } from 'react-hook-form';

// cfworker restates a child failure at each ancestor via these structural
// keywords. Dropping them leaves one message per field instead of a
// parent+child pile-up on the same error.
const AGGREGATE_KEYWORDS = new Set([
  'properties',
  'additionalProperties',
  'patternProperties',
  'propertyNames',
  'items',
  'prefixItems',
  'contains',
  'dependentSchemas',
  'if',
  'then',
  'else',
  'not',
  'anyOf',
  'oneOf',
  'allOf',
  'false',
  'true',
]);

// cfworker throws on `undefined` (not a JSON type), which react-hook-form emits
// for unset fields; ajv tolerated it. Coerce to JSON semantics: drop undefined
// object props (treated as absent, so `required` still fires) and map undefined
// array holes to null (an indexed type error, index preserved) — matching ajv.
function toJsonSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : toJsonSafe(v)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = toJsonSafe(v);
    }
    return out;
  }
  return value;
}

/** JSON Pointer ("#/buy/amount") to a react-hook-form dotted path ("buy.amount"). */
function pointerToPath(pointer: string): string {
  const p = pointer.replace(/^#/, '');
  if (p === '' || p === '/') return '';
  return p
    .replace(/^\//, '')
    .split('/')
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.');
}

function toFieldErrors(units: readonly OutputUnit[]): Record<string, FieldError> {
  const errors: Record<string, FieldError> = {};
  for (const unit of units) {
    if (!unit.error || AGGREGATE_KEYWORDS.has(unit.keyword)) continue;
    let path = pointerToPath(unit.instanceLocation);
    // cfworker reports `required` against the parent object; bind it to the
    // missing field so the message lands on the empty control, matching ajv.
    if (unit.keyword === 'required') {
      const missing = /required property "([^"]+)"/.exec(unit.error)?.[1];
      if (missing) path = path ? `${path}.${missing}` : missing;
    }
    const key = path || 'root';
    // First failure per field wins (criteriaMode 'firstError' parity).
    if (!errors[key]) errors[key] = { type: unit.keyword || 'validation', message: unit.error };
  }
  return errors;
}

/**
 * react-hook-form resolver that validates against a draft-07 JSON Schema with an
 * interpreted validator. Drop-in for `ajvResolver`, whose runtime `new Function`
 * codegen is blocked by the app CSP (`script-src 'self'`, no `unsafe-eval`). The
 * strategy config schema arrives from the API at runtime, so build-time
 * precompilation is not an option. The server re-validates on submit, so this is
 * the client-side convenience pass only.
 */
export function jsonSchemaResolver<T extends FieldValues>(
  schema: Record<string, unknown>,
): Resolver<T> {
  const validator = new Validator(schema as ConstructorParameters<typeof Validator>[0], '7', false);
  return (values, _context, options) => {
    const result = validator.validate(toJsonSafe(values));
    if (options.shouldUseNativeValidation) {
      validateFieldsNatively({}, options);
    }
    if (result.valid) {
      return { values, errors: {} };
    }
    const fieldErrors = toFieldErrors(result.errors);
    // A failure whose units were all structural aggregates (e.g. a stray
    // additionalProperty) would map to nothing; keep the form blocked with a
    // root-level message rather than letting an invalid submit through.
    if (Object.keys(fieldErrors).length === 0) {
      fieldErrors['root'] = { type: 'validation', message: 'Invalid configuration.' };
    }
    return { values: {}, errors: toNestErrors(fieldErrors, options) };
  };
}
