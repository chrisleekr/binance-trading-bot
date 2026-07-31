import { describe, expect, it } from 'vitest';
import { DEFAULT_CANDLE_WINDOW, MAX_CANDLE_WINDOW, resolveCandleWindow } from '../src/window.js';

describe('resolveCandleWindow', () => {
  it('floors a small or absent need at the default window', () => {
    expect(resolveCandleWindow(undefined)).toBe(DEFAULT_CANDLE_WINDOW);
    expect(resolveCandleWindow(0)).toBe(DEFAULT_CANDLE_WINDOW);
    expect(resolveCandleWindow(50)).toBe(DEFAULT_CANDLE_WINDOW);
    expect(resolveCandleWindow(DEFAULT_CANDLE_WINDOW)).toBe(DEFAULT_CANDLE_WINDOW);
  });

  it('passes a mid-range need through unchanged', () => {
    expect(resolveCandleWindow(350)).toBe(350);
  });

  it('caps an oversized need at the ceiling', () => {
    expect(resolveCandleWindow(5000)).toBe(MAX_CANDLE_WINDOW);
  });

  it('collapses a non-finite need to the default', () => {
    expect(resolveCandleWindow(Number.NaN)).toBe(DEFAULT_CANDLE_WINDOW);
  });
});
