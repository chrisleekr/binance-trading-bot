// app/cronjob/aiTrader.js
// AI-basert trader for Cross Margin. Dry-run som standard. SL/TP via ATR.
// Indikatorer er inline for å slippe ekstra filer.

require('dotenv').config();
const { slack } = require('../helpers/slack');
const { getMarginAccount } = require('../binance/margin');
const { getKlines, getPrice } = require('../helpers/binanceData');
const store = require('../helpers/positionsStore');
const { placeOrderRouted } = require('../helpers/placeOrderRouted');

// ---------- utils ----------
const num = (v, d = 8) => Number.parseFloat(v).toFixed(d);
const toNum = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// ---------- tekniske indikatorer ----------
function ema(values, period) {
  const k = 2 / (period + 1);
  let emaPrev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = Array(values.length).fill(null);
  out[period - 1] = emaPrev;
  for (let i = period; i < values.length; i++) {
    emaPrev = values[i] * k + emaPrev * (1 - k);
    out[i] = emaPrev;
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = Array(closes.length).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = 100 - (100 / (1 + (avgGain / (avgLoss || 1e-10))));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = 100 - (100 / (1 + (avgGain / (avgLoss || 1e-10))));
  }
  return out;
}

function macdCalc(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    (emaFast[i] != null && emaSlow[i] != null) ? emaFast[i] - emaSlow[i] : null
  );
  // signal på de gyldige MACD-verdiene
  const valid = macdLine.filter(v => v != null);
  const signalLineValid = ema(valid, signal);
  // realign
  let j = 0;
  const signalLine = macdLine.map(v => (v == null ? null : signalLineValid[j++]));
  const hist = macdLine.map((v, i) => (v != null && signalLine[i] != null) ? v - signalLine[i] : null);
  return { macdLine, signalLine, hist };
}

