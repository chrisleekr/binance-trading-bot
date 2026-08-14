// Each rung of the ladder in isolation, plus the properties that make the whole
// thing worth trusting: it never reports health it did not establish, it never
// invents a cause, and the same inputs always produce the same report.

import { describe, expect, it } from 'vitest';
import { CONDITION_SEVERITY } from '../src/condition.js';
import {
  buildProfileDiagnosis,
  DIAGNOSIS_STEPS,
  humanizeDuration,
  runDiagnosisStep,
  type DiagnosisSnapshot,
  type DiagnosisStepId,
  type DiagnosisStepResult,
  type OpenCondition,
  type ProfileDiagnosisInput,
} from '../src/profile-diagnosis.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const funnel = (over: Partial<NonNullable<DiagnosisSnapshot['funnel']>> = {}) => ({
  universe: 488,
  quote: 231,
  blacklist: 231,
  liquidity: 200,
  activity: 12,
  spread: 12,
  changeBand: 12,
  probed: 12,
  age: 12,
  trend: 3,
  eligible: 3,
  added: 1,
  breadthOk: true,
  ...over,
});

const snapshot = (over: Partial<DiagnosisSnapshot> = {}): DiagnosisSnapshot => ({
  capturedAtMs: NOW - 60_000,
  breadthOk: true,
  funnel: funnel(),
  ...over,
});

const input = (over: Partial<ProfileDiagnosisInput> = {}): ProfileDiagnosisInput => ({
  nowMs: NOW,
  profile: {
    enabled: true,
    quoteAsset: 'USDT',
    config: {},
    discoveryEnabled: true,
    discoveryConfig: {
      marketBreadthMinPercent: '40',
      maxAutoSymbols: 5,
      minAgeDays: 30,
      changeMinPercent: '2',
    },
    maxAutoSymbols: 5,
    refreshPeriodMs: 900_000,
    autoSymbolCount: 2,
    ...over.profile,
  },
  worker: { heartbeatPresent: true, ...over.worker },
  // `??` would fold an explicit null back to [], which is the exact distinction
  // the unreadable-flag cases below turn on.
  halts: over.halts === undefined ? [] : over.halts,
  conditions: over.conditions ?? [],
  snapshots: over.snapshots ?? [snapshot()],
  ...(over.liveFunnel ? { liveFunnel: over.liveFunnel } : {}),
  reasonAttribution: over.reasonAttribution ?? {},
  discoveryHealthWindow: over.discoveryHealthWindow ?? 8,
  timeline: over.timeline ?? [],
  ...(over.nowMs === undefined ? {} : { nowMs: over.nowMs }),
});

const cond = (over: Partial<OpenCondition> = {}): OpenCondition => ({
  condition: 'entry-blocked',
  symbol: 'BTCUSDT',
  code: 'knife-guard',
  detail: null,
  sinceMs: NOW - DAY,
  ...over,
});

const runAll = (i: ProfileDiagnosisInput): Map<DiagnosisStepId, DiagnosisStepResult> =>
  new Map(DIAGNOSIS_STEPS.map((id) => [id, runDiagnosisStep(id, i)]));

describe('humanizeDuration', () => {
  it.each([
    [30_000, 'less than a minute'],
    [60_000, '1 minute'],
    [600_000, '10 minutes'],
    [3_600_000, '1 hour'],
    [19 * DAY, '19 days'],
  ])('%i ms reads as %s', (ms, expected) => {
    expect(humanizeDuration(ms)).toBe(expected);
  });
});

describe('rung 1: worker alive', () => {
  it('is ok on a fresh heartbeat', () => {
    expect(runDiagnosisStep('worker-alive', input()).status).toBe('ok');
  });

  it('treats a missing heartbeat as a blocking finding, not as a gap in the reading', () => {
    // The heartbeat self-expires, so absence is evidence the engine stopped
    // writing one. Reporting `unknown` here would let a dead engine read as
    // merely unmeasured, which is the softest possible way to hide an outage.
    // Absence is also the ONLY down signal: there is no separate "stale" rung,
    // because a stuck engine stops refreshing and the key expires on its own.
    const r = runDiagnosisStep('worker-alive', input({ worker: { heartbeatPresent: false } }));
    expect(r.status).toBe('finding');
    expect(r.items[0]?.severity).toBe('blocking');
    expect(r.items[0]?.code).toBe('no-heartbeat');
  });
});

