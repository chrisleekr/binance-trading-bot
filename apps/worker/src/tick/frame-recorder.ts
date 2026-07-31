// Worker frame-trace recorder.
//
// Captures one record-line per tick so a recorded production frame can be
// replayed offline through the REAL buildTickInput + strategy.tick and asserted
// drift-free (the worker frame-replay correctness gate). The recorder is wired
// only when WORKER_FRAME_TRACE=1; the factory returns undefined otherwise so the
// hot path pays a single `if` guard and nothing else when tracing is off.
//
// What a tuple holds is exactly what the replay test needs to reconstruct the
// tick: the verbatim Redis blobs (already JSON strings from snapshot-loader),
// the live-price override, the trigger, the serialisable profile context the
// assembler reads, and the strategy's emitted decisions. The raw blobs are
// appended verbatim — they are JSON strings on the wire, so re-serialising would
// only risk drift.

import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Decision, TriggerEvent } from '@app/strategy-core';
import type { RawSnapshot } from './snapshot-loader.js';

/**
 * The serialisable slice of the profile context a replay needs. Mirrors the
 * fields {@link buildTickInput} and the strategy read off `ProfileTickContext`,
 * minus the non-serialisable handles (the proven `scope` and the
 * `bundleProvider` closure) which the replay test rebuilds as stubs.
 */
export interface RecordedProfile {
  readonly userId: string;
  readonly profileId: string;
  readonly symbol: string;
  readonly strategyName: string;
  readonly strategyVersion: string;
  readonly candleInterval: string;
  readonly binanceMode: 'test' | 'live';
  readonly quoteAsset: string;
  readonly weightLimit1m: number;
  readonly needsAccountDeployedQuote: boolean;
  readonly reserveBaseQuantity: string | null;
  readonly config: unknown;
}

/** One recorded tick: enough to replay buildTickInput + strategy.tick offline. */
export interface FrameTuple {
  readonly raw: RawSnapshot;
  readonly livePrice: string | undefined;
  readonly trigger: TriggerEvent;
  readonly intervals: readonly string[];
  readonly profile: RecordedProfile;
  readonly decisions: readonly Decision[];
}

export interface FrameRecorder {
  /** Append one tick's frame tuple as a single JSONL line. */
  record(tuple: FrameTuple): void;
}

/**
 * JSONL file-sink recorder. One tuple per line, appended synchronously. Append
 * failures are swallowed: a trace write must never break a live tick. Tracing is
 * an opt-in diagnostic, so a synchronous append (no async machinery on the hot
 * path) is acceptable and keeps the on-disk file consistent line-by-line.
 */
export const createJsonlFrameRecorder = (
  filePath: string,
  onError?: (err: Error) => void,
): FrameRecorder => ({
  record(tuple): void {
    try {
      appendFileSync(filePath, `${JSON.stringify(tuple)}\n`);
    } catch (err) {
      onError?.(err as Error);
    }
  },
});

/**
 * Returns a recorder only when WORKER_FRAME_TRACE=1, else undefined so the tick
 * handler's `if (deps.frameRecorder)` guard short-circuits to a true no-op. The
 * trace file path defaults to a file under the OS temp dir, never inside the repo
 * tree: a financial trace holds account balances and holdings, so a repo-relative
 * default risks committing it via `git add -A`. An explicit WORKER_FRAME_TRACE_FILE
 * overrides the default.
 */
export const createFrameRecorderFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
  onError?: (err: Error) => void,
): FrameRecorder | undefined => {
  if (env['WORKER_FRAME_TRACE'] !== '1') return undefined;
  const filePath = env['WORKER_FRAME_TRACE_FILE'] ?? join(tmpdir(), 'worker-frame-trace.jsonl');
  return createJsonlFrameRecorder(filePath, onError);
};