function atr(highs, lows, closes, period = 14) {
  const tr = [null];
  for (let i = 1; i < closes.length; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  const out = Array(closes.length).fill(null);
  out[period] = sum / period;
  for (let i = period + 1; i < tr.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

function crossover(aPrev, aNow, bPrev, bNow) {
  return aPrev != null && bPrev != null && aNow != null && bNow != null && aPrev <= bPrev && aNow > bNow;
}
function crossunder(aPrev, aNow, bPrev, bNow) {
  return aPrev != null && bPrev != null && aNow != null && bNow != null && aPrev >= bPrev && aNow < bNow;
}

// ---------- ordre helper med failsafe ----------
async function safePlaceOrder({ assetOrSymbol, side, qty, symbol, opts = {} }) {
  // Prøv signatur: (asset, side, amount, opts)
  try {
    return await placeOrderRouted(assetOrSymbol, side, qty, Object.assign({ symbol }, opts));
  } catch (e1) {
    // fallback: (symbol, side, amount, opts)
    try {
      return await placeOrderRouted(symbol, side, qty, opts);
    } catch (e2) {
      throw e2;
    }
  }
}

// ---------- hovedjobb ----------
(async () => {
  // Feature-flag
  if (String(process.env.JOBS_AI_TRADER_ENABLED).toLowerCase() !== 'true') {
    console.log('[aiTrader] Disabled');
    return;
  }

  console.log('[aiTrader] Start');

  const dryRun = String(process.env.AI_TRADER_DRY_RUN || 'true').toLowerCase() === 'true';
  const symbols = (process.env.AI_TRADER_SYMBOLS || 'BTCUSDT').split(',').map(s => s.trim());
  const interval = process.env.AI_TRADER_INTERVAL || '15m';
  const lookback = parseInt(process.env.AI_TRADER_LOOKBACK || '500', 10);

  const maxExposurePct = parseFloat(process.env.AI_TRADER_MAX_EXPOSURE_PCT || '0.15');
  const maxOpen = parseInt(process.env.AI_TRADER_MAX_OPEN_POSITIONS || '3', 10);
  const cooldownMin = parseInt(process.env.AI_TRADER_COOLDOWN_MIN || '10', 10);
  const slATR = parseFloat(process.env.AI_TRADER_SL_ATR_MULT || '1.5');
  const tpATR = parseFloat(process.env.AI_TRADER_TP_ATR_MULT || '3');
  const minNotional = parseFloat(process.env.AI_TRADER_MIN_NOTIONAL || '12');
  const maxDailyLossPct = parseFloat(process.env.AI_TRADER_MAX_DAILY_LOSS_PCT || '3');

  // Konto og equity
  const acct = await getMarginAccount();
  const equity =
    toNum(acct.totalNetAsset) ||
    toNum(acct.totalNetAssetOfBtc) ||
    0;

  // Daglig tapsstopp
  const realizedToday = store.getDailyPnl ? store.getDailyPnl() : 0;
  if (equity > 0 && (realizedToday / equity) * 100 <= -maxDailyLossPct) {
    await slack.sendMessage(`(aiTrader) *Handel stoppet i dag* – realisert PnL ${num(realizedToday, 2)} <= -${maxDailyLossPct}% av equity.\nIngen nye handler før i morgen.`);
    console.log('[aiTrader] Daily loss stop hit');
    return;
  }

  const openPositions = store.getAll ? store.getAll().positions || {} : {};
  const nowISO = new Date().toISOString();

  for (const symbol of symbols) {
    try {
      // Hent klines
      const kl = await getKlines(symbol, interval, lookback);
      if (!kl || kl.length < 210) {
        console.log(`[aiTrader] Not enough klines for ${symbol}`);
        continue;
      }

      const closes = kl.map(k => k.close);
      const highs = kl.map(k => k.high);
      const lows = kl.map(k => k.low);

      const i = closes.length - 1;
      const ema50 = ema(closes, 50);
      const ema200 = ema(closes, 200);
      const rsi14 = rsi(closes, 14);
      const mac = macdCalc(closes, 12, 26, 9);
      const atr14 = atr(highs, lows, closes, 14);

      const price = closes[i];
      const uptrend = ema50[i] != null && ema200[i] != null && ema50[i] > ema200[i];
      const downtrend = ema50[i] != null && ema200[i] != null && ema50[i] < ema200[i];
      const macUp = crossover(mac.macdLine[i - 1], mac.macdLine[i], mac.signalLine[i - 1], mac.signalLine[i]);
      const macDn = crossunder(mac.macdLine[i - 1], mac.macdLine[i], mac.signalLine[i - 1], mac.signalLine[i]);
      const rsiOkBuy = rsi14[i] != null && rsi14[i] < 70;
      const rsiOkSell = rsi14[i] != null && rsi14[i] > 30;

      const buySig = uptrend && rsiOkBuy && macUp;
      const sellSig = downtrend && rsiOkSell && macDn;

      const pos = store.getPosition ? store.getPosition(symbol) : openPositions[symbol];
      const atrNow = atr14[i];

      // SL/TP håndtering for eksisterende long
      if (pos && pos.qty > 0) {
        const sl = pos.entry - atrNow * slATR;
        const tp = pos.entry + atrNow * tpATR;

        if (price <= sl || price >= tp) {
          const qty = pos.qty;
          const pnl = (price - pos.entry) * qty;

          if (!dryRun) {
            await safePlaceOrder({
              assetOrSymbol: symbol.replace(/USDT|USDC$/i, ''),
              side: 'SELL',
              qty,
              symbol,
              opts: { autoRepay: true }
            });
          }

          store.removePosition && store.removePosition(symbol);
          store.pushClosed && store.pushClosed({
            symbol, qty, entry: pos.entry, exit: price, pnl,
            openedAtISO: pos.openedAtISO, closedAtISO: nowISO
          });
          store.addRealizedPnl && store.addRealizedPnl(pnl);

          await slack.sendMessage(`(aiTrader) *${price <= sl ? 'STOP-LOSS' : 'TAKE-PROFIT'}* ${symbol}
Pris: ${num(price, 2)}
Qty: ${num(qty, 6)}
Entry: ${num(pos.entry, 2)}
PnL: ${num(pnl, 2)}
Dry-run: ${dryRun}`);

          continue; // neste symbol
        }
      }

      // Nye beslutninger
      if (buySig) {
        if (pos && pos.qty > 0) {
          console.log(`[aiTrader] Already long ${symbol}`);
          continue;
        }
        // cooldown hvis implementert i store
        if (store.canTrade && !store.canTrade(symbol, cooldownMin)) {
          console.log(`[aiTrader] Cooldown ${symbol}`);
          continue;
        }
        // max åpne posisjoner
        const openCount = Object.keys(store.getAll ? store.getAll().positions || {} : {}).length;
        if (openCount >= maxOpen) {
          console.log('[aiTrader] Max open positions reached');
          continue;
        }

        // sizing
        const notional = Math.max(equity * maxExposurePct, minNotional);
        const qty = +(notional / price).toFixed(6);
        if (qty * price < minNotional) {
          console.log('[aiTrader] Below min notional');
          continue;
        }

        if (!dryRun) {
          await safePlaceOrder({
            assetOrSymbol: symbol.replace(/USDT|USDC$/i, ''),
            side: 'BUY',
            qty,
            symbol,
            opts: { autoBorrow: true }
          });
        }

        store.upsertPosition && store.upsertPosition(symbol, {
          qty, entry: price, avgPrice: price,
          openedAtISO: nowISO, lastActionISO: nowISO
        });
        store.touchLastTrade && store.touchLastTrade(symbol);

        const reason = `EMA50 ${num(ema50[i], 2)} > EMA200 ${num(ema200[i], 2)}, RSI ${num(rsi14[i], 2)}, MACD cross up`;
        await slack.sendMessage(`(aiTrader) *KJØP* ${symbol}
Pris: ${num(price, 2)} ATR: ${num(atrNow, 2)}
Qty: ${num(qty, 6)} (≈ ${num(qty * price, 2)} notional)
Begrunnelse: ${reason}
Dry-run: ${dryRun}`);

        continue;
      }

      if (sellSig) {
        // v1: vi shorter ikke. Hvis vi har long, selg for å gå flat.
        if (pos && pos.qty > 0) {
          const qty = pos.qty;
          const pnl = (price - pos.entry) * qty;

          if (!dryRun) {
            await safePlaceOrder({
              assetOrSymbol: symbol.replace(/USDT|USDC$/i, ''),
              side: 'SELL',
              qty,
              symbol,
              opts: { autoRepay: true }
            });
          }

          store.removePosition && store.removePosition(symbol);
          store.pushClosed && store.pushClosed({
            symbol, qty, entry: pos.entry, exit: price, pnl,
            openedAtISO: pos.openedAtISO, closedAtISO: nowISO
          });
          store.addRealizedPnl && store.addRealizedPnl(pnl);

          await slack.sendMessage(`(aiTrader) *SELGER* ${symbol} (trend ned)
Pris: ${num(price, 2)}
Qty: ${num(qty, 6)}
PnL: ${num(pnl, 2)}
Dry-run: ${dryRun}`);
        } else {
          console.log(`[aiTrader] SELL signal, no long position for ${symbol} (no shorts v1)`);
        }
        continue;
      }

      console.log(`[aiTrader] HOLD ${symbol} @ ${num(price, 2)}`);
    } catch (err) {
      console.error('[aiTrader] Error', symbol, err?.response?.data || err.message);
      try {
        await slack.sendMessage(`(aiTrader) *FEIL* ${symbol}: ${err.message}`);
      } catch { }
    }
  }

  console.log('[aiTrader] Done');
})();
