import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { replayFixture } from '@app/strategy-core/replay';

import { momentum } from '../src/index.js';

// Golden-fixture replay gate (quality gate #5). The committed fixture freezes
// momentum's decisions + nextState across a full flat -> entry -> hold -> exit
// cycle; `replayFixture` threads state through `momentum.tick` and diffs every
// tick against the frozen expectation. Any behavioural drift fails with diff > 0.
const FIXTURE = resolve(__dirname, '..', 'fixtures', 'replay', 'cross-cycle.jsonl');

describe('momentum — golden-fixture replay', () => {
  it('replays the cross-cycle fixture with diff = 0', async () => {
    const report = await replayFixture(momentum, FIXTURE);
    expect(report.diffs).toEqual([]);
    expect(report.invariantFailures).toEqual([]);
    expect(report.pass).toBe(true);
  });

  // Structural guard on the retry-model invariant the worker's `applyAll`
  // enforces by throwing: a single tick must emit at most one place-order, else
  // a failed apply's re-emit (the un-advanced state) would re-place an order
  // that already landed. Counting placements per tick over the real replay
  // corpus is non-vacuous even if the fixture is regenerated — it is a count,
  // not a snapshot. A wrapper records each tick's raw decisions; `replayFixture`
  // threads state through it exactly as it does the bare strategy.
  it('never emits more than one place-order in a single tick', async () => {
    const placementsPerTick: number[] = [];
    const recording: typeof momentum = {
      ...momentum,
      tick: (input) => {
        const out = momentum.tick(input);
        placementsPerTick.push(out.decisions.filter((d) => d.type === 'place-order').length);
        return out;
      },
    };
    await replayFixture(recording, FIXTURE);
    // The corpus must have driven real ticks, or the assertions below are empty.
    expect(placementsPerTick.length).toBeGreaterThan(0);
    expect(placementsPerTick.some((n) => n > 0)).toBe(true);
    expect(Math.max(...placementsPerTick)).toBeLessThanOrEqual(1);
  });

  it('exercises a non-trivial scenario (entry and exit are both present)', async () => {
    const raw = await readFile(FIXTURE, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const reasons = lines
      .flatMap((l) => JSON.parse(l).expected.decisions)
      .filter((d) => d.type === 'place-order')
      .map((d) => d.intent.reason);
    expect(reasons).toContain('entry');
    expect(reasons).toContain('exit');
  });
});