describe('rung 2: profile active', () => {
  it('is ok when enabled and unhalted', () => {
    expect(runDiagnosisStep('profile-active', input()).status).toBe('ok');
  });

  it('reports a disabled profile without calling it a fault', () => {
    const r = runDiagnosisStep(
      'profile-active',
      input({ profile: { ...input().profile, enabled: false } }),
    );
    expect(r.status).toBe('finding');
    expect(r.items[0]?.title).toBe('This profile is switched off');
  });

  it('lists each halt in force with its duration', () => {
    const r = runDiagnosisStep(
      'profile-active',
      input({ halts: [{ label: 'daily loss limit', sinceMs: NOW - 2 * 3_600_000 }] }),
    );
    expect(r.items[0]?.evidence[0]).toMatch(/2 hours/);
  });

  it('reports unknown rather than clear when the halt flag could not be read', () => {
    // The whole point of the rung is to answer "is something stopping this".
    // An unreadable flag answering "nothing is halted" is the one failure that
    // sends the operator away satisfied while the halt is still in force.
    const r = runDiagnosisStep('profile-active', input({ halts: null }));
    expect(r.status).toBe('unknown');
    expect(r.line).toMatch(/could not be read/i);
  });

  it('still reports what it can prove when the profile is off and the flag is unreadable', () => {
    // The disabled finding is proven, so it is not withheld. The line is built
    // from the items, so it makes no claim about the halt state either way.
    const r = runDiagnosisStep(
      'profile-active',
      input({ halts: null, profile: { ...input().profile, enabled: false } }),
    );
    expect(r.status).toBe('finding');
    expect(r.items[0]?.title).toBe('This profile is switched off');
    expect(r.line).not.toMatch(/halt/i);
  });
});

describe('rung 3: config valid', () => {
  it('surfaces the schema issues the producer recorded', () => {
    const r = runDiagnosisStep(
      'config-valid',
      input({
        conditions: [
          cond({
            condition: 'config-invalid',
            symbol: '',
            code: 'schema',
            detail: { issues: ['maxAutoSymbols: too small'] },
            sinceMs: NOW - 3 * DAY,
          }),
        ],
      }),
    );
    expect(r.status).toBe('finding');
    expect(r.items[0]?.severity).toBe('blocking');
    expect(r.items[0]?.evidence).toContain('maxAutoSymbols: too small');
    expect(r.items[0]?.evidence[0]).toMatch(/3 days/);
  });

  it('tolerates a detail payload that carries no issues array', () => {
    const r = runDiagnosisStep(
      'config-valid',
      input({
        conditions: [
          cond({ condition: 'config-invalid', symbol: '', code: 'schema', detail: 'oops' }),
        ],
      }),
    );
    expect(r.status).toBe('finding');
    expect(r.items[0]?.evidence).toHaveLength(1);
  });
});

describe('rung 4: discovery running', () => {
  it('skips rather than faults when discovery is deliberately off', () => {
    const r = runDiagnosisStep(
      'discovery-running',
      input({ profile: { ...input().profile, discoveryEnabled: false } }),
    );
    expect(r.status).toBe('skipped');
  });

  it('reports unknown, not "switched off", when the settings could not be read', () => {
    // `null` is not `false`. Calling an unreadable config a deliberate
    // switch-off tells the operator they made a choice they never made, and
    // sends them away from the one thing actually wrong.
    for (const id of ['discovery-running', 'market-breadth', 'candidate-funnel'] as const) {
      const r = runDiagnosisStep(
        id,
        input({ profile: { ...input().profile, discoveryEnabled: null } }),
      );
      expect(r.status).toBe('unknown');
      expect(r.line).not.toMatch(/switched off/);
    }
  });

  it('prefers the recorded condition, so duration survives log pruning', () => {
    const r = runDiagnosisStep(
      'discovery-running',
      input({
        conditions: [
          cond({
            condition: 'discovery-stale',
            symbol: '',
            code: 'no-recent-scan',
            sinceMs: NOW - 30 * DAY,
          }),
        ],
        snapshots: [],
      }),
    );
    expect(r.status).toBe('finding');
    // The whole point of the condition store: no action_logs row is needed.
    expect(r.line).toMatch(/30 days/);
  });

  it('falls back to the snapshots when no condition has been recorded yet', () => {
    const r = runDiagnosisStep('discovery-running', input({ snapshots: [] }));
    expect(r.status).toBe('finding');
    expect(r.items[0]?.evidence[0]).toMatch(/ever been recorded/);
  });

  it('is unknown when there is no refresh interval to judge staleness against', () => {
    const r = runDiagnosisStep(
      'discovery-running',
      input({ profile: { ...input().profile, refreshPeriodMs: null }, snapshots: [] }),
    );
    expect(r.status).toBe('unknown');
  });
});

