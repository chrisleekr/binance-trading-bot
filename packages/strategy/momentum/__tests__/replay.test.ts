import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import { replayFixture } from '@app/strategy-core/replay';

import { momentum } from '../src/index.js';

// Golden-fixture replay gate (quality gate #5). The committed fixture freezes
// momentum's decisions + nextState across a full flat -> entry -> hold -> exit
// cycle; `replayFixture` threads state through `momentum.tick` and diffs every
// tick against the frozen expectation. Any behavioural drift fails with diff > 0.
const FIXTURE = resolve(__dirname, '..', 'fixtures', 'replay', 'cross-cycle.jsonl');
// A second corpus with the profit trail ON. Deliberately separate: the
// cross-cycle config omits `profitTrail` entirely, so its unchanged diff = 0 is
// what proves the feature is inert by default — a claim one merged fixture
// could not make.
const PROFIT_FIXTURE = resolve(__dirname, '..', 'fixtures', 'replay', 'profit-trail.jsonl');

// The hard leg across every profit-trail tick: highSinceEntry 13 * (1 - 0.15).
// It never moves in that corpus, so anything above it came from the profit leg.
const HARD_LEG = new Decimal('11.05');

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

  it('replays the profit-trail fixture with diff = 0', async () => {
    const report = await replayFixture(momentum, PROFIT_FIXTURE);
    expect(report.diffs).toEqual([]);
    expect(report.invariantFailures).toEqual([]);
    expect(report.pass).toBe(true);
  });

  it('exercises the profit trail non-vacuously: it arms, re-prices, then fires', async () => {
    // Without this the corpus could freeze a run the feature never touched.
    const raw = await readFile(PROFIT_FIXTURE, 'utf8');
    const ticks = raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    const places = ticks.flatMap((t) =>
      t.expected.decisions.filter((d: { type: string }) => d.type === 'place-order'),
    );
    const arms = places.filter(
      (d: { intent: { reason: string } }) => d.intent.reason === 'protective-stop',
    );

    // Two placements at strictly rising triggers, both far above the hard leg.
    expect(arms.map((d: { params: { stopPrice: string } }) => d.params.stopPrice)).toEqual([
      '14.55',
      '15.52',
    ]);
    for (const d of arms) expect(new Decimal(d.params.stopPrice).gt(HARD_LEG)).toBe(true);

    // The first arm has nothing resting behind it and must never be sheddable;
    // the re-price does, so it must be.
    expect(arms.map((d: { intent: { deferrable?: boolean } }) => d.intent.deferrable)).toEqual([
      undefined,
      true,
    ]);

    const exits = ticks.filter((t) =>
      t.expected.metrics.some((m: { name: string }) => m.name === 'momentum.exit'),
    );
    expect(exits).toHaveLength(1);
    expect(exits[0].expected.metrics[0].tags.reason).toBe('trailing-stop');
    // The exit price is above the hard leg, so the pre-change strategy would
    // still have been holding here. That gap IS the feature.
    expect(new Decimal(exits[0].input.market.currentPrice).gt(HARD_LEG)).toBe(true);
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
