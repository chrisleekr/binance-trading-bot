import { Decimal } from '@app/money';
import { ema, sma } from '@app/indicators';
import { decOrNull } from '@app/strategy-core';
import type {
  AccountSnapshot,
  AccountSnapshotWire,
  Balance,
  Candle,
  PreviewInput,
  PreviewModel,
  PreviewRow,
  PreviewSection,
} from '@app/strategy-core';

import { coerceInt } from './config-coerce.js';
import type { MomentumConfig, MomentumState } from './schema.js';
import { extensionMaxPercent, extensionPeriod } from './extension.js';
import { resolveStopLevel } from './stop-level.js';
import { resolveEntryBudget } from './sizing.js';
import { computeEntryQuantity } from './quantity.js';

const DEFAULT_LIMIT_OFFSET = '0.98';

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
  ).stop;

  const entryRows: PreviewRow[] = [buildEntryRow(input, bandStr)];
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

  const protectiveRow = buildProtectiveStopRow(config, stopBase);
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
  const budget = resolveEntryBudget(input.config, account, input.quoteAsset ?? '');
  if ('skip' in budget) return { ...base, skip: budget.skip };
  if (input.filters === undefined) return base;
  const sized = computeEntryQuantity(budget.budget, bandStr, input.filters);
  return 'skip' in sized ? { ...base, skip: sized.skip } : { ...base, quantity: sized.quantity };
};

const buildProtectiveStopRow = (
  config: MomentumConfig,
  stopBase: Decimal | null,
): PreviewRow | null => {
  if ((config as { protectiveStop?: { enabled?: unknown } }).protectiveStop?.enabled !== true) {
    return null;
  }
  if (stopBase === null) return null;
  const offset =
    decOrNull(
      (config as { protectiveStop?: { limitOffsetPercentage?: unknown } }).protectiveStop
        ?.limitOffsetPercentage,
    ) ?? new Decimal(DEFAULT_LIMIT_OFFSET);
  if (offset.lte(0) || offset.gte(1)) return null;
  return {
    code: 'protective-stop',
    label: 'Protective stop',
    tone: 'stop',
    price: stopBase.toString(),
    limitPrice: stopBase.mul(offset).toString(),
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
