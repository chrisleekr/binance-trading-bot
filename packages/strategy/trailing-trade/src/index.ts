import type { Strategy, StrategyEventMap } from '@app/strategy-core';
import { z } from 'zod';
import {
  defaultTTConfig,
  initialTTState,
  TTBundleSchema,
  TTConfigSchema,
  TTOverrideConfigSchema,
  TTStateSchema,
  type TTBundle,
  type TTConfig,
  type TTState,
} from './schema.js';
import { migrateTTState } from './migrate-state.js';
import { mergeTTLatchFields } from './merge-concurrent.js';
import { computeTick, indicatorMetrics } from './tick.js';
import { extractAuditEvents, extractTTAudit } from './audit-event.js';
import { trailingTradePositionAdapter } from './position-adapter.js';
import { ttReasonAttribution, ttAttributeOrder } from './attribution.js';
import { lintTTConfig } from './lint.js';
import { checkTTOrderFeasibility } from './feasibility.js';
import { ttPreviewLevels, ttPreviewDataNeeds } from './preview.js';
import { ttStopBandSettings } from './stop-level.js';

export { trailingTradePositionAdapter } from './position-adapter.js';
export { ttPreviewLevels, ttPreviewDataNeeds } from './preview.js';

// The clientOrderId scheme is this strategy's own, and `attributeOrder` is the
// only authority on which ids belong to it. Both are part of the package's public
// surface so a consumer can MINT a real id rather than hand-roll a string that
// merely looks like one — the api's orphan-adoption tests build their fixtures
// this way, so they test attribution against the actual scheme instead of a
// literal that would silently rot the day the hash or a suffix changes.
export {
  firstBuyClientOrderId,
  gridBuyClientOrderId,
  manualOrderClientOrderId,
  protectiveStopClientOrderId,
  pyramidBuyClientOrderId,
} from './client-order-id.js';
export { ttAttributeOrder } from './attribution.js';

export {
  extractAuditEvents,
  extractTTAudit,
  type TTAuditBlock,
  type TTAuditEvent,
  type TTAuditEventTechnicalsForceSell,
  type TTAuditEventTechnicalsGateVeto,
  type TTIntervalConsultation,
} from './audit-event.js';

export {
  EXIT_BLOCKER_REASONS,
  TTAutoTriggerBuySchema,
  TTBundleSchema,
  TTConfigSchema,
  TTForceBuyOverrideSchema,
  TTIndicatorGateSchema,
  TTOverrideBundleSchema,
  TTOverrideConfigSchema,
  TTStateSchema,
  type TTAutoTriggerBuy,
  type TTBundle,
  type TTConfig,
  type TTForceBuyOverride,
  type TTIndicatorGate,
  type TTOverrideBundle,
  type TTOverrideConfig,
  type TTState,
} from './schema.js';
export {
  evaluateIndicatorGate,
  type IndicatorGateResult,
  type IndicatorGateVeto,
} from './indicator-gate.js';
export {
  resolveForceSellGuards,
  type ForceSellGuardInput,
  type ForceSellGuards,
} from './force-sell-guards.js';
// The exit path builds its metric name from this union at runtime, so the set of
// `tt_*_emit` series it can produce is not readable as literals in the source.
// Exported so the observability gate can enumerate that set from the type rather
// than from a copy of it that would silently rot when a reason is added.
export type { SellEmissionReason } from './branches/sell-gate.js';

/**
 * Domain events trailing-trade emits. Each entry pairs an `emit-event`
 * `eventType` string with the WS `topic` its payload routes to and the zod
 * schema for that payload. The worker's emit-event handler reads the topic
 * from here, so this map is the sole owner of the event→topic wiring — the
 * worker keeps no parallel table.
 */
export const trailingTradeEvents = {
  'tick-snapshot': {
    topic: 'symbol-state',
    payload: z.object({
      symbol: z.string(),
      currentPrice: z.string(),
      tsMs: z.number().int().nonnegative(),
    }),
  },
} as const satisfies StrategyEventMap;

/**
 * Strategy plugin descriptor. Pure: the worker injects `Clock`/`RNG` through
 * `TickInput`, so replays reproduce ticks byte-for-byte.
 */
/** Coerce an unparsed-config leaf to a finite number, else 0. */
const finiteNum = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Candle lookback this config needs on the strategy interval. Two knobs scan a
 * candle window directly in `tick()`: the lowest-price first-buy basis reads up
 * to `buy.candleLimit` candles (only when that basis is selected), and the
 * mean-reversion gate reads `buy.meanReversionGate.lookbackCandles` (only when
 * enabled — a non-empty `entryZScoreMax`). Everything else reads carried
 * indicator state, not a raw window. Defensive: the live worker passes the
 * config unparsed.
 */
export const ttRequiredWindow = (config: TTConfig): number => {
  const c = config as {
    buy?: {
      candleLimit?: unknown;
      firstBuyTriggerBasis?: unknown;
      meanReversionGate?: { entryZScoreMax?: unknown; lookbackCandles?: unknown };
    };
  };
  const buy = c.buy;
  let need = 0;
  if (buy?.firstBuyTriggerBasis === 'lowest-price') {
    const cl = finiteNum(buy.candleLimit);
    if (cl > need) need = cl;
  }
  const mr = buy?.meanReversionGate;
  const z = mr?.entryZScoreMax;
  // entryZScoreMax === '' (or absent) disables the gate; any other value enables it.
  const mrEnabled = typeof z === 'string' ? z.trim() !== '' : z != null;
  if (mrEnabled) {
    const lb = finiteNum(mr?.lookbackCandles);
    if (lb > need) need = lb;
  }
  return need;
};

