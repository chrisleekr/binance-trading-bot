import { Decimal } from '@app/money';
import { decOrNull } from '@app/strategy-core';
import type {
  Candle,
  PreviewInput,
  PreviewModel,
  PreviewRow,
  PreviewSection,
} from '@app/strategy-core';

import type { TTConfig, TTState } from './schema.js';
import { REGIME_INTERVAL } from './branches/regime-filter.js';
import { classifyRegimeFromDaily } from './branches/regime.js';

interface RawGridLevel {
  readonly triggerPercentage?: unknown;
  readonly maxPurchaseAmount?: unknown;
}

/**
 * Chained grid-ladder projection — a fresh Decimal port of the web
 * `projectGridLadder` calculator. Rung 0 fills at `entryPrice`; each later rung
 * chains `prevFill * triggerPercentage[N]`; per-rung base is
 * `maxPurchaseAmount / fill`, and the running average cost is `cumQuote /
 * cumBase`. An APPROXIMATION of the executor (which fires rung N off the real
 * avgEntryPrice), so the rungs are shown as informational (`trigger` unset), NOT
 * price triggers the drift gate keys on. Returns [] on a non-positive entry
 * price or any level with absent / non-positive fields.
 */
const projectLadder = (config: TTConfig, entryPrice: Decimal): PreviewRow[] => {
  const levels = (config as { buy?: { gridLevels?: unknown } }).buy?.gridLevels;
  if (!Array.isArray(levels) || levels.length === 0) return [];
  const rows: PreviewRow[] = [];
  let prevFill = entryPrice;
  let cumQuote = new Decimal(0);
  let cumBase = new Decimal(0);
  for (let i = 0; i < levels.length; i += 1) {
    const lvl = levels[i] as RawGridLevel | undefined;
    if (lvl === undefined) return [];
    const quoteSpent = decOrNull(lvl.maxPurchaseAmount);
    if (quoteSpent === null || quoteSpent.lte(0)) return [];
    let fillPrice: Decimal;
    if (i === 0) {
      fillPrice = entryPrice;
    } else {
      const trig = decOrNull(lvl.triggerPercentage);
      if (trig === null || trig.lte(0)) return [];
      fillPrice = prevFill.mul(trig);
    }
    const baseQty = quoteSpent.div(fillPrice);
    cumQuote = cumQuote.add(quoteSpent);
    cumBase = cumBase.add(baseQty);
    rows.push({
      code: 'grid-buy',
      label: `Buy #${i + 1}`,
      tone: 'buy',
      price: fillPrice.toString(),
      quantity: baseQty.toString(),
      // Rung 0 is the entry fill, already the current-price reference; only the
      // averaging-down rungs (i >= 1) draw as distinct chart lines.
      ...(i >= 1 ? { chartLine: true as const } : {}),
    });
    prevFill = fillPrice;
  }
  // A completed loop always ran >= 1 level (an empty ladder returned above) and
  // every base is positive, so cumBase > 0 here.
  rows.push({
    code: 'avg-cost',
    label: 'Average cost',
    tone: 'neutral',
    price: cumQuote.div(cumBase).toString(),
  });
  return rows;
};

/**
 * Operator-facing line for a configured-but-unarmed trailing stop. Names the
 * price that brings the trail into existence (the sell arm) and the give-back it
 * will then allow, so a level-less row still answers "what is this waiting for".
 */
const unarmedTrailNote = (trailPct: Decimal, sellArm: Decimal | null): string => {
  const giveBack = new Decimal(1).minus(trailPct).mul(100).toString();
  const armsAt = sellArm === null ? 'the first new high' : sellArm.toString();
  return `Not armed yet — arms at ${armsAt}, then exits ${giveBack}% below the peak`;
};

/**
 * Sell-side levels — a Decimal port of the web `deriveSignal` math. `lbp` is the
 * average entry price. The stop-loss is the ONE gate-trigger: it fires precisely
 * at `lbp * stopLossPercentage` off the stable cost basis and carries the exact
 * `grid-stop-loss` intent reason, so an emitted stop-loss is always on the row's
 * side. The sell-arm and the trailing stop are shown as projections (`trigger`
 * unset): the trailing exit re-arms off a `highSinceBuy` the tick may ratchet
 * intra-tick and the `grid-sell` reason is shared by the ATR path at a different
 * level, so triggering them could disagree with a real exit.
 */
