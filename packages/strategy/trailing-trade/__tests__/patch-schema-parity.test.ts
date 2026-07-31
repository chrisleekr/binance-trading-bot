// Drift guard for the per-symbol override patch schemas. The nested patch
// schemas (technicals, regime) are hand-written WITHOUT field defaults so an
// override carries only the keys the operator changed; the full schemas carry
// `.default(...)` on every field. The two must stay key-for-key in sync at every
// nesting level: a key added to a full schema but forgotten in its patch is
// silently stripped on parse (the patch objects use default zod stripping), so
// the operator's override quietly does not take. This test fails loudly on that
// drift instead — recursively, so a forgotten nested key is caught too.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  TTConfigSchema,
  TTOverrideConfigSchema,
  TTRegimeSchema,
  TTRegimePatchSchema,
} from '../src/schema.js';

// Peel ZodDefault / ZodOptional / ZodNullable wrappers (each exposes
// `def.innerType`) down to the underlying type.
const unwrap = (schema: z.ZodType): z.ZodType => {
  let cur = schema as unknown as { def?: { innerType?: z.ZodType } };
  while (cur?.def?.innerType) cur = cur.def.innerType as unknown as typeof cur;
  return cur as unknown as z.ZodType;
};

// The field map of a Zod object, or null for a leaf (number/string/enum/array).
const shapeOf = (schema: z.ZodType): Record<string, z.ZodType> | null => {
  const unwrapped = unwrap(schema) as unknown as { shape?: Record<string, z.ZodType> };
  return unwrapped?.shape ?? null;
};

// Assert the patch's key set equals the full schema's, recursively into nested
// objects. A leaf on the full side ends that branch (the field's own validators
// are not compared — only the key set, which is what a forgotten knob breaks).
const assertSameKeys = (full: z.ZodType, patch: z.ZodType, path: string): void => {
  const fullShape = shapeOf(full);
  if (fullShape === null) return;
  const patchShape = shapeOf(patch);
  expect(patchShape, `${path} should be an object on the patch side`).not.toBeNull();
  const patchFields = patchShape as Record<string, z.ZodType>;
  expect(new Set(Object.keys(patchFields)), `${path} key drift`).toEqual(
    new Set(Object.keys(fullShape)),
  );
  for (const [key, fullField] of Object.entries(fullShape)) {
    const patchField = patchFields[key];
    // Unreachable once the key-set assertion above holds; the guard keeps the
    // recursion type-safe without a non-null assertion.
    if (!patchField) continue;
    assertSameKeys(fullField, patchField, `${path}.${key}`);
  }
};

describe('per-symbol patch schemas track their full schemas key-for-key', () => {
  it('regime patch matches the full regime schema at every nesting level', () => {
    assertSameKeys(TTRegimeSchema, TTRegimePatchSchema, 'regime');
  });

  it('technicals patch matches the full technicals config at every nesting level', () => {
    assertSameKeys(
      TTConfigSchema.shape.technicals,
      TTOverrideConfigSchema.shape.technicals,
      'technicals',
    );
  });
});
