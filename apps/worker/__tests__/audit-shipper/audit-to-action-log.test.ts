import { describe, expect, it } from 'vitest';
import { asProfileId, asUserId } from '@app/contracts';
import type { AuditEntry } from '../../src/audit-shipper/audit-shipper.js';
import {
  auditEntriesToActionLogs,
  isActionableAudit,
} from '../../src/audit-shipper/audit-to-action-log.js';

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  userId: asUserId('11111111-1111-1111-1111-111111111111'),
  profileId: asProfileId('22222222-2222-2222-2222-222222222222'),
  ts: 1_700_000_000_000,
  symbol: 'BTCUSDT',
  event: 'tick',
  latencyMs: 5,
  decisionTypes: ['noop'],
  clientOrderIds: [],
  payload: {},
  ...over,
});

describe('isActionableAudit', () => {
  it('is false for a plain noop tick', () => {
    expect(isActionableAudit(entry())).toBe(false);
  });

  it('is true when an order was placed or cancelled', () => {
    expect(isActionableAudit(entry({ decisionTypes: ['place-order'] }))).toBe(true);
    expect(isActionableAudit(entry({ decisionTypes: ['cancel-order'] }))).toBe(true);
  });

  it('is true when the technicals block recorded a force-sell', () => {
    expect(
      isActionableAudit(
        entry({
          payload: { technicals: { forceSell: { interval: '1m', recommendation: 'SELL' } } },
        }),
      ),
    ).toBe(true);
  });

  it('is FALSE for a buy-gate veto block alone (de-spam: the on-change entry-blocker log replaces it)', () => {
    // A per-tick gate veto carries only `technicals.veto` and no order decision.
    // It used to become an action_log every tick; now the on-change entry-blocker
    // write owns that, so a veto-only audit is no longer feed-worthy.
    expect(
      isActionableAudit(
        entry({ payload: { technicals: { veto: { reason: 'technicals-sell' } } } }),
      ),
    ).toBe(false);
  });

  it('ignores non-actionable decision types alone', () => {
    expect(isActionableAudit(entry({ decisionTypes: ['emit-event'] }))).toBe(false);
  });

  it('keeps a force-sell entry even though it also carries an order decision', () => {
    // A force-sell co-emits a SELL place-order, so the order clause keeps it too;
    // the forceSell marker is belt-and-braces for a future no-order force-sell.
    expect(
      isActionableAudit(
        entry({
          decisionTypes: ['place-order'],
          payload: { technicals: { forceSell: { interval: '1m', recommendation: 'SELL' } } },
        }),
      ),
    ).toBe(true);
  });
});

// Shorthand for the executor's per-decision outcomes carried on the audit
// payload. A failed outcome may carry the classifier's `reason` (Binance code +
// message); success outcomes omit it.
const results = (
  ...rs: { type: string; ok: boolean; reason?: string }[]
): Record<string, unknown> => ({
  results: rs,
});