describe('rung 5: market breadth', () => {
  it('is ok while the floor is being cleared', () => {
    expect(runDiagnosisStep('market-breadth', input()).status).toBe('ok');
  });

  it('finds a full window of breadth-blocked scans even with no condition row', () => {
    const blocked = Array.from({ length: 8 }, (_, i) =>
      snapshot({
        capturedAtMs: NOW - i * 60_000,
        breadthOk: false,
        funnel: funnel({ breadthOk: false }),
      }),
    );
    expect(runDiagnosisStep('market-breadth', input({ snapshots: blocked })).status).toBe(
      'finding',
    );
  });

  it('points the breadth finding at the discovery setting that armed it', () => {
    // No strategy declares `discovery-breadth`, so before the platform-owned
    // lever table this finding rendered with no "Fix this" link at all: the
    // operator was told a floor was blocking every add and left to hunt for it.
    const blocked = Array.from({ length: 8 }, (_, i) =>
      snapshot({
        capturedAtMs: NOW - i * 60_000,
        breadthOk: false,
        funnel: funnel({ breadthOk: false }),
      }),
    );
    const r = runDiagnosisStep('market-breadth', input({ snapshots: blocked }));
    expect(r.items[0]?.lever).toEqual({
      label: 'Market Breadth Min Percent',
      path: 'marketBreadthMinPercent',
      value: '40',
      surface: 'discovery',
    });
  });

  it('does not breadth-block on a partial window', () => {
    const blocked = Array.from({ length: 7 }, (_, i) =>
      snapshot({
        capturedAtMs: NOW - i * 60_000,
        breadthOk: false,
        funnel: funnel({ breadthOk: false }),
      }),
    );
    expect(runDiagnosisStep('market-breadth', input({ snapshots: blocked })).status).toBe('ok');
  });
});

describe('rung 6: candidate funnel', () => {
  it('reports unknown, never zero, when no scan carries funnel counts', () => {
    // Rows predating the funnel field have no counts. Coercing that to 0 would
    // manufacture a choke at the first stage on every legacy profile.
    const r = runDiagnosisStep(
      'candidate-funnel',
      input({ snapshots: [snapshot({ funnel: undefined })] }),
    );
    expect(r.status).toBe('unknown');
    expect(r.items).toEqual([]);
  });

  it('is ok while the scan still yields eligible coins', () => {
    expect(runDiagnosisStep('candidate-funnel', input()).status).toBe('ok');
  });

  it('never names the seam between the two ladders as the choke', () => {
    // changeBand=440 -> age=5 is the single largest proportional fall in the row,
    // and it is not a filter rejecting anything: the ticker ladder counts every
    // quote-matched symbol, the candidate ladder only the handful whose klines
    // were fetched. A search spanning both would name `age` on nearly every scan.
    const r = runDiagnosisStep(
      'candidate-funnel',
      input({
        snapshots: [
          snapshot({
            funnel: funnel({
              universe: 500,
              quote: 480,
              blacklist: 470,
              liquidity: 460,
              activity: 450,
              spread: 445,
              changeBand: 440,
              probed: 6,
              age: 5,
              trend: 4,
              eligible: 0,
            }),
          }),
        ],
      }),
    );
    expect(r.status).toBe('finding');
    expect(r.items[0]?.code).not.toBe('age');
    // Sharpest drop within a single denominator: trend(4) -> eligible(0).
    expect(r.items[0]?.code).toBe('eligible');
  });

  it('names a ticker-ladder choke when the universe empties before klines are fetched', () => {
    // The shape of the real incident: the activity filter wiped the set out, so
    // no candidate ever reached the kline segment.
    const r = runDiagnosisStep(
      'candidate-funnel',
      input({
        snapshots: [
          snapshot({
            funnel: funnel({
              activity: 0,
              spread: 0,
              changeBand: 0,
              // Nothing survived the ticker ladder, so nothing was probed.
              probed: 0,
              age: 0,
              trend: 0,
              eligible: 0,
            }),
          }),
        ],
      }),
    );
    expect(r.items[0]?.code).toBe('activity');
    expect(r.items[0]?.evidence[0]).toBe('200 coins reached this filter, 0 got past it.');
  });

  it('names the age filter when the candidates die there, instead of blaming a ticker filter', () => {
    // `probed` is what makes this answerable. It is the candidate ladder's
    // denominator, so a collapse AT the age filter is a scoreable drop rather
    // than an invisible first entry, and the finding points at the setting the
    // operator can actually move.
    const collapsed = funnel({
      universe: 100,
      quote: 100,
      blacklist: 100,
      liquidity: 100,
      activity: 100,
      spread: 100,
      changeBand: 60,
      probed: 50,
      age: 0,
      trend: 0,
      eligible: 0,
    });
    const r = runDiagnosisStep(
      'candidate-funnel',
      input({ snapshots: [snapshot({ funnel: collapsed })] }),
    );
    expect(r.items[0]?.code).toBe('age');
    expect(r.items[0]?.evidence[0]).toBe('50 coins reached this filter, 0 got past it.');
    expect(r.items[0]?.lever).toEqual({
      label: 'Min listing age (days)',
      path: 'minAgeDays',
      value: '30',
      surface: 'discovery',
    });

    // The same scan without the denominator: the age collapse is unscoreable, so
    // the search falls back to the ticker ladder and blames a filter that let 60
    // of 100 through. That is the behaviour `probed` exists to end.
    const { probed: _probed, ...unrecorded } = collapsed;
    const before = runDiagnosisStep(
      'candidate-funnel',
      input({ snapshots: [snapshot({ funnel: unrecorded })] }),
    );
    expect(before.items[0]?.code).toBe('changeBand');
  });

  it('prefers a live re-probe over the stored scan and says which it used', () => {
    // The stored scan says healthy, the probe says empty. The probe is what is
    // true now, and the operator has to be able to tell the two claims apart.
    const r = runDiagnosisStep(
      'candidate-funnel',
      input({
        snapshots: [snapshot({ capturedAtMs: NOW - 3_600_000 })],
        liveFunnel: funnel({
          activity: 0,
          spread: 0,
          changeBand: 0,
          age: 0,
          trend: 0,
          eligible: 0,
        }),
      }),
    );
    expect(r.status).toBe('finding');
    expect(r.items[0]?.code).toBe('activity');
    expect(r.line).toContain('checked against the exchange just now');
  });

  it('dates the stored scan when no probe was made', () => {
    const r = runDiagnosisStep(
      'candidate-funnel',
      input({ snapshots: [snapshot({ capturedAtMs: NOW - 3_600_000 })] }),
    );
    expect(r.line).toContain('from the last scan, 1 hour ago');
  });
});

