// Worker frame record->replay correctness gate.
//
// Loads the committed frame-trace fixture and, for each recorded tuple, drives
// the REAL snapshot-loader (readRawSnapshot) over a fake in-memory Redis whose
// pipeline returns the recorded blobs in key order, then the REAL buildTickInput
// + the REAL strategy.tick (resolved from the registry by the recorded
// strategyName), and asserts the strategy's decisions deepEqual the recorded
// decisions — drift = 0. Runs without Postgres or testcontainers: every
// boundary (StatePort, coldLoad, marketDataPort, symbolInfoCache, bundle) is a
// deterministic in-memory stub seeded from the tuple, shared with the fixture
// generator via the harness so record-time inputs == replay-time inputs.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildStrategyRegistry } from '@app/strategy-registry';

import type { FrameTuple } from '../../src/tick/frame-recorder.js';
import { replayTuple } from './_frame-replay-harness.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'frame-replay',
  'sample.jsonl',
);

const loadTuples = (): FrameTuple[] =>
  readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FrameTuple);

describe('worker frame record->replay gate', () => {
  const registry = buildStrategyRegistry();
  const tuples = loadTuples();

  it('replays at least two tuples including a live-price frame', () => {
    expect(tuples.length).toBeGreaterThanOrEqual(2);
    expect(
      tuples.some(
        (t) =>
          t.trigger.kind === 'tick' &&
          typeof t.livePrice === 'string' &&
          Number.parseFloat(t.livePrice) > 0,
      ),
    ).toBe(true);
  });

  it('replays at least one non-noop decision tuple', () => {
    expect(tuples.some((t) => t.decisions.some((d) => d.type !== 'noop'))).toBe(true);
  });

  it.each(tuples.map((t, i) => [i, t] as const))(
    'tuple %i replays with zero decision drift',
    async (_i, tuple) => {
      const { built, output } = await replayTuple(registry, tuple);

      // The live-price frame must override currentPrice with the recorded
      // mini-ticker close, not the closed-candle close. Asserted directly at the
      // assembler boundary because a momentum tuple that decides on closed-candle
      // EMA cross alone would not surface a broken override in the drift check.
      if (typeof tuple.livePrice === 'string') {
        expect(built.input.market.currentPrice).toBe(tuple.livePrice);
      }

      // Decision-drift = 0 for the assembled-input -> tick path.
      expect(output.decisions).toEqual(tuple.decisions);
    },
  );
});