describe('auditEntriesToActionLogs', () => {
  it('drops noop ticks and keeps actionable ones', () => {
    const rows = auditEntriesToActionLogs([
      entry(),
      entry({
        symbol: 'ETHUSDT',
        decisionTypes: ['place-order'],
        clientOrderIds: ['c1'],
        payload: results({ type: 'place-order', ok: true }),
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      profileId: '22222222-2222-2222-2222-222222222222',
      symbol: 'ETHUSDT',
      level: 'info',
      msg: 'ETHUSDT: placed 1 order(s)',
    });
    expect(rows[0]?.time).toEqual(new Date(1_700_000_000_000));
  });

  it('summarises mixed place + cancel that both succeeded and carries context', () => {
    const [row] = auditEntriesToActionLogs([
      entry({
        decisionTypes: ['place-order', 'cancel-order'],
        clientOrderIds: ['c1'],
        payload: results({ type: 'place-order', ok: true }, { type: 'cancel-order', ok: true }),
      }),
    ]);
    expect(row?.msg).toBe('BTCUSDT: placed 1 and cancelled 1 order(s)');
    expect(row?.level).toBe('info');
    expect(row?.ctx).toMatchObject({
      event: 'tick',
      decisionTypes: ['place-order', 'cancel-order'],
      results: [
        { type: 'place-order', ok: true },
        { type: 'cancel-order', ok: true },
      ],
      clientOrderIds: ['c1'],
      latencyMs: 5,
    });
  });

  it('counts only successful outcomes and names failures, raising the row to warn (#461)', () => {
    // The #451 cancel-replace chase: the cancel wedged (not found locally) and
    // the place never took effect; the summary must not claim a placement.
    const [row] = auditEntriesToActionLogs([
      entry({
        decisionTypes: ['cancel-order', 'place-order'],
        payload: results({ type: 'cancel-order', ok: false }, { type: 'place-order', ok: false }),
      }),
    ]);
    expect(row?.msg).toBe('BTCUSDT: 2 order action(s) failed, none succeeded');
    expect(row?.level).toBe('warn');
  });

  it('carries the failure reason into ctx.results so triage sees why it failed', () => {
    // The reason (Binance code + message) is the diagnostic that lets an
    // operator read WHY an order action failed straight from action_logs
    // instead of reconstructing it from the exchange.
    const [row] = auditEntriesToActionLogs([
      entry({
        decisionTypes: ['place-order'],
        payload: results({
          type: 'place-order',
          ok: false,
          reason: 'binance logic -1013: Filter failure: PRICE_FILTER',
        }),
      }),
    ]);
    expect(row?.level).toBe('warn');
    const ctxResults = (row?.ctx as { results: { reason?: string }[] }).results;
    expect(ctxResults[0]?.reason).toBe('binance logic -1013: Filter failure: PRICE_FILTER');
  });

  it("a failed order's reason rides into msg, not just into ctx", () => {
    // "1 order action failed" tells the operator nothing on its own — it sends
    // them digging through logs for a reason the executor already knew. The feed
    // renders `msg`; the reason has to be IN it.
    const [row] = auditEntriesToActionLogs([
      entry({
        decisionTypes: ['place-order'],
        payload: results({
          type: 'place-order',
          ok: false,
          reason: 'binance logic -2010: insufficient balance',
        }),
      }),
    ]);
    expect(row?.msg).toBe(
      'BTCUSDT: 1 order action(s) failed, none succeeded — binance logic -2010: insufficient balance',
    );
  });

  it('carries the reason alongside what did succeed, and caps a runaway one', () => {
    const long = `binance logic -1013: ${'x'.repeat(300)}`;
    const [row] = auditEntriesToActionLogs([
      entry({
        decisionTypes: ['place-order', 'cancel-order'],
        payload: results(
          { type: 'place-order', ok: true },
          { type: 'cancel-order', ok: false, reason: long },
        ),
      }),
    ]);
    expect(row?.msg.startsWith('BTCUSDT: placed 1 order(s), 1 failed — binance logic -1013:')).toBe(
      true,
    );
    // One Binance error must not bury the row.
    expect(row?.msg.length).toBeLessThan(180);
    expect(row?.msg.endsWith('…')).toBe(true);
  });

  it('a failure with NO reason never renders "undefined"', () => {
    // `DecisionResult` allows a reason-less failure and the malformed-payload path
    // produces one. The line has to stay readable without it.
    const [row] = auditEntriesToActionLogs([
      entry({
        decisionTypes: ['place-order'],
        payload: results({ type: 'place-order', ok: false }),
      }),
    ]);
    expect(row?.msg).toBe('BTCUSDT: 1 order action(s) failed, none succeeded');
    expect(row?.msg).not.toContain('undefined');
  });

  it('names the failed count alongside what actually succeeded', () => {
    const [row] = auditEntriesToActionLogs([
      entry({
        decisionTypes: ['place-order', 'cancel-order'],
        payload: results({ type: 'place-order', ok: true }, { type: 'cancel-order', ok: false }),
      }),
    ]);
    expect(row?.msg).toBe('BTCUSDT: placed 1 order(s), 1 failed');
    expect(row?.level).toBe('warn');
  });

  it('drops a buy-gate-veto-only entry (per-tick spam now handled by the entry-blocker log)', () => {
    expect(
      auditEntriesToActionLogs([
        entry({ payload: { technicals: { veto: { reason: 'technicals-sell' } } } }),
      ]),
    ).toEqual([]);
  });

  it('labels a force-sell entry (no co-recorded order) as a no-order gate evaluation and embeds the block', () => {
    // Belt-and-braces path: a force-sell marker with no order result still becomes
    // a row, and the technicals block rides in ctx.
    const fs = { forceSell: { interval: '1m', recommendation: 'SELL' } };
    const [row] = auditEntriesToActionLogs([entry({ payload: { technicals: fs } })]);
    expect(row?.msg).toBe('BTCUSDT: technicals gate evaluated, no order placed');
    expect(row?.level).toBe('info');
    expect((row?.ctx as { technicals: unknown }).technicals).toEqual(fs);
  });

  it('summarises a place-only entry that succeeded', () => {
    const [row] = auditEntriesToActionLogs([
      entry({
        decisionTypes: ['place-order'],
        payload: results({ type: 'place-order', ok: true }),
      }),
    ]);
    expect(row?.msg).toBe('BTCUSDT: placed 1 order(s)');
    expect(row?.level).toBe('info');
  });

  it('summarises a cancel-only entry that succeeded', () => {
    const [row] = auditEntriesToActionLogs([
      entry({
        decisionTypes: ['cancel-order'],
        payload: results({ type: 'cancel-order', ok: true }),
      }),
    ]);
    expect(row?.msg).toBe('BTCUSDT: cancelled 1 order(s)');
  });

  it('does not throw and emits a neutral line when an actionable entry has malformed results', () => {
    // Defensive boundary: the producer always stamps a matching results array
    // (tick-handler), but if that invariant ever broke, the drainer must not
    // throw nor mislabel the row as a technicals-gate evaluation.
    const [row] = auditEntriesToActionLogs([
      entry({ decisionTypes: ['place-order'], payload: { results: 'not-an-array' } }),
    ]);
    expect(row?.msg).toBe('BTCUSDT: no order outcome recorded');
    expect(row?.level).toBe('info');
    expect((row?.ctx as { results: unknown }).results).toEqual([]);
  });

  it('returns an empty array when nothing is actionable', () => {
    expect(auditEntriesToActionLogs([entry(), entry({ decisionTypes: ['noop'] })])).toEqual([]);
  });
});
