const slack = require('../helpers/slack');
const { getCrossMarginAccount } = require('../exchange/binance');
const { getKlines, getPrice } = require('../helpers/binanceData');
const { buildContext, decide } = require('../helpers/aiDecision');
const store = require('../helpers/positionsStore');
const { placeOrderRouted } = require('../helpers/placeOrderRouted');

function num(v, d = 8) { return Number.parseFloat(v).toFixed(d); }

(async () => {
  if (String(process.env.JOBS_AI_TRADER_ENABLED).toLowerCase() !== 'true') {
    console.log('[aiTrader] Disabled'); return;
  }

  console.log('[aiTrader] Start');
  const dryRun = String(process.env.AI_TRADER_DRY_RUN || 'true').toLowerCase() === 'true';
  const symbols = (process.env.AI_TRADER_SYMBOLS || 'BTCUSDT').split(',').map(s => s.trim());
  const interval = process.env.AI_TRADER_INTERVAL || '15m';
  const lookback = parseInt(process.env.AI_TRADER_LOOKBACK || '400', 10);

  const maxExposurePct = parseFloat(process.env.AI_TRADER_MAX_EXPOSURE_PCT || '0.15');
  const maxOpen = parseInt(process.env.AI_TRADER_MAX_OPEN_POSITIONS || '3', 10);
  const cooldownMin = parseInt(process.env.AI_TRADER_COOLDOWN_MIN || '10', 10);
  const slATR = parseFloat(process.env.AI_TRADER_SL_ATR_MULT || '1.5');
  const tpATR = parseFloat(process.env.AI_TRADER_TP_ATR_MULT || '3');
  const minNotional = parseFloat(process.env.AI_TRADER_MIN_NOTIONAL || '12');
  const maxDailyLossPct = parseFloat(process.env.AI_TRADER_MAX_DAILY_LOSS_PCT || '3');

  // Risk stop: daily realized loss cap
  const account = await getCrossMarginAccount();
  const equity = parseFloat(account.totalNetAsset); // in quote terms (USDT/USDC aggregate)
  const realizedToday = store.getDailyPnl();
  if (equity > 0 && (realizedToday / equity) * 100 <= -maxDailyLossPct) {
    await slack.sendMessage(`(aiTrader) *Handel stoppet i dag* – realisert PnL ${num(realizedToday, 2)} <= -${maxDailyLossPct}% av equity.\nIngen nye handler før i morgen.`);
    console.log('[aiTrader] Daily loss stop hit');
    return;
  }

  const openPositions = store.getAll().positions;
  const openCount = Object.keys(openPositions).length;

  for (const symbol of symbols) {
    try {
      // Manage existing position first (SL/TP)
      const pos = store.getPosition(symbol);
      const kl = await getKlines(symbol, interval, lookback);
      if (kl.length < 210) { console.log(`[aiTrader] Not enough klines for ${symbol}`); continue; }
      const ctx = buildContext(kl);
      const price = ctx.closes[ctx.i];

      if (pos && pos.qty > 0) {
        const sl = pos.entry - ctx.atr14[ctx.i] * slATR;
        const tp = pos.entry + ctx.atr14[ctx.i] * tpATR;
        if (price <= sl) {
          const qty = pos.qty; const proceeds = qty * price; const pnl = (price - pos.entry) * qty;
          if (!dryRun) await placeOrderRouted(symbol.replace(/USDT|USDC$/, ''), 'SELL', qty, { symbol });
          store.removePosition(symbol);
          store.pushClosed({ symbol, qty, entry: pos.entry, exit: price, pnl, openedAtISO: pos.openedAtISO, closedAtISO: new Date().toISOString() });
          store.addRealizedPnl(pnl);
          await slack.sendMessage(`(aiTrader) *STOP-LOSS* ${symbol}\nPris: ${num(price, 2)}\nQty: ${num(qty, 6)}\nEntry: ${num(pos.entry, 2)}\nPnL: ${num(pnl, 2)}\nDry-run: ${dryRun}`);
          continue; // next symbol
        }
        if (price >= tp) {
          const qty = pos.qty; const pnl = (price - pos.entry) * qty;
          if (!dryRun) await placeOrderRouted(symbol.replace(/USDT|USDC$/, ''), 'SELL', qty, { symbol });
          store.removePosition(symbol);
          store.pushClosed({ symbol, qty, entry: pos.entry, exit: price, pnl, openedAtISO: pos.openedAtISO, closedAtISO: new Date().toISOString() });
          store.addRealizedPnl(pnl);
          await slack.sendMessage(`(aiTrader) *TAKE-PROFIT* ${symbol}\nPris: ${num(price, 2)}\nQty: ${num(qty, 6)}\nEntry: ${num(pos.entry, 2)}\nPnL: ${num(pnl, 2)}\nDry-run: ${dryRun}`);
          continue;
        }
      }

      // New decision
      const { action, atr } = decide(ctx);
      const reason = `EMA50 ${num(ctx.ema50[ctx.i], 2)} vs EMA200 ${num(ctx.ema200[ctx.i], 2)}, RSI ${num(ctx.rsi14[ctx.i], 2)}, MACD x-over ${(ctx.mac.macdLine[ctx.i] > ctx.mac.signalLine[ctx.i]) ? 'up' : 'down'}`;

      if (action === 'HOLD') { console.log(`[aiTrader] HOLD ${symbol} @ ${price}`); continue; }

      if (action === 'BUY') {
        if (pos && pos.qty > 0) { console.log(`[aiTrader] Already long ${symbol}`); continue; }
        if (!store.canTrade(symbol, cooldownMin)) { console.log(`[aiTrader] Cooldown ${symbol}`); continue; }
        if (Object.keys(openPositions).length >= maxOpen) { console.log('[aiTrader] Max open positions reached'); continue; }

        // Size: fraction of equity, ensure min notional
        const notional = Math.max(equity * maxExposurePct, minNotional);
        const qty = +(notional / price).toFixed(6);
        if (qty * price < minNotional) { console.log('[aiTrader] Below min notional'); continue; }

        if (!dryRun) await placeOrderRouted(symbol.replace(/USDT|USDC$/, ''), 'BUY', qty, { symbol, autoBorrow: true });
        store.upsertPosition(symbol, { qty, entry: price, avgPrice: price, openedAtISO: new Date().toISOString(), lastActionISO: new Date().toISOString() });
        store.touchLastTrade(symbol);
        await slack.sendMessage(`(aiTrader) *KJØP* ${symbol}\nPris: ${num(price, 2)} ATR: ${num(atr, 2)}\nQty: ${num(qty, 6)} (≈ ${num(qty * price, 2)} notional)\nBegrunnelse: ${reason}\nDry-run: ${dryRun}`);
      }

      if (action === 'SELL') {
        // Flat or shorting? For v1 we only close if long; optional shorting later.
        if (pos && pos.qty > 0) {
          const qty = pos.qty; const pnl = (price - pos.entry) * qty;
          if (!dryRun) await placeOrderRouted(symbol.replace(/USDT|USDC$/, ''), 'SELL', qty, { symbol, autoRepay: true });
          store.removePosition(symbol);
          store.pushClosed({ symbol, qty, entry: pos.entry, exit: price, pnl, openedAtISO: pos.openedAtISO, closedAtISO: new Date().toISOString() });
          store.addRealizedPnl(pnl);
          await slack.sendMessage(`(aiTrader) *SELGER* ${symbol} (trend ned)\nPris: ${num(price, 2)}\nQty: ${num(qty, 6)}\nPnL: ${num(pnl, 2)}\nDry-run: ${dryRun}`);
        } else {
          console.log(`[aiTrader] SELL signal but no long position for ${symbol} — ignoring (no shorts in v1)`);
        }
      }

    } catch (err) {
      console.error('[aiTrader] Error', symbol, err?.response?.data || err.message);
      await slack.sendMessage(`(aiTrader) *FEIL* ${symbol}: ${err.message}`);
    }
  }

  console.log('[aiTrader] Done');
})();
