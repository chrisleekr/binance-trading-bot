import { describe, expect, it } from 'vitest';
import { KlineParseError, parseKlines, type ParsedKline } from '../src/index.js';

// A well-formed raw wire tuple: [openTime, open, high, low, close, volume, closeTime].
const wire = (openTime: number, closeTime: number): unknown => [
  openTime,
  '100.5',
  '110',
  '90',
  '105',
  '1.25',
  closeTime,
];

describe('parseKlines', () => {
  it('decodes a wire tuple into a named, decimal-string ParsedKline', () => {
    const [k] = parseKlines([wire(1_000, 1_999)]);
    expect(k).toEqual<ParsedKline>({
      openTimeMs: 1_000,
      closeTimeMs: 1_999,
      open: '100.5',
      high: '110',
      low: '90',
      close: '105',
      volume: '1.25',
    });
  });

  it('returns an empty array for an empty response (no throw)', () => {
    expect(parseKlines([])).toEqual([]);
  });

  it('ignores trailing slots beyond the seventh', () => {
    const row = [1_000, '1', '2', '0.5', '1.5', '3', 1_999, 'quoteVol', 7, '0', '0', '0'];
    expect(parseKlines([row])).toHaveLength(1);
  });

  it('throws KlineParseError when the response is not an array', () => {
    expect(() => parseKlines({ not: 'an array' })).toThrow(KlineParseError);
  });

  it('throws KlineParseError on a tuple shorter than 7', () => {
    expect(() => parseKlines([[1_000, '1', '2', '0.5', '1.5', '3']])).toThrow(KlineParseError);
  });

  it('throws when openTime is not a finite number (e.g. a string)', () => {
    expect(() => parseKlines([['1000', '1', '2', '0.5', '1.5', '3', 1_999]])).toThrow(
      KlineParseError,
    );
  });

  it('throws when closeTime is not a finite number', () => {
    expect(() => parseKlines([[1_000, '1', '2', '0.5', '1.5', '3', 'not-a-number']])).toThrow(
      KlineParseError,
    );
  });

  it('throws when a money slot is not a decimal-string', () => {
    // A number where a decimal-string is expected — the silent-drift this guards:
    // a reordered wire putting a timestamp/number in the open slot.
    expect(() => parseKlines([[1_000, 100.5, '2', '0.5', '1.5', '3', 1_999]])).toThrow(
      KlineParseError,
    );
    // A non-numeric string.
    expect(() => parseKlines([[1_000, 'abc', '2', '0.5', '1.5', '3', 1_999]])).toThrow(
      KlineParseError,
    );
  });

  it('throws when openTime is after closeTime (column swap)', () => {
    expect(() => parseKlines([wire(2_000, 1_000)])).toThrow(KlineParseError);
  });

  it('reports the offending row index in the error message', () => {
    expect(() =>
      parseKlines([wire(0, 1), [1, '1', '2', '0.5', '1.5', '3' /* missing closeTime */]]),
    ) //
      .toThrow(/kline\[1\]/);
  });
});
