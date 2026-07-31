// Guards the guided config form: the schema's `@ui:advanced` tags and section
// intros must survive the round-trip through z.toJSONSchema into the web
// form-builder, so the auto-form lands as a few essential fields per section
// with the expert knobs folded into "Advanced". Pure metadata — no effect on
// parsed config values (the golden replay stays byte-identical).

import { buildFormFieldsFromJsonSchema, type FormField } from '@app/contracts';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { TTConfigSchema } from '../src/schema.js';

// The SPA renders from JSON Schema over the wire; convert exactly as the API
// registry does (`io: 'input'`) so this guards the real render path.
const buildFields = (schema: z.ZodType): FormField[] =>
  buildFormFieldsFromJsonSchema(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }));

/** Flatten the field tree to a path → field map, descending objects and object array rows. */
function flatten(
  fields: readonly FormField[],
  acc = new Map<string, FormField>(),
): Map<string, FormField> {
  for (const f of fields) {
    acc.set(f.path, f);
    if (f.kind === 'object') flatten(f.fields, acc);
    if (f.kind === 'array' && f.element.kind === 'object') flatten(f.element.fields, acc);
  }
  return acc;
}

describe('TT config-form tiering', () => {
  const byPath = flatten(buildFields(TTConfigSchema));
  const tier = (path: string): boolean | undefined => byPath.get(path)?.advanced;

  it('keeps the everyday knobs visible (not advanced)', () => {
    for (const path of [
      'candleInterval',
      'buy',
      'sell',
      'buy.enabled',
      'buy.entrySizing',
      'buy.gridLevels',
      'sell.enabled',
      'sell.stopLossPercentage',
      'sell.triggerPercentage',
      'sell.trailingStopPercentage',
    ]) {
      expect(tier(path), path).toBe(false);
    }
  });

  it('folds the expert knobs into Advanced', () => {
    for (const path of [
      'regime',
      'technicals',
      'fees',
      'execution',
      'forceBuyOverride',
      'buy.indicatorGate',
      'buy.meanReversionGate',
      'buy.autoTriggerBuy',
      'buy.maxSymbolExposureQuote',
      'buy.maxPositionLossQuote',
      'buy.accountCap',
      'buy.avgEntryPriceRemoveThreshold',
      'buy.gridRepriceMinDriftPercent',
      'buy.lossCooldownMinutes',
      'sell.atrTrailing',
      'sell.protectiveStop',
      'sell.breakEven',
      'sell.timeStopBars',
      'sell.forceSellMinProfitPercent',
    ]) {
      expect(tier(path), path).toBe(true);
    }
  });

  it('gives the Buy and Sell sections a plain-language intro', () => {
    expect(byPath.get('buy')?.description).toMatch(/buy/i);
    expect(byPath.get('sell')?.description).toMatch(/stop-loss|trailing/i);
  });

  it('keeps a widget hint intact on a field that is also advanced', () => {
    // `@ui:advanced @ui:price …` must still resolve the price widget.
    expect(byPath.get('buy.maxSymbolExposureQuote')?.widget).toBe('price');
    expect(byPath.get('buy.accountCap')?.widget).toBe('amount-or-percent');
  });
});