describe('rung 7: symbol slots', () => {
  it('is ok with room to spare', () => {
    expect(runDiagnosisStep('symbol-slots', input()).status).toBe('ok');
  });

  it('finds a full auto set', () => {
    const r = runDiagnosisStep(
      'symbol-slots',
      input({ profile: { ...input().profile, autoSymbolCount: 5 } }),
    );
    expect(r.status).toBe('finding');
    expect(r.items[0]?.evidence[0]).toBe('5 of 5 slots in use.');
    // The cap is a discovery setting, so the link goes to the discovery page and
    // carries the bare field path the form actually renders as an element id.
    expect(r.items[0]?.lever).toEqual({
      label: 'Max Auto Symbols',
      path: 'maxAutoSymbols',
      value: '5',
      surface: 'discovery',
    });
  });

  it('keeps the lever but drops the value when the discovery config could not be read', () => {
    // Unreadable is not "off". The destination is still right, so the link
    // stays; the value does not, because rendering "off" there would state as
    // the operator's setting a number nobody could read.
    const r = runDiagnosisStep(
      'symbol-slots',
      input({ profile: { ...input().profile, autoSymbolCount: 5, discoveryConfig: null } }),
    );
    expect(r.items[0]?.lever).toEqual({
      label: 'Max Auto Symbols',
      path: 'maxAutoSymbols',
      value: null,
      surface: 'discovery',
    });
  });

  it('is unknown when the limit is not known', () => {
    expect(
      runDiagnosisStep(
        'symbol-slots',
        input({ profile: { ...input().profile, maxAutoSymbols: null } }),
      ).status,
    ).toBe('unknown');
  });
});

