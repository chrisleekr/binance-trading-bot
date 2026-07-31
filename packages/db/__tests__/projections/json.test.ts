import { describe, expect, it } from 'vitest';

import { tryParseJson } from '../../src/repo/projections/_json.js';

describe('tryParseJson', () => {
  it('parses valid JSON into the requested shape', () => {
    expect(tryParseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null for null or empty input', () => {
    expect(tryParseJson(null)).toBeNull();
    expect(tryParseJson('')).toBeNull();
  });

  it('returns null for malformed JSON instead of throwing', () => {
    expect(tryParseJson('not json')).toBeNull();
    expect(tryParseJson('{"a":')).toBeNull();
  });
});
