// Batch-cadence contract for the technicals-compute cron. Locks the
// per-interval union shape so a future scheduler refactor can't silently
// regress to one-job-per-profile (or one-job-per-symbol) without flunking
// this gate.

import { describe, expect, it } from 'vitest';

import {
  buildTechnicalsJobs,
  type ProfileTechnicalsSubscription,
} from '../../src/crons/technicals-batch.js';

describe('buildTechnicalsJobs', () => {
  it('emits exactly one job per distinct interval with symbols unioned across profiles', () => {
    // Verbatim from #46 acceptance: profile A [BTCUSDT, ETHUSDT]@5m +
    // profile B [BTCUSDT, DOGEUSDT]@5m + [BTCUSDT]@1h → exactly TWO jobs;
    // one 5m with union {BTC, ETH, DOGE}, one 1h with {BTC}.
    const profiles: ProfileTechnicalsSubscription[] = [
      {
        profileId: 'a',
        technicals: [{ interval: '5m', symbols: ['BTCUSDT', 'ETHUSDT'] }],
      },
      {
        profileId: 'b',
        technicals: [
          { interval: '5m', symbols: ['BTCUSDT', 'DOGEUSDT'] },
          { interval: '1h', symbols: ['BTCUSDT'] },
        ],
      },
    ];

    const jobs = buildTechnicalsJobs(profiles);

    expect(jobs).toHaveLength(2);
    const fiveMinute = jobs.find((j) => j.interval === '5m');
    const oneHour = jobs.find((j) => j.interval === '1h');
    expect(fiveMinute).toBeDefined();
    expect(oneHour).toBeDefined();
    expect(fiveMinute?.symbols).toEqual(['BTCUSDT', 'DOGEUSDT', 'ETHUSDT']);
    expect(oneHour?.symbols).toEqual(['BTCUSDT']);
  });

  it('skips intervals with empty symbol sets so the worker never fires a compute call for nothing', () => {
    const jobs = buildTechnicalsJobs([
      { profileId: 'a', technicals: [{ interval: '5m', symbols: [] }] },
    ]);
    expect(jobs).toEqual([]);
  });

  it('deduplicates identical (interval, symbol) pairs across profiles into one entry', () => {
    // Three profiles all subscribed to BTCUSDT@1h must produce a single
    // 1h job with one symbol, not three duplicate symbols or three
    // jobs — both shapes would multiply the compute call without
    // benefit.
    const profiles: ProfileTechnicalsSubscription[] = [
      { profileId: 'a', technicals: [{ interval: '1h', symbols: ['BTCUSDT'] }] },
      { profileId: 'b', technicals: [{ interval: '1h', symbols: ['BTCUSDT'] }] },
      { profileId: 'c', technicals: [{ interval: '1h', symbols: ['BTCUSDT'] }] },
    ];

    const jobs = buildTechnicalsJobs(profiles);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.symbols).toEqual(['BTCUSDT']);
  });

  it('emits jobs for higher-timeframe intervals (4h, 1d) the same way as short-TF ones', () => {
    // Lock the aggregator's contract: subscriptions naming higher-TF
    // intervals (4h, 1d) emit jobs identical in shape to short-TF ones.
    // The aggregator never special-cases interval strings; this guards
    // against a future scheduler refactor adding such a check.
    const jobs = buildTechnicalsJobs([
      {
        profileId: 'a',
        technicals: [
          { interval: '1h', symbols: ['BTCUSDT'] },
          { interval: '4h', symbols: ['BTCUSDT'] },
          { interval: '1d', symbols: ['BTCUSDT'] },
        ],
      },
    ]);
    const intervals = jobs.map((j) => j.interval).sort();
    expect(intervals).toEqual(['1d', '1h', '4h']);
    for (const j of jobs) expect(j.symbols).toEqual(['BTCUSDT']);
  });

  it('returns no jobs when no profile subscribes to Technicals', () => {
    expect(buildTechnicalsJobs([])).toEqual([]);
    expect(buildTechnicalsJobs([{ profileId: 'a', technicals: [] }])).toEqual([]);
  });
});
