// Each rung of the ladder in isolation, plus the properties that make the whole
// thing worth trusting: it never reports health it did not establish, it never
// invents a cause, and the same inputs always produce the same report.

import { describe, expect, it } from 'vitest';
import { CONDITION_SEVERITY } from '../src/condition.js';
import {
  buildProfileDiagnosis,
  DIAGNOSIS_STEPS,
  humanizeDuration,
  PROTECTIVE_STOP_UNPLACED_PERSISTENCE_MS,
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

// A scan persisted before the funnel field: the key is ABSENT, not set to undefined. `funnel?:` is an optional property, so under `exactOptionalPropertyTypes` those are different types, and only the absent one is a row the discovery writer could ever have produced.
const preFunnelSnapshot = (over: Partial<DiagnosisSnapshot> = {}): DiagnosisSnapshot => {
  const { funnel: _absent, ...rest } = snapshot(over);
  return rest;
};

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
  assetPolicyAbort: over.assetPolicyAbort ?? null,
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

describe('rung 4: order execution', () => {
  const refusal = (
    symbol: string,
    msg: string,
    detail: unknown = {
      request: {
        clientOrderId: 'client-1',
        symbol,
        side: 'BUY',
        type: 'STOP_LOSS_LIMIT',
        quantity: '0.010',
        price: '50000',
        stopPrice: '50100',
        timeInForce: 'GTC',
      },
      rejection: { code: -2010, msg },
      threshold: 3,
      probeEveryMs: 60_000,
    },
  ): OpenCondition =>
    cond({
      condition: 'order-refusal-loop',
      symbol,
      code: '-2010',
      detail,
      sinceMs: NOW - DAY,
    });

  it('is the fourth rung and is ok without an open refusal loop', () => {
    expect(DIAGNOSIS_STEPS[3]).toBe('order-execution');
    expect(runDiagnosisStep('order-execution', input())).toEqual({
      status: 'ok',
      line: 'No repeated Binance order refusal is currently recorded.',
      items: [],
    });
  });

  it('reports the exact request, code, raw message, threshold, and probe cadence', () => {
    const msg = 'Account has insufficient balance for requested action.';
    const r = runDiagnosisStep('order-execution', input({ conditions: [refusal('BTCUSDT', msg)] }));

    expect(CONDITION_SEVERITY['order-refusal-loop']).toBe('degraded');
    expect(r.status).toBe('finding');
    expect(r.items[0]).toMatchObject({
      id: 'order-refusal-loop:BTCUSDT',
      condition: 'order-refusal-loop',
      code: '-2010',
      severity: 'degraded',
      lever: null,
      symbols: [{ symbol: 'BTCUSDT', sinceMs: NOW - DAY }],
    });
    expect(r.items[0]?.evidence).toEqual([
      'Action: BUY STOP_LOSS_LIMIT 0.010 BTCUSDT.',
      `Binance -2010: ${msg}`,
      'Binance refused this exact order 3 times. The bot now probes it once every 60 seconds.',
    ]);
  });

  it('keeps overloaded Binance codes separate when their raw messages differ', () => {
    const r = runDiagnosisStep(
      'order-execution',
      input({
        conditions: [
          refusal('BTCUSDT', 'Account has insufficient balance for requested action.'),
          refusal('ETHUSDT', 'Market is closed.'),
        ],
      }),
    );

    expect(r.items).toHaveLength(2);
    expect(r.items.map((item) => item.evidence[1])).toEqual([
      'Binance -2010: Account has insufficient balance for requested action.',
      'Binance -2010: Market is closed.',
    ]);
    expect(r.line).toBe('2 order refusal loops are open.');
  });

  it('agrees in number when exactly one loop is open', () => {
    const r = runDiagnosisStep(
      'order-execution',
      input({ conditions: [refusal('BTCUSDT', 'Market is closed.')] }),
    );

    expect(r.line).toBe('1 order refusal loop is open.');
  });

  it('does not invent request evidence from malformed detail', () => {
    const r = runDiagnosisStep(
      'order-execution',
      input({ conditions: [refusal('BTCUSDT', 'unused', 'malformed')] }),
    );

    expect(r.status).toBe('finding');
    expect(r.items[0]?.evidence).toContain(
      'The exact request and Binance message were not recorded.',
    );
  });

  it('falls back rather than printing a non-finite threshold or cadence', () => {
    // A JSON number beyond a double parses back as Infinity, and both values
    // reach the operator as text. The generic branch is the honest answer.
    const request = {
      clientOrderId: 'client-1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'STOP_LOSS_LIMIT',
      quantity: '0.010',
      price: '50000',
      stopPrice: '50100',
      timeInForce: 'GTC',
    };
    const rejection = { code: -2010, msg: 'Market is closed.' };
    for (const detail of [
      { request, rejection, threshold: Number.POSITIVE_INFINITY, probeEveryMs: 60_000 },
      { request, rejection, threshold: 3, probeEveryMs: Number.NaN },
    ]) {
      const r = runDiagnosisStep(
        'order-execution',
        input({ conditions: [refusal('BTCUSDT', 'unused', detail)] }),
      );
      expect(r.items[0]?.evidence).toContain(
        'The exact request and Binance message were not recorded.',
      );
    }
  });

  it('raises the verdict to needs-attention, since a refused order is not the profile idling on purpose', () => {
    const i = input({ conditions: [refusal('BTCUSDT', 'Market is closed.')] });
    const report = buildProfileDiagnosis(i, runAll(i));

    expect(report.items.some((item) => item.condition === 'order-refusal-loop')).toBe(true);
    expect(report.verdict).toBe('needs-attention');
  });
});

describe('rung 5: discovery running', () => {
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

  it('rung 5: asset-policy abort blocks the verdict', () => {
    // A cycle that refused to rank on an untrustworthy asset classification leaves a symbol set that simply stopped moving. Without its own finding the panel reads as "nothing qualified", which sends the operator to loosen filters that were never consulted.
    const i = input({
      assetPolicyAbort: { cause: 'stablecoin-route-empty', atMs: NOW - 600_000 },
    });

    const r = runDiagnosisStep('discovery-running', i);
    expect(r.status).toBe('finding');
    const item = r.items[0];
    expect(item?.severity).toBe('blocking');
    expect(item?.code).toBe('stablecoin-route-empty');
    // The copy has to say what happened; echoing the enum literal is the failure mode this finding exists to avoid.
    const copy = `${item?.title ?? ''} ${item?.detail ?? ''}`.trim();
    expect(copy).not.toBe('');
    expect(copy).not.toContain('stablecoin-route-empty');

    expect(buildProfileDiagnosis(i, runAll(i)).verdict).toBe('blocked');
  });

  it('dates an asset-policy abort from the start of the run, not from the last attempt', () => {
    // The record is rewritten by every aborting cycle, so `atMs` is one refresh period old however long the fault has held. Reading the duration off it would render a six-day refusal as "for 15 minutes" and draw the same short span on the timeline, which is exactly the chronic-versus-unlucky distinction this finding exists to make.
    const i = input({
      assetPolicyAbort: {
        cause: 'cross-check-gap',
        atMs: NOW - 900_000,
        firstAtMs: NOW - 6 * DAY,
      },
    });
    const item = runDiagnosisStep('discovery-running', i).items[0];
    expect(item?.sinceMs).toBe(NOW - 6 * DAY);
    // The two times answer different questions and must not be collapsed into one: `sinceMs` is how long the fault has held, while the evidence line is when it was last attempted. Dating the evidence from the run start would tell an operator the bot has not tried for six days, when it has been trying every fifteen minutes and failing.
    expect(item?.evidence[0]).toMatch(/15 minutes/);
  });

  it('stops reporting an abort that no longer explains the gap, and unmasks what does', () => {
    // The record's clear swallows a failed DEL, so a cycle can succeed and leave the refusal parked for the key's whole 25-hour TTL. Ungated, the rung would call a profile that is demonstrably scanning blocked, and because it sits ahead of the staleness branch it would also hide whatever fault IS open. The monitor already expires the same record on `2 x refreshPeriodMs`; disagreeing with it is worse than either answer alone.
    const stranded = { cause: 'cross-check-gap', atMs: NOW - 4 * 900_000 } as const;
    const i = input({
      assetPolicyAbort: stranded,
      conditions: [cond({ condition: 'discovery-stale', symbol: '', sinceMs: NOW - DAY })],
    });

    const r = runDiagnosisStep('discovery-running', i);
    expect(r.items[0]?.id).toBe('discovery-stale');
    expect(r.items.some((it) => it.id === 'discovery-asset-policy-abort')).toBe(false);

    // Same record one tick inside the bound still blocks: the gate is the age, not the presence.
    const fresh = runDiagnosisStep(
      'discovery-running',
      input({ ...i, assetPolicyAbort: { ...stranded, atMs: NOW - 2 * 900_000 } }),
    );
    expect(fresh.items[0]?.id).toBe('discovery-asset-policy-abort');
  });

  it('keeps a blocking abort when there is no refresh period to measure it against', () => {
    // Unreachable through `gather`, which derives both fields from one parsed config, but the type allows it. Suppressing a blocking fault because the bound is unknown fails in the wrong direction.
    const i = input({
      profile: { ...input().profile, refreshPeriodMs: null },
      assetPolicyAbort: { cause: 'cross-check-gap', atMs: NOW - 30 * DAY },
    });
    expect(runDiagnosisStep('discovery-running', i).items[0]?.id).toBe(
      'discovery-asset-policy-abort',
    );
  });

  it('falls back to the abort time when a record carries no start of its own', () => {
    // A record parked by an earlier worker has only `atMs`. Dropping the finding over a missing field would hide a live refusal; dating it from `atMs` understates the age and says so honestly.
    const i = input({ assetPolicyAbort: { cause: 'cross-check-gap', atMs: NOW - 900_000 } });
    expect(runDiagnosisStep('discovery-running', i).items[0]?.sinceMs).toBe(NOW - 900_000);
  });
});

describe('rung 6: market breadth', () => {
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

  it('does not call a sustained breadth block the profile working as configured', () => {
    // This rung cannot see a single blocked scan: it is raised only once the whole health window has been blocked. That is the state the `discovery-health` notification already calls "Discovery not working" and pages on by default, so reporting it here as by-design would leave two surfaces making opposite claims about one fact, and would let a profile whose auto-set has stopped rotating read as idle on purpose.
    const blocked = Array.from({ length: 8 }, (_, i) =>
      snapshot({
        capturedAtMs: NOW - i * 60_000,
        breadthOk: false,
        funnel: funnel({ breadthOk: false }),
      }),
    );
    const r = runDiagnosisStep('market-breadth', input({ snapshots: blocked }));

    expect(r.items[0]?.severity).toBe('degraded');
    // The sibling finding in the same notification category, so the two cannot drift apart unnoticed.
    expect(r.items[0]?.severity).toBe(
      runDiagnosisStep(
        'discovery-running',
        input({ conditions: [cond({ condition: 'discovery-stale', code: 'no-scan' })] }),
      ).items[0]?.severity,
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

describe('rung 7: candidate funnel', () => {
  it('reports unknown, never zero, when no scan carries funnel counts', () => {
    // Rows predating the funnel field have no counts. Coercing that to 0 would
    // manufacture a choke at the first stage on every legacy profile.
    const r = runDiagnosisStep('candidate-funnel', input({ snapshots: [preFunnelSnapshot()] }));
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

describe('rung 8: symbol slots', () => {
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

describe('rung 9: entry blockers', () => {
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
  'protective-stop-unplaced': {
    gloss: 'No protective stop is resting on Binance yet for this position',
  },
  'priced-stop-resting': {
    gloss: 'A fixed-price protective stop is resting on Binance for this position',
  },
};

// How long a coin has to stay without a resting protective stop before the state stops being an ordinary post-entry tick and becomes something the operator has to act on. One tick of it is the stop going on next tick; the same span still open a quarter of an hour later means every arm is being refused and the position has nothing under it.
const UNPLACED_PERSIST_MS = PROTECTIVE_STOP_UNPLACED_PERSISTENCE_MS;

describe('rung 10: exit blockers', () => {
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

  it('raises a finding for a held stop that can never sell the tracked dust', () => {
    const r = runDiagnosisStep(
      'exit-blockers',
      input({
        conditions: [
          exitCond({
            symbol: 'ZECBTC',
            code: 'stop-infeasible-dust',
            detail: {
              heldQuantity: '0.00999',
              stopPrice: '0.010404',
              minNotional: '0.0001',
              hasDownsideExit: false,
            },
          }),
        ],
        reasonAttribution: EXIT_ATTRIBUTION,
      }),
    );

    expect(r.status).toBe('finding');
    expect(r.items.map((i) => i.code)).toEqual(['stop-infeasible-dust']);
  });

  it('raises a finding when native trailing is unavailable', () => {
    const r = runDiagnosisStep(
      'exit-blockers',
      input({
        conditions: [exitCond({ code: 'native-trail-unavailable' })],
        reasonAttribution: EXIT_ATTRIBUTION,
      }),
    );

    expect(r.status).toBe('finding');
    expect(r.items.map((i) => i.code)).toEqual(['native-trail-unavailable']);
  });

  it('does not raise a finding while the protective stop has only just gone unplaced', () => {
    // One millisecond short of the window, so the report stays quiet for the tick immediately after a fresh entry, when the stop legitimately has not been placed yet.
    const r = runDiagnosisStep(
      'exit-blockers',
      input({
        conditions: [
          exitCond({
            code: 'protective-stop-unplaced',
            sinceMs: NOW - (UNPLACED_PERSIST_MS - 1),
          }),
        ],
        reasonAttribution: EXIT_ATTRIBUTION,
      }),
    );

    expect(r.status).toBe('ok');
    expect(r.items).toEqual([]);
    // Raising no item is not the same as saying nothing: the coin and its rung stay in the summary line, so the operator watching a fresh entry can still see which state it is in.
    expect(r.line).toContain('BTCUSDT');
    expect(r.line).toContain('No protective stop is resting on Binance yet for this position');
  });

  it('raises a finding once a coin has held the whole window with no protective stop resting', () => {
    // Exactly at the boundary, because the gate is inclusive: a span measured as one tick longer than the window must not fall through a strict comparison.
    const r = runDiagnosisStep(
      'exit-blockers',
      input({
        conditions: [
          exitCond({ code: 'protective-stop-unplaced', sinceMs: NOW - UNPLACED_PERSIST_MS }),
        ],
        reasonAttribution: EXIT_ATTRIBUTION,
      }),
    );

    expect(r.status).toBe('finding');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.code).toBe('protective-stop-unplaced');
    expect(r.items[0]?.sinceMs).toBe(NOW - UNPLACED_PERSIST_MS);
    expect(r.items[0]?.symbols).toEqual([
      { symbol: 'BTCUSDT', sinceMs: NOW - UNPLACED_PERSIST_MS },
    ]);
    // The duration is the whole reason this is a finding rather than noise, so it has to be readable in the evidence and not merely implied by the item existing.
    expect(r.items[0]?.evidence).toContain(`Longest-running for ${humanizeDuration(900_000)}.`);
    // And the window itself, because the same rung calls this state ordinary on every fresh entry: without the threshold on screen the operator has no way to tell why the one they are looking at is a finding, and no number to judge it against. Built from the shipped constant so the sentence cannot go on claiming a window the gate no longer uses.
    expect(r.items[0]?.evidence).toContain(
      `Raised because it has lasted more than ${humanizeDuration(PROTECTIVE_STOP_UNPLACED_PERSISTENCE_MS)}; anything shorter is the ordinary wait after a fresh entry.`,
    );
    // Pinned to the literal, not to the constant, so a shipped threshold that drifts fails here rather than silently moving every case in this file with it.
    expect(PROTECTIVE_STOP_UNPLACED_PERSISTENCE_MS).toBe(900_000);
  });

  it('counts only the coins that have crossed the window, not every coin on the code', () => {
    // A profile mid-entry on one coin and stuck on another must not have the stuck one's severity diluted, nor the fresh one dragged into the finding by sharing a code.
    const r = runDiagnosisStep(
      'exit-blockers',
      input({
        conditions: [
          exitCond({
            symbol: 'ETHUSDT',
            code: 'protective-stop-unplaced',
            sinceMs: NOW - UNPLACED_PERSIST_MS * 2,
          }),
          exitCond({
            symbol: 'SOLUSDT',
            code: 'protective-stop-unplaced',
            sinceMs: NOW - 1000,
          }),
        ],
        reasonAttribution: EXIT_ATTRIBUTION,
      }),
    );

    expect(r.status).toBe('finding');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.symbols).toEqual([
      { symbol: 'ETHUSDT', sinceMs: NOW - UNPLACED_PERSIST_MS * 2 },
    ]);
    expect(r.items[0]?.evidence).toContain('1 held coin affected.');
  });

  it('leaves a fault code raising on first sight, with no window in front of it', () => {
    // The window belongs to one code. A fault is actionable the moment it is recorded, so gating every exit item on a duration would delay the ones that were never noisy.
    const r = runDiagnosisStep(
      'exit-blockers',
      input({
        conditions: [
          exitCond({ code: 'exit-unsellable', detail: { skip: 'no-balance' }, sinceMs: NOW }),
        ],
        reasonAttribution: EXIT_ATTRIBUTION,
      }),
    );

    expect(r.status).toBe('finding');
    expect(r.items.map((i) => i.code)).toEqual(['exit-unsellable']);
    // No window admitted this one, so it must not claim one was waited out. A fault is wrong the instant it is recorded, and "raised because it lasted" would tell the operator the opposite of why it is on screen — and imply a quieter first few minutes that never existed.
    expect(r.items[0]?.evidence).not.toContainEqual(expect.stringMatching(/Raised because/));
  });

  it('still reports a fault whose row is dated slightly ahead of the reader clock', () => {
    // The row is stamped by Postgres and the span is measured against the caller's clock, so a few milliseconds of skew makes a negative age routine. A fault must never be gated on an age at all: a shared filter that let one through at "age >= 0" would drop exactly these rows, and the finding would vanish with nothing on screen saying why.
    const r = runDiagnosisStep(
      'exit-blockers',
      input({
        conditions: [
          exitCond({
            code: 'exit-unsellable',
            detail: { skip: 'no-balance' },
            sinceMs: NOW + 1000,
          }),
        ],
        reasonAttribution: EXIT_ATTRIBUTION,
      }),
    );

    expect(r.status).toBe('finding');
    expect(r.items.map((i) => i.code)).toEqual(['exit-unsellable']);
  });

  it('stays silent on a resting priced stop however long it has rested', () => {
    // A stop that IS resting is the healthy steady state and has no end: gating on duration alone rather than on the code would page the operator about every long-held guarded position.
    const r = runDiagnosisStep(
      'exit-blockers',
      input({
        conditions: [
          exitCond({
            code: 'priced-stop-resting',
            detail: { stop: '11.55' },
            sinceMs: NOW - UNPLACED_PERSIST_MS * 10,
          }),
        ],
        reasonAttribution: EXIT_ATTRIBUTION,
      }),
    );

    expect(r.status).toBe('ok');
    expect(r.items).toEqual([]);
  });

  it('serves the strategy note through to the raised item unaltered', () => {
    // The pass-through is the invariant, and it is what makes the strategy-side wording gate load-bearing: this rung never rewrites a strategy's copy, because the same string is also the symbol screen's and the backtest breakdown's explanation and two versions of it would put two answers on screen for one state. Were the pass-through to break, the strategy package's test on the note would stay green while the operator saw nothing at all — so this asserts the whole string arrives, not merely that some string did.
    const note =
      'Expected for a moment right after a new position opens, while the bot places the stop. If it is still showing minutes later, every attempt to place it is being refused and nothing on Binance would sell this position if the price fell: check whether another order is holding the coins, and whether Binance will accept a stop at the price your settings ask for.';
    const r = runDiagnosisStep(
      'exit-blockers',
      input({
        conditions: [
          exitCond({ code: 'protective-stop-unplaced', sinceMs: NOW - UNPLACED_PERSIST_MS }),
        ],
        reasonAttribution: {
          ...EXIT_ATTRIBUTION,
          'protective-stop-unplaced': {
            gloss: 'No protective stop is resting on Binance yet for this position',
            note,
          },
        },
      }),
    );

    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.detail).toBe(note);
  });

  it('leaves the explanation empty when the strategy ships no note', () => {
    // This rung carries no wording of its own, unlike the protective-stop rung below it, which does substitute a sentence when a strategy ships none. Anything this one invented would reach the operator as the strategy's own account of a state only the strategy understands. `null` is how the contract says there is none, and it is what the symbol screen and the backtest breakdown read to decide whether to draw a second line at all.
    const r = runDiagnosisStep(
      'exit-blockers',
      input({
        conditions: [
          exitCond({ code: 'protective-stop-unplaced', sinceMs: NOW - UNPLACED_PERSIST_MS }),
        ],
        reasonAttribution: {
          ...EXIT_ATTRIBUTION,
          'protective-stop-unplaced': {
            gloss: 'No protective stop is resting on Binance yet for this position',
          },
        },
      }),
    );

    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.detail).toBeNull();
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

describe('rung 11: exit protection', () => {
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
      // Not `blocked`: the profile keeps trading everything else. Not `idle-by-design` either — the position is sitting with nothing guarding it, and "idle on purpose" is the one reading that tells the operator to leave it alone.
      const i = input({ conditions: [stopBlocked()] });
      const report = buildProfileDiagnosis(i, runAll(i));

      expect(report.items.some((it) => it.condition === 'protective-stop-blocked')).toBe(true);
      expect(report.verdict).toBe('needs-attention');
    });
  });
});

describe('rung 12: which setting', () => {
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

  it('hands the withheld error to the caller so it is not lost with the line', () => {
    // The operator line drops the message on purpose. Dropping it everywhere
    // would leave a rung that throws on every run invisible in the logs too.
    const hostile = input();
    Object.defineProperty(hostile.profile, 'maxAutoSymbols', {
      get() {
        throw new Error('column missing');
      },
    });
    const seen: Array<[string, unknown]> = [];
    runDiagnosisStep('symbol-slots', hostile, (id, err) => seen.push([id, err]));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe('symbol-slots');
    expect((seen[0]?.[1] as Error).message).toBe('column missing');
  });

  it('still answers unknown when the reporter itself throws', () => {
    // The reporter is presentational. Letting it escape would reach the run-level
    // catch and fail the whole ladder, which is the outcome converting the throw
    // into `unknown` exists to prevent.
    const hostile = input();
    Object.defineProperty(hostile.profile, 'maxAutoSymbols', {
      get() {
        throw new Error('column missing');
      },
    });
    expect(
      runDiagnosisStep('symbol-slots', hostile, () => {
        throw new Error('log transport down');
      }),
    ).toEqual({ status: 'unknown', line: 'This check could not be completed.', items: [] });
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
    expect(report.items.find((it) => it.id === 'profile-disabled')?.severity).toBe('by-design');
  });

  it('stays idle-by-design when every finding is the profile working as configured', () => {
    // Two separate reasons the profile is quiet, neither of them a fault: the slot list is full and the buy guard is saying no. Nothing here asks the operator for anything, so the verdict must not. A sustained breadth block deliberately does NOT belong in this fixture: that one is reported only once the whole health window has been blocked, which is a fault the platform pages on.
    const i = input({
      profile: { ...input().profile, autoSymbolCount: 5 },
      conditions: [cond()],
    });
    const report = buildProfileDiagnosis(i, runAll(i));

    expect(report.items.length).toBeGreaterThan(1);
    expect(report.items.every((it) => it.severity === 'by-design')).toBe(true);
    expect(report.verdict).toBe('idle-by-design');
  });

  it('answers needs-attention when one real problem sits among by-design findings, and headlines the problem', () => {
    // The defect this taxonomy exists to close: a naked position outnumbered by configured-quiet findings used to read as "idle on purpose", and the by-design finding from the earlier rung owned the headline on top of it.
    const i = input({
      profile: { ...input().profile, autoSymbolCount: 5 },
      conditions: [
        cond(),
        cond({
          condition: 'protective-stop-blocked',
          symbol: 'LINKUSDT',
          code: 'price-outside-exchange-band',
        }),
      ],
    });
    const report = buildProfileDiagnosis(i, runAll(i));

    expect(report.verdict).toBe('needs-attention');
    expect(report.headline).toBe('A protective stop could not be placed');
    expect(report.items[0]?.severity).toBe('degraded');
    // Ranking is not suppression: the quiet-by-configuration findings are still there, below the one that matters.
    expect(report.items.filter((it) => it.severity === 'by-design').length).toBeGreaterThan(1);
  });

  it('still answers blocked when a blocking finding and a degraded one are both open', () => {
    // `blocked` outranks `needs-attention`: a dead engine makes the unguarded position moot until it is back.
    const i = input({
      worker: { heartbeatPresent: false },
      conditions: [
        cond({
          condition: 'protective-stop-blocked',
          symbol: 'LINKUSDT',
          code: 'price-outside-exchange-band',
        }),
      ],
    });
    const report = buildProfileDiagnosis(i, runAll(i));

    expect(report.verdict).toBe('blocked');
    expect(report.items.some((it) => it.severity === 'degraded')).toBe(true);
  });

  it('never calls a coin that has held the whole window with no resting stop idle-by-design', () => {
    // The persistence tier's whole point is that this state is ordinary for one tick and alarming a quarter of an hour later. "Idle on purpose" is the reading that tells the operator the alarming one is fine.
    const i = input({
      conditions: [
        exitCond({ code: 'protective-stop-unplaced', sinceMs: NOW - UNPLACED_PERSIST_MS }),
      ],
      reasonAttribution: EXIT_ATTRIBUTION,
    });
    const report = buildProfileDiagnosis(i, runAll(i));

    expect(report.items.some((it) => it.code === 'protective-stop-unplaced')).toBe(true);
    expect(report.verdict).toBe('needs-attention');
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

  it('renders the assetPolicy rung once a scan recorded it, in evaluation order', () => {
    const i = input({ snapshots: [snapshot({ funnel: funnel({ assetPolicy: 220 }) })] });
    const report = buildProfileDiagnosis(i, runAll(i));
    expect(report.funnel?.ticker.map((s) => s.stage)).toEqual([
      'universe',
      'quote',
      'assetPolicy',
      'blacklist',
      'liquidity',
      'activity',
      'spread',
      'changeBand',
    ]);
    expect(report.funnel?.ticker.find((s) => s.stage === 'assetPolicy')?.survivors).toBe(220);
  });

  it('offers no lever for the assetPolicy choke, because no setting can relax it', () => {
    // Every other funnel finding links to the setting that armed it. This one
    // has none: the asset's classification is Binance's, not the operator's, so
    // a "Fix this" link would promise a change that does not exist.
    const i = input({
      snapshots: [
        snapshot({ funnel: funnel({ quote: 231, assetPolicy: 0, eligible: 0, added: 0 }) }),
      ],
    });
    const r = runDiagnosisStep('candidate-funnel', i);
    expect(r.items[0]?.code).toBe('assetPolicy');
    expect(r.items[0]?.title).toBe('No coin gets past "Not a stablecoin or fiat asset"');
    expect(r.items[0]?.lever).toBeNull();
  });

  it('labels a stored-only funnel as stored', () => {
    const i = input();
    expect(buildProfileDiagnosis(i, runAll(i)).funnel?.source).toBe('stored');
  });

  it('keeps the two funnel ladders separate in the projection', () => {
    // The base fixture predates the assetPolicy stage, so its rung is OMITTED
    // rather than drawn as zero — the same rule `probed` follows. A fabricated
    // zero would show a rung where every coin died on a scan that never ran it.
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
      snapshots: [
        snapshot({ capturedAtMs: NOW - 1000 }),
        { capturedAtMs: NOW - 2000, breadthOk: undefined },
      ],
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
    const i = input({ snapshots: [preFunnelSnapshot()] });
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
