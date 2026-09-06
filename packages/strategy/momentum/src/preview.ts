import { Decimal } from '@app/money';
import { ema, sma } from '@app/indicators';
import {
  decOrNull,
  nativeTrailDistanceSentence,
  nativeTrailingDelta,
  nativeTrailPreviewNote,
} from '@app/strategy-core';
import type {
  AccountSnapshot,
  AccountSnapshotWire,
  Balance,
  Candle,
  PreviewInput,
  PreviewModel,
  PreviewRow,
  PreviewSection,
  TrailingDeltaFilter,
} from '@app/strategy-core';

import { coerceInt } from './config-coerce.js';
import type { MomentumConfig, MomentumState } from './schema.js';
import { extensionMaxPercent, extensionPeriod } from './extension.js';
import { resolveStopLevel } from './stop-level.js';
import { DEFAULT_LIMIT_OFFSET } from './protective-stop.js';
import { resolveEntryBudget } from './sizing.js';
import { computeEntryQuantity, entryStopFloor } from './quantity.js';

/**
 * Revive a wire account (decimal-string balances) to the Decimal
 * {@link AccountSnapshot} `resolveEntryBudget` reads. Skips a balance whose free
 * or locked will not parse — a malformed balance drops out rather than throwing.
 */
const reviveAccount = (wire: AccountSnapshotWire | undefined): AccountSnapshot => {
  const balances: Record<string, Balance> = {};
  for (const [asset, b] of Object.entries(wire?.balances ?? {})) {
    const free = decOrNull(b.free);
    const locked = decOrNull(b.locked);
    if (free === null || locked === null) continue;
    balances[asset] = { asset, free, locked };
  }
  return {
    balances,
    // A preview account is built from the wire snapshot the SPA holds, not a
    // failed exchange read; treat it as readable so an empty wallet is a known
    // zero rather than UNKNOWN.
    readable: true,
    ...(wire?.deployedQuoteAcrossProfiles !== undefined
      ? { deployedQuoteAcrossProfiles: wire.deployedQuoteAcrossProfiles }
      : {}),
  };
};

/** Entry confirmation margin as a non-negative Decimal — mirrors the tick's `entryMargin`. */
const entryMargin = (config: MomentumConfig): Decimal => {
  const m = decOrNull((config as { entryMarginPct?: unknown }).entryMarginPct);
  return m === null || m.lt(0) ? new Decimal(0) : m;
};

const closedCandles = (candles: readonly Candle[] | undefined): readonly Candle[] =>
  (candles ?? []).filter((c) => c.isClosed);

const movingAverage = (
  maType: unknown,
  candles: readonly Candle[],
  period: number,
): Decimal | null => {
  if (candles.length < period || period < 1) return null;
  try {
    return maType === 'ema' ? ema(candles, period) : sma(candles, period);
  } catch {
    return null;
  }
};

/**
 * Project momentum's decision levels for the operator's pre-trade view and the
 * drift gate. Pure, Decimal-only; reads the config DEFENSIVELY (the live worker
 * may pass it unparsed) and never throws.
 *
 * State-aware trigger: the entry band is a trigger only while FLAT (an entry
 * cannot fire on an open position). The trailing stop and the exchange-side
 * protective stop are shown as PROJECTIONS (`trigger` unset): both are managed
 * order-arms that re-arm every held tick regardless of where price sits, not a
 * one-shot price cross, so marking them triggers would misdescribe when they
 * act. The macro trend line is an informational neutral row.
 */
export const momentumPreviewLevels = (
  input: PreviewInput<MomentumConfig, MomentumState>,
): PreviewModel => {
  const { config } = input;
  const flat = input.state === null || input.state.entryPrice === null;
  const candles = closedCandles(input.candles);

  const slow = coerceInt((config as { ema?: { slow?: unknown } }).ema?.slow, {
    min: 1,
    fallback: 0,
  });
  const slowEma = movingAverage('ema', candles, slow);
  if (slowEma === null) return { sections: [] };

  const band = slowEma.mul(new Decimal(1).plus(entryMargin(config)));
  const bandStr = band.toString();

  // The exit trail measures from the position high when held, or from the
  // projected entry band when flat (where the trail would first sit).
  const heldHigh =
    input.state === null ? null : decOrNull(input.state.highSinceEntry ?? input.entryPrice);
  const refHigh = flat ? band : (heldHigh ?? band);

  // One resolver for all three consumers — the in-process trail, the resting
  // protective stop, and this projection — so they cannot report different
  // numbers. The profit leg is position-only: it reads the mark the tick
  // PERSISTED rather than re-ratcheting it, because a preview carries no 1m
  // window and inventing one would show a level the worker never acted on.
  const heldEntry = decOrNull(input.state?.entryPrice ?? input.entryPrice);
  const stopBase = resolveStopLevel(
    config,
    heldEntry ?? refHigh,
    refHigh,
    flat ? null : decOrNull(input.state?.profitHigh),
    candles,
    // The clamp must run here too: the replay drift gate throws for any tick
    // where the emitted level cleared a preview row the projection left
    // unclamped, so skipping it is a hard failure, not a cosmetic mismatch.
    { reference: input.currentPrice, band: input.filters?.percentPriceBySide },
    // A preview projects from config and candles alone; it never sees live open orders, so it cannot pin against a resting order's stop price.
    null,
  ).stop;

  const entryRows: PreviewRow[] = [buildEntryRow(input, bandStr, candles)];
  if (stopBase !== null) {
    entryRows.push({
      code: 'trail',
      label: 'Trailing stop',
      tone: 'trail',
      price: stopBase.toString(),
      triggerWhen: 'below',
      chartLine: true,
    });
  }

  const sections: PreviewSection[] = [{ title: 'Entry', rows: entryRows }];

  const protectiveRow = buildProtectiveStopRow(input, stopBase);
  const trendRow = buildTrendRow(config, candles);
  const extensionRow = buildExtensionRow(config, candles);
  const exitRows: PreviewRow[] = [];
  if (protectiveRow !== null) exitRows.push(protectiveRow);
  if (trendRow !== null) exitRows.push(trendRow);
  if (extensionRow !== null) exitRows.push(extensionRow);
  if (exitRows.length > 0) sections.push({ title: 'Exit & guards', rows: exitRows });

  return { sections };
};