describe('rung 8: entry blockers', () => {
  it('groups symbols by reason rather than listing one row per coin', () => {
    const r = runDiagnosisStep(
      'entry-blockers',
      input({
        conditions: [
          cond({ symbol: 'BTCUSDT', sinceMs: NOW - 19 * DAY }),
          cond({ symbol: 'ETHUSDT', sinceMs: NOW - DAY }),
          cond({ symbol: 'SOLUSDT', code: 'awaiting-trigger-price' }),
        ],
      }),
    );
    expect(r.items).toHaveLength(2);
    expect(r.items[0]?.code).toBe('knife-guard');
    // Each coin keeps its OWN start. The item's `sinceMs` is the oldest of the
    // group, which is the right headline and would be the wrong span painted on
    // the younger coin's timeline lane.
    expect(r.items[0]?.symbols).toEqual([
      { symbol: 'BTCUSDT', sinceMs: NOW - 19 * DAY },
      { symbol: 'ETHUSDT', sinceMs: NOW - DAY },
    ]);
    expect(r.items[0]?.sinceMs).toBe(NOW - 19 * DAY);
    // Reported from the oldest span in the group, which is the answer to
    // "how long has this been going on" that the log stream cannot give.
    expect(r.items[0]?.evidence[1]).toMatch(/19 days/);
  });

  it('names the setting that armed a reason, using the form label', () => {
    const r = runDiagnosisStep(
      'entry-blockers',
      input({
        conditions: [cond({ code: 'discovery-liquidity' })],
        reasonAttribution: {
          'discovery-liquidity': {
            gloss: 'Not enough trading volume',
            paths: ['min24hAssetVolumeUsd'],
          },
        },
        profile: { ...input().profile, config: { min24hAssetVolumeUsd: '5000000' } },
      }),
    );
    // The label has to match what the form renders, or the operator hunts for a
    // field that does not exist under that name.
    expect(r.items[0]?.lever).toEqual({
      label: 'Min 24h volume for the coin (USD)',
      path: 'min24hAssetVolumeUsd',
      value: '5000000',
      surface: 'config',
    });
  });

  it('leaves the lever null when the strategy declares no setting for the code', () => {
    const r = runDiagnosisStep(
      'entry-blockers',
      input({ conditions: [cond({ code: 'mystery-code' })] }),
    );
    expect(r.items[0]?.lever).toBeNull();
    expect(r.items[0]?.title).toBe('mystery-code');
  });
});

// The exit side of the same question. A held coin that never sells is the
// defect these rungs exist for: the operator could see the entry ladder in full
// and nothing at all about why the position was still open.
const exitCond = (over: Partial<OpenCondition> = {}): OpenCondition =>
  cond({
    condition: 'exit-blocked',
    code: 'awaiting-sell-arm',
    detail: { armPrice: '0.03205413', currentPrice: '0.0302', hasDownsideExit: true },
    ...over,
  });

const EXIT_ATTRIBUTION = {
  'awaiting-sell-arm': {
    gloss: 'Waiting for the sell trigger before the trailing stop arms',
    paths: ['sell.triggerPercentage'],
  },
  'exit-unsellable': { gloss: 'An exit triggered but the position could not be sold' },
  'no-exit-configured': {
    gloss: 'This position has no exit below the entry price',
    paths: ['sell.stopLossPercentage'],
  },
};

describe('rung 9: exit blockers', () => {
  it('names the rung and the level each held coin is waiting on', () => {
    const r = runDiagnosisStep(
      'exit-blockers',
      input({ conditions: [exitCond()], reasonAttribution: EXIT_ATTRIBUTION }),
    );
    // The reported defect in one line: the arm price the position never reached,
    // beside the price it was actually at.
    expect(r.line).toBe(
      'BTCUSDT: Waiting for the sell trigger before the trailing stop arms (arm price 0.03205413, price 0.0302).',
    );
  });

  it('does not call a coin waiting for its sell trigger a finding', () => {
    // A held position waiting on its arm is the normal state. Raising an item
    // would flip every healthy profile holding anything to "idle on purpose"
    // and hand it a headline about selling.
    const r = runDiagnosisStep(
      'exit-blockers',
      input({ conditions: [exitCond()], reasonAttribution: EXIT_ATTRIBUTION }),
    );
    expect(r.status).toBe('ok');
    expect(r.items).toEqual([]);
  });

  it('raises a finding for a position that triggered an exit and could not sell', () => {
    const r = runDiagnosisStep(
      'exit-blockers',
      input({
        conditions: [
          exitCond({ symbol: 'BTCUSDT', code: 'exit-unsellable', detail: { skip: 'no-balance' } }),
          exitCond({ symbol: 'ETHUSDT' }),
        ],
        reasonAttribution: EXIT_ATTRIBUTION,
      }),
    );
    expect(r.status).toBe('finding');
    expect(r.items.map((i) => i.code)).toEqual(['exit-unsellable']);
    expect(r.items[0]?.symbols).toEqual([{ symbol: 'BTCUSDT', sinceMs: NOW - DAY }]);
    expect(r.items[0]?.severity).toBe('degraded');
  });

  it('collapses to a count past the first few coins', () => {
    const r = runDiagnosisStep(
      'exit-blockers',
      input({
        conditions: ['A', 'B', 'C', 'D', 'E'].map((s) => exitCond({ symbol: `${s}USDT` })),
        reasonAttribution: EXIT_ATTRIBUTION,
      }),
    );
    expect(r.line).toMatch(/and 2 more\.$/);
  });

  it('is ok when no held coin is waiting on an exit', () => {
    expect(runDiagnosisStep('exit-blockers', input()).status).toBe('ok');
  });
});

