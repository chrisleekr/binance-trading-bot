// Deterministic generator + self-check for the trailing-trade frame-replay
// fixture tuple committed to sample.jsonl.
//
// This builds the TT tuple INPUTS, runs the REAL strategy.tick through the same
// replay harness the gate uses, serialises the resulting tuple with the REAL
// createJsonlFrameRecorder to a tmpdir file, reads the line back, and asserts:
//   (a) the decision is a single place-order SELL with intent.reason
//       'grid-stop-loss' driven strictly by the livePrice override, and
//   (b) the regenerated tuple replays with zero decision drift.
// It also pins the regenerated decisions to the committed sample.jsonl tuple as
// a golden drift-guard: a future strategy change that alters this decision fails
// CI loudly here, prompting a regenerate-and-review. The trace is written ONLY
// to tmpdir, never into the repo tree.
//
// Regenerate with: bun --filter @app/worker test:frame-replay:generate

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildStrategyRegistry } from '@app/strategy-registry';
import { TTConfigSchema } from '@app/strategy-trailing-trade';

import { createJsonlFrameRecorder, type FrameTuple } from '../../src/tick/frame-recorder.js';
import { replayTuple } from './_frame-replay-harness.js';

const registry = buildStrategyRegistry();
const strategy = registry.get('trailing-trade');
if (!strategy) throw new Error('trailing-trade not registered');

// Reuse the exact UUIDs the existing momentum tuples use so every tuple in
// sample.jsonl is one logical profile (the fake Redis keys collide harmlessly;
// each tuple is replayed independently).
const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE_ID = '22222222-2222-4222-8222-222222222222';
const SYMBOL = 'BTCUSDT';

// Fully-parse the config so the strategy reads concrete, fully-defaulted values
// at tick time (the worker passes profile.config straight to the strategy).
const parsedConfig = TTConfigSchema.parse({
  symbol: SYMBOL,
  candleInterval: '1h',
  buy: {
    enabled: true,
    entrySizing: { mode: 'fixed', amount: '50' },
    avgEntryPriceRemoveThreshold: '0',
  },
  sell: {
    enabled: true,
    stopLossPercentage: '0.97',
    triggerPercentage: '1.05',
    trailingStopPercentage: '0.98',
  },
});

// Revive the full default state via the strategy's own initialState (parsed
// through its state schema, so every defaulted field is present on the wire and
// no omission drift creeps in) then override only the held position fields. Cast
// to a record because the registry strategy is typed over `unknown` state.
const state = {
  ...(strategy.initialState(parsedConfig) as Record<string, unknown>),
  avgEntryPrice: '50000.00',
  heldQuantity: '1',
};

// Stop-loss fires when currentPrice <= avgEntryPrice * stopLossPercentage =
// 50000 * 0.97 = 48500. The closed candles are flat at 50000, so currentPrice
// only crosses the stop via the livePrice override -> the decision is strictly
// livePrice-driven.
const ttTuple: FrameTuple = {
  raw: {
    state: JSON.stringify(state),
    accountInfo: JSON.stringify({
      balances: { BTC: { free: '1', locked: '0' }, USDT: { free: '1000', locked: '0' } },
    }),
    openOrders: '[]',
    killSwitch: null,
    symbolDisable: null,
    weightUsed1m: 10,
    orderRearm: null,
    orderRefusal: null,
    indicatorsByInterval: { '1h': null },
  },
  livePrice: '47000.00',
  trigger: { kind: 'tick' },
  intervals: ['1h'],
  profile: {
    userId: USER_ID,
    profileId: PROFILE_ID,
    symbol: SYMBOL,
    strategyName: 'trailing-trade',
    strategyVersion: '2.0.0',
    candleInterval: '1h',
    binanceMode: 'test',
    quoteAsset: 'USDT',
    weightLimit1m: 1200,
    needsAccountDeployedQuote: false,
    reserveBaseQuantity: null,
    config: parsedConfig,
  },
  decisions: [],
};

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

describe('trailing-trade frame-replay fixture generator', () => {
  it('the recorded strategy version matches the live plugin', () => {
    // Guards against a strategy version bump silently desyncing the tuple.
    expect(ttTuple.profile.strategyVersion).toBe(strategy.version);
  });

  it('records a single livePrice-driven grid-stop-loss place-order, drift-free', async () => {
    // Compute the REAL decisions, then write the completed tuple through the REAL
    // recorder so the on-wire serialisation is exercised, and read it back.
    const { output } = await replayTuple(registry, ttTuple);
    const recorded: FrameTuple = { ...ttTuple, decisions: output.decisions };

    const file = join(mkdtempSync(join(tmpdir(), 'frame-gen-')), 'trace.jsonl');
    createJsonlFrameRecorder(file).record(recorded);
    const [line, ...rest] = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(rest).toHaveLength(0);
    const reread = JSON.parse(line ?? '') as FrameTuple;

    // (a) Exactly one place-order, a SELL, reason grid-stop-loss.
    expect(reread.decisions).toHaveLength(1);
    const decision = reread.decisions[0];
    expect(decision?.type).toBe('place-order');
    if (decision?.type !== 'place-order') throw new Error('expected place-order');
    expect(decision.intent.side).toBe('SELL');
    expect(decision.intent.reason).toBe('grid-stop-loss');
    expect(decision.params.type).toBe('MARKET');

    // (b) The regenerated tuple replays drift-free, and crosses the stop ONLY via
    // the livePrice override (the closed candle is flat at 50000 = no stop).
    const replayed = await replayTuple(registry, reread);
    expect(replayed.built.input.market.currentPrice).toBe('47000.00');
    expect(replayed.output.decisions).toEqual(reread.decisions);
  });

  it('matches the committed sample.jsonl TT tuple (golden drift-guard)', async () => {
    const { output } = await replayTuple(registry, ttTuple);
    const committed = loadTuples().find((t) => t.profile.strategyName === 'trailing-trade');
    expect(committed, 'sample.jsonl must carry a trailing-trade tuple').toBeDefined();
    // A strategy change that alters this decision fails here: regenerate via
    // test:frame-replay:generate, review the new decision, and recommit the line.
    expect(committed?.decisions).toEqual(output.decisions);
  });
});
