import { describe, expect, it } from 'vitest';

import { bucketize } from '../../src/crons/technicals-compute.js';

describe('bucketize', () => {
  it.each([
    [-1, 'STRONG_SELL'],
    [-0.500001, 'STRONG_SELL'],
    [-0.5, 'SELL'],
    [-0.100001, 'SELL'],
    [-0.1, 'NEUTRAL'],
    [0, 'NEUTRAL'],
    [0.1, 'NEUTRAL'],
    [0.100001, 'BUY'],
    [0.5, 'BUY'],
    [0.500001, 'STRONG_BUY'],
    [1, 'STRONG_BUY'],
  ] as const)('maps %s to %s', (score, expected) => {
    expect(bucketize(score)).toBe(expected);
  });
});