describe('rung 10: exit protection', () => {
  it('warns when a held coin has no exit below its entry', () => {
    const r = runDiagnosisStep(
      'exit-protection',
      input({
        conditions: [
          exitCond({
            symbol: 'ETHBTC',
            detail: { armPrice: '0.032', currentPrice: '0.0302', hasDownsideExit: false },
          }),
        ],
        reasonAttribution: EXIT_ATTRIBUTION,
        profile: { ...input().profile, config: { sell: { stopLossPercentage: '' } } },
      }),
    );
    expect(r.status).toBe('finding');
    expect(r.items[0]?.code).toBe('no-exit-configured');
    expect(r.items[0]?.symbols).toEqual([{ symbol: 'ETHBTC', sinceMs: NOW - DAY }]);
    expect(r.items[0]?.lever?.path).toBe('sell.stopLossPercentage');
  });

  it('is ok when every held coin has one', () => {
    const r = runDiagnosisStep('exit-protection', input({ conditions: [exitCond()] }));
    expect(r.status).toBe('ok');
    expect(r.items).toEqual([]);
  });

  it('reports unknown rather than ok when no record says either way', () => {
    // "We could not check" and "we checked and it is fine" are different claims,
    // and this rung's only value is that its ok means something was checked.
    const r = runDiagnosisStep(
      'exit-protection',
      input({ conditions: [exitCond({ detail: { armPrice: '1' } })] }),
    );
    expect(r.status).toBe('unknown');
  });

  it('skips when nothing is held', () => {
    expect(runDiagnosisStep('exit-protection', input()).status).toBe('skipped');
  });

  // A protective stop the exchange band refuses is DEFERRED, not attempted, so
  // it produces no failed order, no exit-blocked reason and no alert of its own.
  // The condition row is the only thing that knows the coin is unguarded, and
  // this is the rung the operator reads to find that out.
  describe('protective stop blocked', () => {
    const stopBlocked = (over: Partial<OpenCondition> = {}): OpenCondition =>
      cond({
        condition: 'protective-stop-blocked',
        symbol: 'LINKUSDT',
        code: 'price-outside-exchange-band',
        detail: { bound: 'floor', terminal: false, guarded: false, price: '11.386' },
        ...over,
      });

    it('C7: is degraded, not blocking — the profile still trades, one position is naked', () => {
      // `blocking` would flip the whole-profile verdict to "blocked" and claim the
      // bot has stopped, which is false and is the reading that gets ignored.
      expect(CONDITION_SEVERITY['protective-stop-blocked']).toBe('degraded');
    });

    it('C7: raises the finding even when no exit-blocked condition exists', () => {
      // The naked position need not be waiting on an exit at all: the stop was
      // never placed, so nothing on the exit side ever reported it.
      const r = runDiagnosisStep('exit-protection', input({ conditions: [stopBlocked()] }));

      expect(r.status).toBe('finding');
      const item = r.items.find((i) => i.condition === 'protective-stop-blocked');
      expect(item).toBeDefined();
      expect(item?.code).toBe('price-outside-exchange-band');
      expect(item?.severity).toBe('degraded');
      expect(item?.symbols).toEqual([{ symbol: 'LINKUSDT', sinceMs: NOW - DAY }]);
    });

    it('merges its headline with the held-coin exit finding and keeps both items', () => {
      // Two independent failures on one rung: the stop the exchange refused, and
      // a held coin whose only exit is above its entry. Neither line replaces the
      // other, and neither item may be dropped — the combined branch is the one
      // an operator with a genuinely bad position actually sees.
      const r = runDiagnosisStep(
        'exit-protection',
        input({
          conditions: [
            stopBlocked(),
            exitCond({
              symbol: 'ETHBTC',
              detail: { armPrice: '0.032', currentPrice: '0.0302', hasDownsideExit: false },
            }),
          ],
        }),
      );

      expect(r.status).toBe('finding');
      expect(r.line).toContain('protective stop');
      expect(r.line).toContain('can only be closed at a profit or by you');
      expect(r.items.map((i) => i.id)).toEqual([
        'protective-stop-blocked:price-outside-exchange-band',
        'exit-blocked:no-downside-exit',
      ]);
    });

    it('keeps a guarded row on the rung instead of filtering it out', () => {
      // `guarded` rows stay ON this rung deliberately — they are the amber
      // reading, a position drifting away from the stop that covers it. Filtering
      // them as "already protected" is the tempting simplification, and it would
      // hide the drift until the stop is far enough behind to be worthless.
      const r = runDiagnosisStep(
        'exit-protection',
        input({
          conditions: [
            stopBlocked({
              detail: { bound: 'floor', terminal: false, guarded: true, price: '11.386' },
            }),
          ],
        }),
      );

      expect(r.status).toBe('finding');
      expect(r.items.map((i) => i.id)).toContain(
        'protective-stop-blocked:price-outside-exchange-band',
      );
    });

    it('C7: reports it in the assembled diagnosis without calling the profile blocked', () => {
      const i = input({ conditions: [stopBlocked()] });
      const report = buildProfileDiagnosis(i, runAll(i));

      expect(report.items.some((it) => it.condition === 'protective-stop-blocked')).toBe(true);
      expect(report.verdict).toBe('idle-by-design');
    });
  });
});

