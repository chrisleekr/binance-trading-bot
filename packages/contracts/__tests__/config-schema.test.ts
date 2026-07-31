import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toConfigJsonSchema } from '../src/config-schema.js';

describe('toConfigJsonSchema', () => {
  it('emits draft-07 and makes defaulted fields optional (io: input)', () => {
    const schema = z.object({
      required: z.string(),
      defaulted: z.number().default(3),
    });

    const json = toConfigJsonSchema(schema) as {
      $schema?: string;
      required?: string[];
      properties: Record<string, unknown>;
    };

    expect(json.$schema).toContain('draft-07');
    expect(Object.keys(json.properties)).toEqual(['required', 'defaulted']);
    // io: 'input' — a field with a zod default is optional in the schema.
    expect(json.required).toEqual(['required']);
  });

  it('degrades an unrepresentable cross-field refinement to a valid object schema', () => {
    const schema = z
      .object({ a: z.number(), b: z.number() })
      .refine((v) => v.a < v.b, 'a must be below b');

    // unrepresentable: 'any' drops the cross-field check but must still yield a
    // usable draft-07 object (a placeholder would break ajv / the form builder).
    const json = toConfigJsonSchema(schema) as {
      $schema?: string;
      type?: string;
      properties?: Record<string, unknown>;
    };
    expect(json.$schema).toContain('draft-07');
    expect(json.type).toBe('object');
    expect(Object.keys(json.properties ?? {})).toEqual(['a', 'b']);
  });
});
