import { z } from 'zod';

/**
 * Serialise a zod config schema to the exact draft-07 JSON Schema shape the
 * config forms render from. Single source of the conversion options so the
 * api registry, the notifier contract, the web config panels, and the docs
 * config-table generator can never drift apart.
 *
 * - `target: 'draft-07'` — the browser ajv validator accepts it without the
 *   2020-12 build.
 * - `unrepresentable: 'any'` — cross-field refinements degrade to `{}` rather
 *   than throwing.
 * - `io: 'input'` — a field with a zod `.default()` is optional in `required`;
 *   the config form is an input surface. Input mode also drops
 *   `additionalProperties: false`; the server re-validates against the live
 *   zod schema on save, so an unknown key is still rejected.
 */
export const toConfigJsonSchema = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema, {
    target: 'draft-07',
    unrepresentable: 'any',
    io: 'input',
  }) as Record<string, unknown>;
