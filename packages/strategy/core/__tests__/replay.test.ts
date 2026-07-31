import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { replayFixture, FIXTURE_SCHEMA_VERSION } from '../src/replay.js';
import type { FixtureLine } from '../src/replay.js';
import { IssueCode } from '../src/contract.js';
import type { Strategy, TickInput, TickOutput } from '../src/contract.js';

interface CounterState {
  readonly counter: number;
}
type CounterStrategy = Strategy<unknown, CounterState, Readonly<Record<string, unknown>>>;
type CounterInput = TickInput<unknown, CounterState, Readonly<Record<string, unknown>>>;
type CounterOutput = TickOutput<CounterState>;

const baseStrategy: CounterStrategy = {
  name: 'counter',
  version: '1.0.0',
  displayName: 'Counter',
  description: 'deterministic counter',
  capabilities: {
    candleIntervals: [],
    needsUserDataStream: false,
    needsMiniTicker: false,
    bundleProviders: [],
    operatorActions: [],
  },
  configSchema: z.unknown(),
  stateSchema: z.object({ counter: z.number() }),
  bundleSchema: z.record(z.string(), z.unknown()),
  events: {},
  initialState: () => ({ counter: 0 }),
  tick: (input) => ({
    nextState: { counter: input.state.counter + 1 },
    decisions: [],
    logs: [],
    metrics: [],
  }),
};

const makeInput = (counter: number): CounterInput => ({
  clock: { nowMs: () => 0 },
  rng: { next: () => 0 },
  trigger: { kind: 'tick' },
  profile: {
    id: 'p1',
    userId: 'u1',
    binanceMode: 'test',
    status: 'running',
    strategyVersion: '1.0.0',
  },
  config: {},
  state: { counter },
  market: {
    symbol: 'BTCUSDT',
    currentPrice: '0',
    candlesByInterval: {},
    symbolInfo: {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      status: 'TRADING',
      filters: {
        minNotional: '0',
        tickSize: '0.01',
        stepSize: '0.0001',
        minQty: '0',
        maxQty: '0',
        minPrice: '0',
        maxPrice: '0',
      },
    },
  },
  account: { balances: {} },
  openOrders: [],
  bundle: {},
  limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
});

const makeFixturePath = (
  lines: readonly FixtureLine<unknown, CounterState, Readonly<Record<string, unknown>>>[],
): string => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-'));
  const path = join(dir, 'fixture.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  return path;
};