const buildEntryRow = (
  input: PreviewInput<MomentumConfig, MomentumState>,
  bandStr: string,
  candles: readonly Candle[],
): PreviewRow => {
  // The entry band is where the fast EMA must cross, not a `currentPrice`
  // threshold: the tick fires on `fastEMA > slowEMA*band` off closed candles,
  // and enters at market. currentPrice need not be above the band when it fires
  // (a post-close dip still crosses), so this row is a projection, never a
  // drift-gate trigger. Marking it `trigger` would false-fail the replay gate.
  const base: PreviewRow = {
    code: 'entry',
    label: 'Entry band',
    tone: 'entry',
    price: bandStr,
    chartLine: true,
  };
  const account = reviveAccount(input.account);
  // The caller's already-closed window, passed down rather than recomputed, so the risk cap sizes this row off exactly the closed window the stop and guard rows are built from.
  const budget = resolveEntryBudget(input.config, account, input.quoteAsset ?? '', {
    price: bandStr,
    candles,
  });
  if ('skip' in budget) return { ...base, skip: budget.skip };
  if (input.filters === undefined) return base;
  const sized = computeEntryQuantity(
    budget.budget,
    bandStr,
    input.filters,
    entryStopFloor(input.config, candles, bandStr),
  );
  return 'skip' in sized ? { ...base, skip: sized.skip } : { ...base, quantity: sized.quantity };
};

interface RawProtectiveStop {
  readonly enabled?: unknown;
  readonly mode?: unknown;
  readonly limitOffsetPercentage?: unknown;
  readonly onBandBlock?: unknown;
}

/**
 * Operator-facing line for a stop that rests as a trail because the profile ASKED for one, or null when no such order can be built and a priced stop is what will rest.
 *
 * The shared band-escape note cannot answer this case: it reports on a trail SUBSTITUTED for a band-refused priced stop, so it returns null whenever the band would have accepted that stop — the ordinary case for an order that was never priced to begin with. Only the reachability test differs, so this reimplements that and defers to the shared sentence for the wording, which is what keeps the two preview surfaces describing one resting order the same way.
 *
 * The distance quoted is the CONFIGURED retrace read back OUT of the basis-point delta, so the row cannot claim a distance the exchange was never given. Reading it out of the delta is also why the null answer is the right fallback: a symbol publishing no usable `TRAILING_DELTA` bounds is exactly the case where the arm abandons the trail and prices the stop instead.
 *
 * @param config - The possibly unparsed momentum config supplying the configured retrace fraction.
 * @param trailing - The symbol's published trailing-delta bounds, or undefined when the preview carries no filters.
 * @returns The sentence naming the distance, or null when the priced stop is what the arm will rest.
 */
const primaryNativeTrailNote = (
  config: MomentumConfig,
  trailing: TrailingDeltaFilter | undefined,
): string | null => {
  // The configured fraction, not the live ATR or profit leg, for the same reason the shared band settings quote it: the delta is sized from this fraction alone, and one re-derived per tick would cancel and re-place the order on every ATR reading, restarting the exchange high-water mark the trail exists to track.
  const stopDistancePct = decOrNull(config.trailingStopPct);
  if (stopDistancePct === null) return null;
  const delta = nativeTrailingDelta({ stopDistancePct, filter: trailing });
  if (delta === null) return null;
  return nativeTrailDistanceSentence(delta);
};

