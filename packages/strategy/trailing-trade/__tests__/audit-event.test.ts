import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@app/strategy-core';
import { extractAuditEvents, extractTTAudit, type TTAuditEvent } from '../src/audit-event.js';

describe('extractAuditEvents', () => {
  it('returns an empty array when no logs match', () => {
    const logs: LogEntry[] = [
      { level: 'info', message: 'tt-grid-buy-emit', context: { symbol: 'BTCUSDT' } },
      { level: 'info', message: 'tt-lbp-cleared', context: { symbol: 'BTCUSDT' } },
    ];
    expect(extractAuditEvents(logs)).toEqual([]);
  });

  it('returns an empty array on empty input', () => {
    expect(extractAuditEvents([])).toEqual([]);
  });

  it('maps a tt-technicals-gate-veto log into a typed veto event', () => {
    const logs: LogEntry[] = [
      {
        level: 'info',
        message: 'tt-technicals-gate-veto',
        context: {
          reason: 'no-signal',
          interval: '1h',
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
        },
      },
    ];
    expect(extractAuditEvents(logs)).toEqual([
      {
        kind: 'technicals-gate-veto',
        reason: 'no-signal',
        interval: '1h',
        useOnlyWithinMin: 2,
        ifExpires: 'do-not-buy',
      },
    ]);
  });

  it('includes recommendation, ageMs, and intervalsConsulted on the veto event when present', () => {
    const logs: LogEntry[] = [
      {
        level: 'info',
        message: 'tt-technicals-gate-veto',
        context: {
          reason: 'signal-not-buy',
          interval: '5m',
          recommendation: 'SELL',
          ageMs: 30_000,
          useOnlyWithinMin: 2,
          ifExpires: 'do-not-buy',
          intervalsConsulted: [
            { interval: '5m', recommendation: 'SELL', verdict: 'veto' },
            { interval: '1h', recommendation: 'BUY', verdict: 'allow', advisory: true },
          ],
        },
      },
    ];
    const events = extractAuditEvents(logs);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.kind).toBe('technicals-gate-veto');
    if (e?.kind !== 'technicals-gate-veto') throw new Error('narrowed wrong');
    expect(e.recommendation).toBe('SELL');
    expect(e.ageMs).toBe(30_000);
    expect(e.intervalsConsulted).toEqual([
      { interval: '5m', recommendation: 'SELL', verdict: 'veto' },
      { interval: '1h', recommendation: 'BUY', verdict: 'allow', advisory: true },
    ]);
  });

  it('drops a veto log whose context is missing required fields', () => {
    // No `reason` or `interval` — un-mappable; we silently drop rather than
    // emit a partial event so the worker extractor never sees a half-typed
    // veto. The log itself stays on `output.logs` for pino dashboards.
    const logs: LogEntry[] = [
      { level: 'info', message: 'tt-technicals-gate-veto', context: { reason: 'bare' } },
    ];
    expect(extractAuditEvents(logs)).toEqual([]);
  });

  it('drops a malformed intervalsConsulted row but keeps the rest', () => {
    const logs: LogEntry[] = [
      {
        level: 'info',
        message: 'tt-technicals-gate-veto',
        context: {
          reason: 'no-signal',
          interval: '1h',
          intervalsConsulted: [
            { interval: '5m', verdict: 'veto', recommendation: 'SELL' },
            { interval: '1h' /* missing verdict */ },
            { interval: '4h', verdict: 'allow', recommendation: null },
          ],
        },
      },
    ];
    const events = extractAuditEvents(logs);
    if (events[0]?.kind !== 'technicals-gate-veto') throw new Error('narrowed wrong');
    expect(events[0].intervalsConsulted).toEqual([
      { interval: '5m', recommendation: 'SELL', verdict: 'veto' },
      { interval: '4h', recommendation: null, verdict: 'allow' },
    ]);
  });

  it('omits intervalsConsulted when no valid rows survive', () => {
    const logs: LogEntry[] = [
      {
        level: 'info',
        message: 'tt-technicals-gate-veto',
        context: {
          reason: 'no-signal',
          interval: '1h',
          intervalsConsulted: 'not-an-array',
        },
      },
    ];
    const events = extractAuditEvents(logs);
    if (events[0]?.kind !== 'technicals-gate-veto') throw new Error('narrowed wrong');
    expect(events[0].intervalsConsulted).toBeUndefined();
  });

  it('omits intervalsConsulted when the array is present but no row is valid', () => {
    // Array shape passes the Array.isArray guard but every row lacks the
    // required interval/verdict, so the collected list is empty → undefined.
    const logs: LogEntry[] = [
      {
        level: 'info',
        message: 'tt-technicals-gate-veto',
        context: {
          reason: 'no-signal',
          interval: '1h',
          intervalsConsulted: [{ interval: '5m' /* no verdict */ }, 'garbage', null],
        },
      },
    ];
    const events = extractAuditEvents(logs);
    if (events[0]?.kind !== 'technicals-gate-veto') throw new Error('narrowed wrong');
    expect(events[0].intervalsConsulted).toBeUndefined();
  });

  it('drops a veto log whose context is not an object', () => {
    // A non-object context (bad wire value) yields a null record, so no
    // required field can be read and the log is dropped.
    const logs: LogEntry[] = [
      { level: 'info', message: 'tt-technicals-gate-veto', context: 'not-an-object' },
    ];
    expect(extractAuditEvents(logs)).toEqual([]);
  });

  it('maps a tt-technicals-force-sell log into a typed force-sell event', () => {
    const logs: LogEntry[] = [
      {
        level: 'info',
        message: 'tt-technicals-force-sell',
        context: {
          interval: '15m',
          recommendation: 'STRONG_SELL',
          ageMs: 10_000,
          useOnlyWithinMin: 5,
        },
      },
    ];
    expect(extractAuditEvents(logs)).toEqual([
      {
        kind: 'technicals-force-sell',
        interval: '15m',
        recommendation: 'STRONG_SELL',
        ageMs: 10_000,
        useOnlyWithinMin: 5,
      },
    ]);
  });

  it('drops a force-sell log whose context lacks interval or recommendation', () => {
    const logs: LogEntry[] = [
      {
        level: 'info',
        message: 'tt-technicals-force-sell',
        context: { interval: '15m' /* missing recommendation */ },
      },
    ];
    expect(extractAuditEvents(logs)).toEqual([]);
  });

  it('preserves log order across mixed event kinds', () => {
    const logs: LogEntry[] = [
      {
        level: 'info',
        message: 'tt-technicals-force-sell',
        context: { interval: '15m', recommendation: 'STRONG_SELL' },
      },
      {
        level: 'info',
        message: 'tt-technicals-gate-veto',
        context: { reason: 'no-signal', interval: '1h' },
      },
    ];
    const events = extractAuditEvents(logs);
    expect(events.map((e) => e.kind)).toEqual(['technicals-force-sell', 'technicals-gate-veto']);
  });
});