describe('replayFixture', () => {
  it('passes when expected matches actual across multiple ticks (state threaded)', async () => {
    const expectations: CounterOutput[] = [
      { nextState: { counter: 1 }, decisions: [], logs: [], metrics: [] },
      { nextState: { counter: 2 }, decisions: [], logs: [], metrics: [] },
      { nextState: { counter: 3 }, decisions: [], logs: [], metrics: [] },
    ];
    const lines = expectations.map((expected, i) => ({
      tick: i,
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      input: makeInput(0),
      expected,
    }));
    const path = makeFixturePath(lines);
    const report = await replayFixture(baseStrategy, path);
    rmSync(path, { force: true });
    expect(report.pass).toBe(true);
    expect(report.diffs).toEqual([]);
    expect(report.invariantFailures).toEqual([]);
  });

  it('produces ReplayDiff with path when output diverges', async () => {
    const path = makeFixturePath([
      {
        tick: 0,
        schemaVersion: FIXTURE_SCHEMA_VERSION,
        input: makeInput(0),
        expected: { nextState: { counter: 99 }, decisions: [], logs: [], metrics: [] },
      },
    ]);
    const report = await replayFixture(baseStrategy, path);
    rmSync(path, { force: true });
    expect(report.pass).toBe(false);
    expect(
      report.diffs.some(
        (d) => d.path === 'nextState.counter' && d.expected === 99 && d.actual === 1,
      ),
    ).toBe(true);
  });

  it('diffs array elements positionally when decision lists differ in length', async () => {
    // A strategy that emits one decision, replayed against an empty expected
    // decisions array, exercises the per-element array diff path.
    const emitting: CounterStrategy = {
      ...baseStrategy,
      tick: (input) => ({
        nextState: { counter: input.state.counter + 1 },
        decisions: [{ type: 'noop' }],
        logs: [],
        metrics: [],
      }),
    };
    const path = makeFixturePath([
      {
        tick: 0,
        schemaVersion: FIXTURE_SCHEMA_VERSION,
        input: makeInput(0),
        expected: { nextState: { counter: 1 }, decisions: [], logs: [], metrics: [] },
      },
    ]);
    const report = await replayFixture(emitting, path);
    rmSync(path, { force: true });
    expect(report.pass).toBe(false);
    expect(report.diffs.some((d) => d.path === 'decisions[0]')).toBe(true);
  });

  it('revives account.balances decimal-strings into Decimals before the tick', async () => {
    // A tick that reads balances as Decimals; if the harness left them strings,
    // `.plus` would throw. Covers: valid strings, a malformed string degrading
    // to zero, an asset entry missing its `asset`/`locked` fields.
    interface Bal {
      readonly free: { plus(o: unknown): { toNumber(): number } };
      readonly locked: unknown;
    }
    const balanceReader: CounterStrategy = {
      ...baseStrategy,
      tick: (input) => {
        const b = input.account.balances as unknown as Record<string, Bal>;
        const sum =
          b.USDT.free.plus(b.USDT.locked).toNumber() + // 100 + 5
          (b.EUR.free as unknown as { toNumber(): number }).toNumber() + // 2
          (b.BAD.free as unknown as { toNumber(): number }).toNumber(); // Infinity -> 0
        return { nextState: { counter: sum }, decisions: [], logs: [], metrics: [] };
      },
    };
    const input = {
      ...makeInput(0),
      account: {
        balances: {
          USDT: { asset: 'USDT', free: '100', locked: '5' },
          EUR: { free: '2' }, // no `asset`, no `locked` -> name fallback + zero
          BAD: { asset: 'BAD', free: 'Infinity', locked: '0' }, // malformed -> zero
        },
      },
    } as unknown as CounterInput;
    const path = makeFixturePath([
      {
        tick: 0,
        schemaVersion: FIXTURE_SCHEMA_VERSION,
        input,
        expected: { nextState: { counter: 107 }, decisions: [], logs: [], metrics: [] },
      },
    ]);
    const report = await replayFixture(balanceReader, path);
    rmSync(path, { force: true });
    expect(report.pass).toBe(true);
    expect(report.diffs).toEqual([]);
  });

  it('rejects mismatched schemaVersion loudly', async () => {
    const path = makeFixturePath([
      {
        tick: 0,
        schemaVersion: 99 as unknown as typeof FIXTURE_SCHEMA_VERSION,
        input: makeInput(0),
        expected: { nextState: { counter: 1 }, decisions: [], logs: [], metrics: [] },
      },
    ]);
    await expect(replayFixture(baseStrategy, path)).rejects.toThrow(/schemaVersion mismatch/);
    rmSync(path, { force: true });
  });

  it('runs the tick when validateInvariants reports only non-error issues', async () => {
    // Warning-severity issues do not gate the tick; the replay proceeds and
    // the (matching) output produces no diffs.
    const warnOnly: CounterStrategy = {
      ...baseStrategy,
      validateInvariants: () => [
        { severity: 'warning', code: IssueCode.InvariantViolated, message: 'soft' },
      ],
    };
    const path = makeFixturePath([
      {
        tick: 0,
        schemaVersion: FIXTURE_SCHEMA_VERSION,
        input: makeInput(0),
        expected: { nextState: { counter: 1 }, decisions: [], logs: [], metrics: [] },
      },
    ]);
    const report = await replayFixture(warnOnly, path);
    rmSync(path, { force: true });
    expect(report.pass).toBe(true);
    expect(report.invariantFailures).toEqual([]);
  });

  it('records error-severity invariant failures and skips the tick', async () => {
    const strict: CounterStrategy = {
      ...baseStrategy,
      validateInvariants: () => [
        { severity: 'error', code: IssueCode.InvariantViolated, message: 'stop' },
      ],
    };
    const path = makeFixturePath([
      {
        tick: 0,
        schemaVersion: FIXTURE_SCHEMA_VERSION,
        input: makeInput(0),
        expected: { nextState: { counter: 1 }, decisions: [], logs: [], metrics: [] },
      },
    ]);
    const report = await replayFixture(strict, path);
    rmSync(path, { force: true });
    expect(report.pass).toBe(false);
    expect(report.invariantFailures).toHaveLength(1);
  });
});