const buildProtectiveStopRow = (
  input: PreviewInput<MomentumConfig, MomentumState>,
  stopBase: Decimal | null,
): PreviewRow | null => {
  const ps = (input.config as { protectiveStop?: RawProtectiveStop }).protectiveStop;
  if (ps?.enabled !== true) return null;
  if (stopBase === null) return null;

  // A profile in `native-trail` mode rests a trail on every tick, not only on a band refusal, and that order carries a quantity and a delta and nothing else. Drawn as a priced row it would put a fixed trigger and a limit price on the symbol screen and a line on the chart, none of which the resting order holds. Judged BEFORE the limit offset is read because a trail has no limit leg to offset: an unparseable offset must not suppress a row for an order that goes out regardless.
  if (ps.mode === 'native-trail') {
    const note = primaryNativeTrailNote(input.config, input.filters?.trailingDelta);
    // Null means no native order can be built, which is the same condition under which the arm falls back to pricing the stop — so the priced row below is then the honest one.
    if (note !== null) {
      return {
        code: 'protective-stop',
        label: 'Protective stop (exchange trail)',
        tone: 'stop',
        note,
      };
    }
  }

  // Default applied INSIDE the read, so only an absent key falls back. An
  // unparseable one reads as null here exactly as it does in the arm, which
  // returns no level at all: defaulting it would draw a row for a stop that
  // never goes out.
  const offset = decOrNull(ps.limitOffsetPercentage ?? DEFAULT_LIMIT_OFFSET);
  if (offset === null || offset.lte(0) || offset.gte(1)) return null;
  const limit = stopBase.mul(offset);

  // Under `native-trail` a stop the band refuses goes out as a trailing
  // STOP_LOSS, which has NO trigger price at all — the exchange derives one from
  // a high-water mark that starts at placement. Printing the configured level
  // would name a price nothing acts on, so the row carries a sentence instead.
  if (ps.onBandBlock === 'native-trail') {
    // The CONFIGURED distance, matching what the arm hands Binance — a distance
    // re-measured against the live price would print a percentage the resting
    // order does not carry. An unparseable one leaves the profit trail as the
    // only leg holding the stop, and no distance to hand Binance means no trail:
    // the row falls through to the priced level the arm will actually send,
    // exactly as it does when the symbol publishes no usable trailing bounds.
    const stopDistancePct = decOrNull(input.config.trailingStopPct);
    const note =
      stopDistancePct === null
        ? null
        : nativeTrailPreviewNote({
            stop: stopBase,
            limit,
            tick: decOrNull(input.filters?.tickSize),
            reference: input.currentPrice,
            stopDistancePct,
            band: input.filters?.percentPriceBySide,
            trailing: input.filters?.trailingDelta,
          });
    if (note !== null) {
      return {
        code: 'protective-stop',
        label: 'Protective stop (exchange trail)',
        tone: 'stop',
        note,
      };
    }
  }

  return {
    code: 'protective-stop',
    label: 'Protective stop',
    tone: 'stop',
    price: stopBase.toString(),
    limitPrice: limit.toString(),
    triggerWhen: 'below',
    chartLine: true,
  };
};

const buildTrendRow = (config: MomentumConfig, candles: readonly Candle[]): PreviewRow | null => {
  const tf = (
    config as {
      trendFilter?: { enabled?: unknown; maType?: unknown; period?: unknown };
    }
  ).trendFilter;
  if (tf?.enabled !== true) return null;
  const period = coerceInt(tf.period, { min: 1, fallback: 200 });
  const line = movingAverage(tf.maType, candles, period);
  if (line === null) return null;
  return { code: 'trend', label: 'Trend line', tone: 'neutral', price: line.toString() };
};

/**
 * The overextension ceiling: baseline MA raised by `maxPercent`. An entry that
 * would cross while price sits above this line is skipped. Informational (no
 * chartLine, mirroring the trend row): a projected ceiling, not a managed order.
 * Null only when the guard is off or the window is too short for the baseline.
 * Uses the shared {@link extensionPeriod} / {@link extensionMaxPercent}
 * coercion, so the projected ceiling is exactly the one the tick enforces even
 * when the live worker passes an unparsed or malformed config.
 */
const buildExtensionRow = (
  config: MomentumConfig,
  candles: readonly Candle[],
): PreviewRow | null => {
  const ext = (
    config as {
      entryExtension?: {
        enabled?: unknown;
        maType?: unknown;
        period?: unknown;
        maxPercent?: unknown;
      };
    }
  ).entryExtension;
  if (ext?.enabled !== true) return null;
  const line = movingAverage(ext.maType, candles, extensionPeriod(ext.period));
  if (line === null) return null;
  const ceiling = line.mul(new Decimal(1).plus(extensionMaxPercent(ext.maxPercent)));
  return {
    code: 'overextended',
    label: 'Max entry extension',
    tone: 'neutral',
    price: ceiling.toString(),
  };
};

/** Momentum reads only the tick candle window; the preview needs no extra history. */
export const momentumPreviewDataNeeds = (
  _config: MomentumConfig,
): readonly { readonly interval: string; readonly frames: number }[] => [];
