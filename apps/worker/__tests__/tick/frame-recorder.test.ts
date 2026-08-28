// FrameRecorder unit tests: env-gated factory + JSONL sink behaviour.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Decision, TriggerEvent } from '@app/strategy-core';
import {
  createFrameRecorderFromEnv,
  createJsonlFrameRecorder,
  type FrameTuple,
} from '../../src/tick/frame-recorder.js';

const tuple = (over: Partial<FrameTuple> = {}): FrameTuple => ({
  raw: {
    state: null,
    accountInfo: null,
    openOrders: null,
    killSwitch: null,
    symbolDisable: null,
    weightUsed1m: 0,
    orderRearm: null,
    orderRefusal: null,
    indicatorsByInterval: {},
  },
  livePrice: undefined,
  trigger: { kind: 'tick' } as TriggerEvent,
  intervals: ['1h'],
  profile: {
    userId: 'u',
    profileId: 'p',
    symbol: 'BTCUSDT',
    strategyName: 'momentum',
    strategyVersion: '1.0.0',
    candleInterval: '1h',
    binanceMode: 'test',
    quoteAsset: 'USDT',
    weightLimit1m: 1200,
    needsAccountDeployedQuote: false,
    config: {},
  },
  decisions: [{ type: 'noop' }] as readonly Decision[],
  ...over,
});

describe('createFrameRecorderFromEnv', () => {
  it('returns undefined unless WORKER_FRAME_TRACE=1', () => {
    expect(createFrameRecorderFromEnv({})).toBeUndefined();
    expect(createFrameRecorderFromEnv({ WORKER_FRAME_TRACE: '0' })).toBeUndefined();
    expect(createFrameRecorderFromEnv({ WORKER_FRAME_TRACE: 'true' })).toBeUndefined();
  });

  it('returns a recorder when WORKER_FRAME_TRACE=1', () => {
    const rec = createFrameRecorderFromEnv({
      WORKER_FRAME_TRACE: '1',
      WORKER_FRAME_TRACE_FILE: '',
    });
    expect(rec).toBeDefined();
  });

  it('defaults the trace file under the OS temp dir, never inside the repo', () => {
    // A default trace must never land in the repo tree (it holds account
    // balances/holdings). The default path is deterministic, so recompute it,
    // drive one record, and assert the file materialised exactly there.
    const expected = join(tmpdir(), 'worker-frame-trace.jsonl');
    rmSync(expected, { force: true });
    try {
      expect(expected).toContain(tmpdir());
      expect(expected.endsWith('worker-frame-trace.jsonl')).toBe(true);
      const rec = createFrameRecorderFromEnv({ WORKER_FRAME_TRACE: '1' });
      rec?.record(tuple());
      expect(existsSync(expected)).toBe(true);
    } finally {
      rmSync(expected, { force: true });
    }
  });
});

describe('createJsonlFrameRecorder', () => {
  const dirs: string[] = [];
  const makeDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'frame-trace-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('appends one JSONL line per record', () => {
    const file = join(makeDir(), 'trace.jsonl');
    const rec = createJsonlFrameRecorder(file);
    rec.record(tuple({ livePrice: '1' }));
    rec.record(tuple({ livePrice: '2' }));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as FrameTuple);
    expect(parsed.map((t) => t.livePrice)).toEqual(['1', '2']);
  });

  it('routes an append failure to onError and never throws into the tick path', () => {
    // A directory path that does not exist forces appendFileSync to throw.
    const onError = vi.fn();
    const rec = createJsonlFrameRecorder('/nonexistent-dir-xyz/trace.jsonl', onError);
    expect(() => rec.record(tuple())).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('swallows an append failure with no onError handler', () => {
    const rec = createJsonlFrameRecorder('/nonexistent-dir-xyz/trace.jsonl');
    expect(() => rec.record(tuple())).not.toThrow();
  });
});