describe('rung 11: which setting', () => {
  it('says nothing is misconfigured when the blocks trace to no setting', () => {
    // The honest bottom rung: "your settings are just strict" and "the market is
    // not cooperating" are valid answers, and must not be dressed up as a cause.
    const r = runDiagnosisStep(
      'config-levers',
      input({ conditions: [cond({ code: 'no-lever-code' })] }),
    );
    expect(r.status).toBe('ok');
    expect(r.line).toMatch(/not settings/);
    expect(r.items).toEqual([]);
  });

  it('skips when nothing is blocking entries at all', () => {
    expect(runDiagnosisStep('config-levers', input()).status).toBe('skipped');
  });

  it('names an exit setting too, not only entry settings', () => {
    // The operator asks one question about a bot that is not doing what they
    // expect; a sell trigger the position cannot reach is as much an answer.
    const r = runDiagnosisStep(
      'config-levers',
      input({
        conditions: [exitCond()],
        reasonAttribution: EXIT_ATTRIBUTION,
        profile: { ...input().profile, config: { sell: { triggerPercentage: '1.08' } } },
      }),
    );
    expect(r.status).toBe('finding');
    expect(r.line).toMatch(/1 setting/);
  });
});

describe('a rung that throws', () => {
  it('degrades to unknown and never to ok', () => {
    const hostile = input();
    Object.defineProperty(hostile.profile, 'maxAutoSymbols', {
      get() {
        throw new Error('column missing');
      },
    });
    const r = runDiagnosisStep('symbol-slots', hostile);
    expect(r.status).toBe('unknown');
    expect(r.items).toEqual([]);
    // A fixed sentence, not the throw's text. This line is persisted into the
    // run row and served by the GETs that stay open under LIVE_DEMO.
    expect(r.line).toBe('This check could not be completed.');
    expect(r.line).not.toMatch(/column missing/);
  });
});