const projectSells = (config: TTConfig, state: TTState | null, lbp: Decimal): PreviewRow[] => {
  const sell = (
    config as {
      sell?: {
        triggerPercentage?: unknown;
        stopLossPercentage?: unknown;
        trailingStopPercentage?: unknown;
      };
    }
  ).sell;
  const held = state !== null && decOrNull(state.avgEntryPrice) !== null;
  const rows: PreviewRow[] = [];

  const trigger = decOrNull(sell?.triggerPercentage);
  const sellArm = trigger !== null && trigger.gt(1) ? lbp.mul(trigger) : null;
  if (sellArm !== null) {
    rows.push({
      code: 'technicals-force-sell',
      label: 'Sell arm',
      tone: 'sell',
      price: sellArm.toString(),
      triggerWhen: 'above',
      chartLine: true,
    });
  }

  const stopPct = decOrNull(sell?.stopLossPercentage);
  if (stopPct !== null && stopPct.gt(0) && stopPct.lte(1)) {
    rows.push({
      code: 'grid-stop-loss',
      label: 'Stop-loss',
      tone: 'stop',
      price: lbp.mul(stopPct).toString(),
      triggerWhen: 'below',
      chartLine: true,
      ...(held ? { trigger: true as const } : {}),
    });
  }

  const trailPct = decOrNull(sell?.trailingStopPercentage);
  if (trailPct !== null && trailPct.gt(0) && trailPct.lte(1)) {
    // The trail measures off `highSinceBuy`, which the sell gate only sets once
    // price first reaches the sell arm. Until then no trailing exit exists at ANY
    // price, so the row names no level: a projection off the arm or off the cost
    // basis would sit BELOW the arm, where price crosses it routinely, and read as
    // a trailing stop the bot hit and ignored.
    const positionHigh = state === null ? null : decOrNull(state.highSinceBuy);
    rows.push({
      code: 'grid-sell',
      label: 'Trailing stop',
      tone: 'trail',
      triggerWhen: 'below',
      ...(positionHigh !== null
        ? { price: positionHigh.mul(trailPct).toString(), chartLine: true as const }
        : { note: unarmedTrailNote(trailPct, sellArm) }),
    });
  }
  return rows;
};

interface RawRegime {
  readonly ma?: unknown;
  readonly period?: unknown;
  readonly confirmBars?: unknown;
  readonly exposure?: { readonly enabled?: unknown };
  readonly onBear?: {
    readonly exitToCash?: unknown;
    readonly blockEntry?: unknown;
    readonly suppressPromotion?: unknown;
    readonly rearm?: { readonly enabled?: unknown };
  };
  readonly onBull?: {
    readonly hold?: { readonly enabled?: unknown; readonly room?: unknown };
    readonly pyramid?: {
      readonly enabled?: unknown;
      readonly stepPercentage?: unknown;
      readonly maxAdds?: unknown;
    };
    readonly requireEntry?: unknown;
  };
}

const readRegime = (config: TTConfig): RawRegime | null => {
  const regime = (config as { regime?: unknown }).regime;
  if (regime === null || typeof regime !== 'object') return null;
  return regime as RawRegime;
};

// The regime block has no master switch; each behaviour toggles itself. The
// verdict is worth showing only when the daily trend actually drives one of them,
// so the section mirrors the worker's own gates rather than a nonexistent flag.
const regimeActive = (r: RawRegime): boolean =>
  r.exposure?.enabled === true ||
  r.onBear?.exitToCash === true ||
  r.onBear?.blockEntry === true ||
  r.onBear?.suppressPromotion === true ||
  r.onBear?.rearm?.enabled === true ||
  r.onBull?.hold?.enabled === true ||
  r.onBull?.pyramid?.enabled === true ||
  r.onBull?.requireEntry === true;

const posInt = (raw: unknown): number | null =>
  typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;

// The web concatenates every declared candle window into one flat `candles`
// array (the config's own decision interval PLUS the daily regime window), so
// the daily verdict must pick out its own window by each candle's span rather
// than read the whole mix. Every candle carries `closeTimeMs - openTimeMs` = its
// interval span, so a one-day span isolates the regime window; a sub-daily
// decision interval falls away and the drift gate (which passes only the
// decision window) simply yields no daily candles, a harmless empty verdict.
const DAY_MS = 86_400_000;
const dailyWindow = (candles: readonly Candle[] | undefined): readonly Candle[] =>
  (candles ?? []).filter((c) => c.closeTimeMs - c.openTimeMs === DAY_MS);

// Daily-candle depth the regime verdict needs: the MA warm-up (5x period for the
// EMA) or the period + confirmation window, whichever is larger, capped at the
// worker's 500-candle daily ring so the shown counts cannot disagree with the
// worker. `Math` is banned in strategy packages, so clamp with ternaries.
const regimeFrames = (period: number, confirmBars: number): number => {
  const warmup = period * 5;
  const window = period + confirmBars + 5;
  const raw = warmup > window ? warmup : window;
  return raw > 500 ? 500 : raw;
};

/**
 * Regime section: the daily bull/bear verdict, the bull-hold state, and the
 * projected pyramid add-ladder. The verdict reuses the worker's own
 * `classifyRegimeFromDaily`, so the preview cannot disagree with the trade gate
 * at the MA boundary (the old web preview did, counting a close AT the MA as
 * bull). Every row is informational (`trigger` unset): the verdict is not a
 * currentPrice threshold and the add-ladder rungs project a future state rather
 * than a threshold of the current one, so the drift gate skips them.
 */
