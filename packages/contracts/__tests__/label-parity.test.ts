// Parity between the label a form RENDERS for a config path and the label
// anything else DERIVES for that same path.
//
// This is the test that decides whether a diagnosis is usable. Telling an
// operator "loosen Min 24h asset volume USD" when the form shows "Min 24h volume
// for the coin (USD)" sends them hunting for a field that does not exist — worse
// than printing the raw path, because it looks authoritative. Re-humanising the
// key by hand is exactly how that drift happens, so `labelForPath` is the single
// source and this asserts every real path agrees.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DiscoveryConfigSchema } from '../src/discovery.js';
import {
  buildFormFieldsFromJsonSchema,
  labelForPath,
  type FormField,
} from '../src/form-builder.js';

const fieldsOf = (schema: z.ZodType): FormField[] =>
  buildFormFieldsFromJsonSchema(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }));

/** Every field in the tree, nested groups and array elements included. */
const flatten = (fields: readonly FormField[]): FormField[] =>
  fields.flatMap((f) => {
    if (f.kind === 'object') return [f, ...flatten(f.fields)];
    if (f.kind === 'array') return [f, ...flatten([f.element])];
    return [f];
  });

describe('config label parity', () => {
  const all = flatten(fieldsOf(DiscoveryConfigSchema));

  it('covers the real discovery schema, not a hand-picked sample', () => {
    // A floor, so a schema that stopped producing fields cannot make the parity
    // assertion below vacuously true by iterating an empty list.
    expect(all.length).toBeGreaterThan(10);
  });

  it('labelForPath matches the rendered label for every discovery path', () => {
    const drifted = all
      .filter((f) => labelForPath(f.path) !== f.label)
      .map((f) => `${f.path}: rendered "${f.label}" vs derived "${labelForPath(f.path)}"`);
    expect(drifted).toEqual([]);
  });

  it.each([
    ['min24hAssetVolumeUsd', 'Min 24h volume for the coin (USD)'],
    ['min24hPairVolumeUsd', 'Min 24h volume on this market (USD)'],
    ['rankTopPercent', 'Consider top % of gainers'],
    ['maxSpreadRatio', 'Max bid/ask spread'],
    ['blacklist', 'Blocklist'],
  ])('%s renders as its override, not a humanised key', (path, expected) => {
    // Spelled out because these are the paths a discovery diagnosis actually
    // names. `titleCase` alone would yield "Min24h Asset Volume Usd" here.
    expect(labelForPath(path)).toBe(expected);
  });

  it('falls back to humanising the last segment when no override matches', () => {
    expect(labelForPath('trendConfirm.volMultiple')).toBe('Vol Multiple');
    expect(labelForPath('somethingNobodyOverrode')).toBe('Something Nobody Overrode');
  });

  it('resolves an override through a nested path, not just a bare key', () => {
    // Overrides match as a longest suffix, so a nested path must still find the
    // entry its leaf owns — otherwise deep-linked levers silently lose labels.
    expect(labelForPath('discovery.blacklist')).toBe('Blocklist');
  });
});
