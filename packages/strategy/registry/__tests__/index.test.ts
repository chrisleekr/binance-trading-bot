import { BUNDLE_PROVIDERS, OPERATOR_ACTIONS, WsEvent, WsTopic } from '@app/contracts';
import { describe, expect, it } from 'vitest';
import { buildStrategyRegistry } from '../src/index.js';

// A schema-valid sample payload per WS topic a strategy routes an event to.
// Keyed by topic so a newly declared event whose topic has no sample fails
// loudly below, forcing the routability proof rather than silently skipping it.
const SAMPLE_PAYLOAD_BY_TOPIC: Readonly<Record<string, unknown>> = {
  'symbol-state': { symbol: 'BTCUSDT', currentPrice: '100', tsMs: 0 },
};

// Operator-action tokens that ride the Redis `override` bundle. Declaring any
// of these obliges the strategy to also list `'override'` in bundleProviders,
// else the worker would never deliver the override the action writes.
const OVERRIDE_ACTIONS = ['manual-order', 'trigger-buy', 'trigger-sell'];
// The `reset-grid` operator action clears the strategy's per-cycle state, so
// declaring it obliges the strategy to expose a `position` adapter — the
// reset-grid-trade handler drives `clearPosition({ resetGridIndex: true })`.
// `archive-grid` is pure order-domain (cancel + record) and needs no
// strategy-side capability, so it is not gated here.
const RESET_GRID_ACTION = 'reset-grid';

describe('buildStrategyRegistry', () => {
  it('registers the expected strategy set', () => {
    const r = buildStrategyRegistry();
    const names = r.list().map((s) => s.name);
    expect(names).toEqual(['trailing-trade', 'momentum', 'rebalance']);
  });

  it('returns a fresh registry on each call', () => {
    const a = buildStrategyRegistry();
    const b = buildStrategyRegistry();
    expect(a).not.toBe(b);
    expect(a.list().map((s) => s.name)).toEqual(b.list().map((s) => s.name));
  });

  it('resolves registered strategies by name', () => {
    const r = buildStrategyRegistry();
    expect(r.get('trailing-trade')?.name).toBe('trailing-trade');
    expect(r.get('momentum')?.name).toBe('momentum');
    expect(r.get('rebalance')?.name).toBe('rebalance');
    expect(r.get('unknown')).toBeUndefined();
  });

  // The "can't-lie" gate: a strategy's declared operatorActions must be a
  // closed-set subset AND must be backed by the capability each action needs.
  // Capabilities.operatorActions is typed as loose string[] (mirroring
  // bundleProviders) so a typo or an unbacked claim only surfaces here and at
  // the descriptor's z.enum — this test is that net.
  describe.each(
    buildStrategyRegistry()
      .list()
      .map((s) => [s.name, s] as const),
  )('operatorActions consistency for %s', (_name, strategy) => {
    const actions = strategy.capabilities.operatorActions;

    it('declares only tokens from the closed OPERATOR_ACTIONS set', () => {
      for (const a of actions) expect(OPERATOR_ACTIONS).toContain(a);
    });

    it('backs any override action with the override bundle provider', () => {
      if (actions.some((a) => OVERRIDE_ACTIONS.includes(a))) {
        expect(strategy.capabilities.bundleProviders).toContain('override');
      }
    });

    it('backs reset-grid with a position adapter', () => {
      if (actions.includes(RESET_GRID_ACTION)) {
        expect(strategy.position).toBeDefined();
      }
    });
  });

  // The sibling net to operatorActions: every token a strategy declares in
  // bundleProviders must be a member of the closed BUNDLE_PROVIDERS set.
  // bundleProviders is loose string[] and worker-internal (no wire z.enum), so a
  // typo would otherwise silently disable that provider (fail-open) — this test
  // is the only net that turns the typo into a loud failure.
  describe.each(
    buildStrategyRegistry()
      .list()
      .map((s) => [s.name, s] as const),
  )('bundleProviders consistency for %s', (_name, strategy) => {
    it('declares only tokens from the closed BUNDLE_PROVIDERS set', () => {
      for (const p of strategy.capabilities.bundleProviders) {
        expect(BUNDLE_PROVIDERS).toContain(p);
      }
    });
  });

  // Every declared domain event must be END-TO-END routable: its topic is a
  // member of the closed WsTopic set, and a schema-valid payload also satisfies
  // the matching WsEvent discriminated-union variant. This is the strategy-side
  // guarantee behind the worker's emit-event handler now reading the topic from
  // the strategy rather than a worker-side table. Non-vacuous exactly when a
  // strategy declares events (TT); an empty map trivially passes, which is the
  // correct outcome for a strategy that emits none.
  describe.each(
    buildStrategyRegistry()
      .list()
      .map((s) => [s.name, s] as const),
  )('events routability for %s', (_name, strategy) => {
    const entries = Object.entries(strategy.events);

    it('declares every event topic from the closed WsTopic set', () => {
      for (const [, entry] of entries) {
        expect(WsTopic.options).toContain(entry.topic);
      }
    });

    it('routes every declared event through its matching WsEvent variant', () => {
      for (const [eventType, entry] of entries) {
        const sample = SAMPLE_PAYLOAD_BY_TOPIC[entry.topic];
        expect(
          sample,
          `no sample payload registered for topic "${entry.topic}" (event "${eventType}")`,
        ).toBeDefined();
        // The sample must satisfy the strategy's own payload schema...
        expect(entry.payload.safeParse(sample).success).toBe(true);
        // ...and, in an envelope, the topic's WsEvent variant — proving the
        // (topic, payload) pair the worker emits is valid end-to-end.
        const parsed = WsEvent.safeParse({
          seq: 0,
          topic: entry.topic,
          ts: new Date(0).toISOString(),
          payload: sample,
        });
        expect(parsed.success).toBe(true);
      }
    });
  });
});