const projectRegime = (
  config: TTConfig,
  dailyCandles: readonly Candle[],
  currentPrice: string | null,
  anchor: Decimal,
): PreviewRow[] => {
  const regime = readRegime(config);
  if (regime === null || !regimeActive(regime)) return [];
  const period = posInt(regime.period);
  const confirmBars = posInt(regime.confirmBars);
  if (period === null || confirmBars === null) return [];
  const ma = regime.ma === 'ema' ? 'ema' : 'sma';
  const rows: PreviewRow[] = [];

  const closed = dailyCandles.filter((c) => c.isClosed);
  const reading =
    closed.length === 0
      ? null
      : classifyRegimeFromDaily(dailyCandles, currentPrice ?? '', { ma, period, confirmBars });
  let verdict: string;
  if (reading === null) {
    verdict = 'Pick a symbol to check the daily regime';
  } else if (reading.regime === 'bull') {
    verdict = `Bull — last ${confirmBars} daily closes above the ${period}-day ${ma}`;
  } else if (reading.regime === 'bear') {
    verdict = `Bear — last ${confirmBars} daily closes below the ${period}-day ${ma}`;
  } else if (reading.regime === 'neutral') {
    verdict = `Watching — daily closes straddle the ${period}-day ${ma}`;
  } else {
    // A too-short window carries have/need; a malformed close fails safe without
    // them, so default to 0 rather than print `undefined`.
    const have = String(reading.context['have'] ?? 0);
    const need = String(reading.context['need'] ?? 0);
    verdict = `Warming up — ${have}/${need} daily candles`;
  }
  rows.push({ code: 'regime-verdict', label: 'Daily regime', tone: 'neutral', note: verdict });

  const hold = regime.onBull?.hold;
  if (hold !== undefined && hold.enabled === true) {
    const room = typeof hold.room === 'string' ? hold.room : 'normal';
    rows.push({
      code: 'regime-bull-hold',
      label: 'Bull hold',
      tone: 'neutral',
      note: reading?.regime === 'bull' ? `Active now — room: ${room}` : `Idle — room: ${room}`,
    });
  }

  const pyramid = regime.onBull?.pyramid;
  if (pyramid !== undefined && pyramid.enabled === true) {
    const step = decOrNull(pyramid.stepPercentage);
    const maxAdds = posInt(pyramid.maxAdds);
    if (step !== null && step.gt(0) && maxAdds !== null) {
      const mult = new Decimal(1).add(step);
      const offset = step.mul(100).toString();
      let price = anchor;
      for (let i = 1; i <= maxAdds; i += 1) {
        price = price.mul(mult);
        rows.push({
          code: 'regime-pyramid-add',
          label: `Add #${i}`,
          tone: 'buy',
          price: price.toString(),
          note: `+${offset}% each`,
        });
      }
    }
  }
  return rows;
};

/**
 * Project trailing-trade's decision levels for the operator's pre-trade view and
 * the drift gate. Pure, Decimal-only; reads the config DEFENSIVELY (the live
 * worker may pass it unparsed). `entryPrice` is the ladder's rung-0 fill and the
 * sell-side cost basis; with none available (flat, no projection reference) the
 * model is empty.
 */
export const ttPreviewLevels = (input: PreviewInput<TTConfig, TTState>): PreviewModel => {
  const lbp = decOrNull(input.entryPrice);
  if (lbp === null || lbp.lte(0)) return { sections: [] };
  const sections: PreviewSection[] = [];
  const ladder = projectLadder(input.config, lbp);
  if (ladder.length > 0) sections.push({ title: 'Grid ladder', rows: ladder });
  const sells = projectSells(input.config, input.state, lbp);
  if (sells.length > 0) sections.push({ title: 'Sell targets', rows: sells });
  const regime = projectRegime(input.config, dailyWindow(input.candles), input.currentPrice, lbp);
  if (regime.length > 0) sections.push({ title: 'Regime', rows: regime });
  return { sections };
};

/**
 * Trailing-trade's regime verdict reads a daily window regardless of the trading
 * `candleInterval`, so it declares that `1d` history here; the web fetches it and
 * feeds it to `ttPreviewLevels`. Empty when regime is off (no daily rows to show).
 */
export const ttPreviewDataNeeds = (
  config: TTConfig,
): readonly { readonly interval: string; readonly frames: number }[] => {
  const regime = readRegime(config);
  if (regime === null || !regimeActive(regime)) return [];
  const period = posInt(regime.period);
  const confirmBars = posInt(regime.confirmBars);
  if (period === null || confirmBars === null) return [];
  return [{ interval: REGIME_INTERVAL, frames: regimeFrames(period, confirmBars) }];
};