describe('buildProfileDiagnosis', () => {
  it('returns verdict "trading" only when every rung actually ran and found nothing', () => {
    const i = input();
    const report = buildProfileDiagnosis(i, runAll(i));
    expect(report.verdict).toBe('trading');
    expect(report.items).toEqual([]);
  });

  it('returns "unknown" rather than "trading" when a rung could not decide', () => {
    const i = input({ worker: { heartbeatPresent: false } });
    const results = runAll(i);
    // Strip the unknown rung's item so only its status can decide the verdict.
    results.set('worker-alive', { status: 'unknown', line: 'nope', items: [] });
    expect(buildProfileDiagnosis(i, results).verdict).toBe('unknown');
  });

  it('returns "unknown" when the ladder did not finish', () => {
    const i = input();
    const partial = new Map(runAll(i));
    partial.delete('entry-blockers');
    expect(buildProfileDiagnosis(i, partial).verdict).toBe('unknown');
  });

  it('calls a disabled profile idle-by-design, not blocked', () => {
    const i = input({
      profile: { ...input().profile, discoveryEnabled: false },
      conditions: [cond()],
    });
    const report = buildProfileDiagnosis(i, runAll(i));
    expect(report.verdict).toBe('idle-by-design');
  });

  it('calls a switched-off profile idle-by-design, not blocked', () => {
    // "Blocked" is reserved for a fault. Off is the state the operator chose,
    // and spending the word on it teaches them to ignore it when it matters.
    const i = input({ profile: { ...input().profile, enabled: false } });
    const report = buildProfileDiagnosis(i, runAll(i));
    expect(report.verdict).toBe('idle-by-design');
    expect(report.items.find((it) => it.id === 'profile-disabled')?.severity).toBe('degraded');
  });

  it('ranks by ladder position, so a dead engine owns the headline', () => {
    const i = input({
      worker: { heartbeatPresent: false },
      conditions: [cond()],
    });
    const report = buildProfileDiagnosis(i, runAll(i));
    expect(report.verdict).toBe('blocked');
    expect(report.headline).toBe('The trading engine is not running');
    // Later findings are still listed; ranking is not suppression.
    expect(report.items.length).toBeGreaterThan(1);
  });

  it('marks unrun steps pending, so partial progress is never read as complete', () => {
    const i = input();
    const report = buildProfileDiagnosis(i, new Map());
    expect(report.steps).toHaveLength(DIAGNOSIS_STEPS.length);
    expect(report.steps.every((s) => s.status === 'pending')).toBe(true);
  });

  it('keeps the probe out of the history strip', () => {
    // The strip answers "does it choke EVERY scan"; only the bot's own scans can
    // answer that, so a probe must widen the ladder without forging a scan.
    const i = input({
      snapshots: [snapshot({ capturedAtMs: NOW - 1000 })],
      liveFunnel: funnel({ eligible: 0 }),
    });
    const report = buildProfileDiagnosis(i, runAll(i));
    expect(report.funnel?.source).toBe('live');
    expect(report.funnel?.latestAtMs).toBe(NOW);
    expect(report.funnel?.history).toHaveLength(1);
    expect(report.funnel?.history[0]?.atMs).toBe(NOW - 1000);
  });

  it('labels a stored-only funnel as stored', () => {
    const i = input();
    expect(buildProfileDiagnosis(i, runAll(i)).funnel?.source).toBe('stored');
  });

  it('keeps the two funnel ladders separate in the projection', () => {
    const i = input();
    const report = buildProfileDiagnosis(i, runAll(i));
    expect(report.funnel?.ticker.map((s) => s.stage)).toEqual([
      'universe',
      'quote',
      'blacklist',
      'liquidity',
      'activity',
      'spread',
      'changeBand',
    ]);
    expect(report.funnel?.candidate.map((s) => s.stage)).toEqual([
      'probed',
      'age',
      'trend',
      'eligible',
    ]);
  });

  it('reports funnel history oldest-first with unknown breadth preserved as null', () => {
    const i = input({
      snapshots: [
        snapshot({ capturedAtMs: NOW - 1000 }),
        snapshot({ capturedAtMs: NOW - 2000, breadthOk: undefined }),
      ],
    });
    const report = buildProfileDiagnosis(i, runAll(i));
    expect(report.funnel?.history.map((h) => h.atMs)).toEqual([NOW - 2000, NOW - 1000]);
    expect(report.funnel?.history[0]?.breadthOk).toBeNull();
  });

  it('leaves a pre-funnel scan unknown in the history strip rather than zero', () => {
    // A scan that predates the funnel field recorded no counts. Plotting it at
    // zero would read as "nothing survived", which is the opposite claim to
    // "not recorded" — and this strip exists to tell chronic choke from a bad
    // scan, so the difference decides the answer.
    const i = input({
      snapshots: [snapshot({ capturedAtMs: NOW - 1000 }), { capturedAtMs: NOW - 2000 }],
    });
    const report = buildProfileDiagnosis(i, runAll(i));
    expect(report.funnel?.history[0]).toEqual({
      atMs: NOW - 2000,
      eligible: null,
      added: null,
      breadthOk: null,
    });
  });

  it('has no funnel at all when no snapshot carries counts', () => {
    const i = input({ snapshots: [snapshot({ funnel: undefined })] });
    expect(buildProfileDiagnosis(i, runAll(i)).funnel).toBeNull();
  });

  it('is deterministic: the same input twice produces a byte-identical report', () => {
    // If a model ever enters the ranking, this is what fails.
    const i = input({
      conditions: [cond({ symbol: 'ETHUSDT' }), cond({ symbol: 'BTCUSDT' })],
      halts: [{ label: 'kill switch', sinceMs: NOW - DAY }],
    });
    const a = JSON.stringify(buildProfileDiagnosis(i, runAll(i)));
    const b = JSON.stringify(buildProfileDiagnosis(i, runAll(i)));
    expect(a).toBe(b);
  });
});
