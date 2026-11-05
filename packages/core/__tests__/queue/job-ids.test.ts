import { describe, expect, it } from 'vitest';

import {
  applyAepJobId,
  archiveGridJobId,
  backfillArchiveJobId,
  backfillArchiveSweepJobId,
  backtestJobId,
  cancelOrderJobId,
  diagnosisJobId,
  manualTickJobId,
  resetGridJobId,
  subscribeJobId,
  symbolReconcileJobId,
  tickJobId,
  unsubscribeJobId,
  verifyKeyJobId,
} from '../../src/queue/job-ids.js';

const P = '00000000-0000-0000-0000-0000000000bb';
const A = '00000000-0000-0000-0000-0000000000aa';
const S = 'BTCUSDT';
const T = 1_700_000_000_000;

describe('job id builders', () => {
  // BullMQ rejects a plain-integer custom id at add time, and 5.58.7+ also rejects a ':' id that does not split into exactly 3 parts; these ids carry no ':' at all.
  it.each([
    ['tick', tickJobId(P, S), `tick|${P}|${S}`],
    ['manualTick', manualTickJobId(P, S, T), `tick|${P}|${S}|${T}`],
    ['symbolReconcile', symbolReconcileJobId(P, S), `reconcile-symbol|${P}|${S}`],
    ['backtest', backtestJobId('r1'), 'backtest|r1'],
    ['diagnosis', diagnosisJobId('r1'), 'diagnosis|r1'],
    ['subscribe', subscribeJobId(P), `subscribe|${P}`],
    ['unsubscribe', unsubscribeJobId(P), `unsubscribe|${P}`],
    ['cancelOrder', cancelOrderJobId('o1'), 'cancel|o1'],
    ['archiveGrid', archiveGridJobId(P, S, T), `archive-grid|${P}|${S}|${T}`],
    ['resetGrid', resetGridJobId(P, S, T), `reset-grid|${P}|${S}|${T}`],
    ['applyAep', applyAepJobId(P, S, T), `apply-aep|${P}|${S}|${T}`],
    ['verifyKey', verifyKeyJobId(A, T), `verify-key|${A}|${T}`],
    ['backfillArchive', backfillArchiveJobId(P, S, T), `backfill-archive|${P}|${S}|${T}`],
    [
      'backfillArchiveSweep',
      backfillArchiveSweepJobId(P, S, T),
      `backfill-archive|sweep|${P}|${S}|${T}`,
    ],
  ])('%s builds the exact id and passes BullMQ add-time checks', (_name, id, expected) => {
    expect(id).toBe(expected);
    expect(id).not.toContain(':');
    expect(id).not.toMatch(/^\d+$/);
  });

  it('is deterministic for the coalescing builders', () => {
    expect(tickJobId(P, S)).toBe(tickJobId(P, S));
    expect(symbolReconcileJobId(P, S)).toBe(symbolReconcileJobId(P, S));
    expect(backtestJobId('r1')).toBe(backtestJobId('r1'));
    expect(diagnosisJobId('r1')).toBe(diagnosisJobId('r1'));
    expect(subscribeJobId(P)).toBe(subscribeJobId(P));
    expect(unsubscribeJobId(P)).toBe(unsubscribeJobId(P));
    expect(cancelOrderJobId('o1')).toBe(cancelOrderJobId('o1'));
  });

  it('keeps a manual tick distinct from the coalescing tick', () => {
    expect(manualTickJobId(P, S, T)).not.toBe(tickJobId(P, S));
  });

  it('rejects a part containing the legacy delimiter', () => {
    expect(() => tickJobId(P, 'BTC:USDT')).toThrow(/must not contain ':' or '\|'/);
  });

  it('rejects a part containing the new delimiter, which would make ids ambiguous', () => {
    expect(() => tickJobId(P, 'BTC|USDT')).toThrow(/must not contain ':' or '\|'/);
  });

  it('rejects a delimiter in a non-symbol part', () => {
    expect(() => backtestJobId('r:1')).toThrow(/must not contain ':' or '\|'/);
    expect(() => backtestJobId('r|1')).toThrow(/must not contain ':' or '\|'/);
  });
});