export const trailingTrade: Strategy<TTConfig, TTState, TTBundle> = {
  name: 'trailing-trade',
  version: '2.0.0',
  displayName: 'Trailing Trade',
  description: 'Grid-trade + stop-loss + Technicals gating + manual overrides.',
  capabilities: {
    // Same set the config enum accepts in schema.ts. The worker subscribes
    // to one interval per profile based on `config.candleInterval`; the
    // capability list is the universe the strategy CAN serve.
    candleIntervals: ['1m', '5m', '15m', '30m', '1h', '4h', '1d'],
    needsUserDataStream: true,
    needsMiniTicker: true,
    bundleProviders: ['technicals', 'override', 'entry-hint'],
    // TT honors the full operator-action surface: manual orders + force
    // triggers (the `override` bundle), and grid/avg-entry-price maintenance.
    operatorActions: [
      'manual-order',
      'trigger-buy',
      'trigger-sell',
      'avg-entry-price',
      'archive-grid',
      'reset-grid',
    ],
  },
  configSchema: TTConfigSchema,
  overrideConfigSchema: TTOverrideConfigSchema,
  stateSchema: TTStateSchema,
  bundleSchema: TTBundleSchema,
  events: trailingTradeEvents,
  defaultConfig: defaultTTConfig(),
  // Position-mutation capability: the worker's boot reconcilers,
  // fill-adopter, and reset-grid-trade handler converge or clear TT's
  // position through this adapter without importing TT's state schema (core
  // invariant #1). `clearPosition({ resetGridIndex: true })` is the grid-cycle
  // abandon the reset-grid-trade handler drives.
  position: trailingTradePositionAdapter,
  // Authoritative orphan-order attribution: recompute the enumerable
  // clientOrderId space so the adopt route can DERIVE the owning profile instead
  // of letting an operator hand one strategy's resting order to another. GATES
  // adoption; unenumerable ids (sell, manual) correctly return null.
  attributeOrder: ttAttributeOrder,
  // TT owns the interpretation of its own `output.events` union; the worker
  // merges whatever block this returns into the tick's audit payload without
  // knowing what a `technicals-force-sell` is (core invariant #1).
  extractAudit: extractTTAudit,
  initialState: initialTTState,
  // Per-version migration branches live in `./migrate-state.ts`. Each
  // branch performs a single hop forward; the worker loops until the
  // version matches. Unknown versions throw — feeding an unrecognised
  // state row into tick() would silently corrupt the profile.
  migrateState: migrateTTState,
  // Cross-pod CAS-miss reconcile: graft the exit-latch fields (loss-cooldown
  // anchor, force-sell re-entry deadline, scheduled re-arm) the tick stamped
  // onto the winning fill's body so a lost tick commit cannot drop them.
  // Dormant at single replica; see `./merge-concurrent.ts`.
  mergeConcurrent: mergeTTLatchFields,
  // Advisory config lint: flags settings that are silently inert or conflicting
  // (e.g. entry sizing under a grid ladder). Surfaced to the operator before a
  // save so they aren't misconfigured without knowing. Pure; see `./lint.ts`.
  lintConfig: lintTTConfig,
  // Per-symbol order feasibility: rejects a config whose orders size below the
  // symbol's exchange minimums, or whose grid the balance cannot fully fund.
  // Needs filters + price + balance, so it's separate from the pure lint above.
  checkOrderFeasibility: checkTTOrderFeasibility,
  // Lets a caller holding the symbol's filters warn at BIND time that the
  // configured stop-loss is deeper than the symbol's price band will hold,
  // instead of the operator learning it from the first tick that could not arm
  // a stop against a position already open.
  protectiveStopBandSettings: ttStopBandSettings,
  // Reason-code → config-setting attribution, so the backtest UI names the lever
  // behind each entry-blocker off this declaration (core invariant #1).
  reasonAttribution: ttReasonAttribution,
  requiredWindow: ttRequiredWindow,
  previewDataNeeds: ttPreviewDataNeeds,
  previewLevels: ttPreviewLevels,
  // Wrap computeTick so indicator gauges attach to EVERY tick outcome
  // (override, disabled, buy/sell/grid emit, terminal). computeTick has
  // many early returns; appending here once keeps the gauge series
  // gap-free without threading the metrics through each branch.
  //
  // The same seam derives typed audit events from the LogEntry stream
  // via `extractAuditEvents`. Events ride on `TickOutput.events`
  // alongside `logs` (logs are NOT removed — dashboards/Datadog filters
  // continue to read them). The empty-events case omits the field so
  // the dominant pure-path tick stays compact on the wire.
  tick: (input) => {
    const output = computeTick(input);
    const indicators = indicatorMetrics(input.market, input.config.candleInterval);
    const events = extractAuditEvents(output.logs);
    const withMetrics =
      indicators.length === 0 ? output : { ...output, metrics: [...output.metrics, ...indicators] };
    return events.length === 0 ? withMetrics : { ...withMetrics, events };
  },
};