// `extractTTAudit` is TT's `Strategy.extractAudit` implementation. It replaced a
// structural mirror of this union that used to live in the worker, where a
// renamed field would have degraded silently to `undefined`. Here the union is
// the real type, so a rename is a compile error instead.
describe('extractTTAudit', () => {
  const forceSell = (extra: Record<string, unknown> = {}): TTAuditEvent =>
    ({
      kind: 'technicals-force-sell',
      interval: '15m',
      recommendation: 'STRONG_SELL',
      ...extra,
    }) as TTAuditEvent;

  it('returns undefined on the pure-path tick (no events)', () => {
    expect(extractTTAudit([])).toBeUndefined();
  });

  it('returns undefined when no force-sell fired', () => {
    const veto: TTAuditEvent = {
      kind: 'technicals-gate-veto',
      reason: 'no-signal',
      interval: '1h',
    };
    expect(extractTTAudit([veto])).toBeUndefined();
  });

  it('surfaces the force-sell under a strategy-namespaced key', () => {
    expect(extractTTAudit([forceSell()])).toEqual({
      technicals: { forceSell: { interval: '15m', recommendation: 'STRONG_SELL' } },
    });
  });

  it('carries the optional freshness fields when present', () => {
    expect(
      extractTTAudit([forceSell({ ageMs: 1200, useOnlyWithinMin: 2 })])?.technicals.forceSell,
    ).toEqual({
      interval: '15m',
      recommendation: 'STRONG_SELL',
      ageMs: 1200,
      useOnlyWithinMin: 2,
    });
  });

  it('omits optional fields rather than emitting undefined values', () => {
    const block = extractTTAudit([forceSell()]);
    expect(Object.keys(block!.technicals.forceSell)).toEqual(['interval', 'recommendation']);
  });

  it('takes the first force-sell — a tick emits at most one', () => {
    const first = forceSell({ interval: '5m' });
    const second = forceSell({ interval: '1h' });
    expect(extractTTAudit([first, second])?.technicals.forceSell.interval).toBe('5m');
  });

  it('ignores foreign values in the slice without throwing', () => {
    expect(extractTTAudit([null, 42, 'x', { kind: 'other' }])).toBeUndefined();
  });
});
